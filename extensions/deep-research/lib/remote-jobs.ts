// Fire-and-forget remote batch indexing: upload PDFs to the server OCR server as
// ONE multi-file async job, close the PC — server keeps OCRing (results persist
// under ~/.ocr-jobs/) — and pull the finished markdown back whenever you return.
// The pull chunks locally, embeds via EMBED_BASE_URL and ingests into kb.sqlite,
// so the only requirement on the returning side is the short embed/tunnel calls
// (storm-tolerant: retries with backoff).
//
// Pending jobs are tracked in ~/.pi/agent/ra3-pending-jobs.json so the pull can
// be run days later from any machine with the KB + repo.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ocrBaseUrl, markdownToSections } from './ocr.ts';
import { chunkSections } from './chunk.ts';
import { embedTexts, ingestChunks, listDocuments } from './kb-sqlite.ts';
import { slugify } from './shared.ts';

const PENDING_FILE = path.join(os.homedir(), '.pi', 'agent', 'ra3-pending-jobs.json');
const MAX_ATTEMPTS = 8;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PendingFile {
  stem: string; // server-side result key (= sanitized filename stem)
  name: string; // original filename
  slug: string; // KB slug the result will be ingested under
  source: string; // original local path (recorded as docs.source)
}
export interface PendingJob {
  job_id: string;
  createdAt: number;
  files: PendingFile[];
  pulled?: boolean;
}

export async function readPendingJobs(): Promise<PendingJob[]> {
  try {
    const jobs = JSON.parse(await fs.readFile(PENDING_FILE, 'utf8')) as PendingJob[];
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

async function writePendingJobs(jobs: PendingJob[]): Promise<void> {
  await fs.mkdir(path.dirname(PENDING_FILE), { recursive: true });
  await fs.writeFile(PENDING_FILE, JSON.stringify(jobs, null, 2));
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = MAX_ATTEMPTS): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e as Error;
      if (i < attempts) await sleep(15_000 * i);
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

// Upload one or more PDFs as a single server job; record it as pending.
export async function submitRemoteJob(
  sources: string[],
  opts: { name?: string } = {},
): Promise<{ job_id: string; files: PendingFile[]; pending: PendingJob[] }> {
  const base = ocrBaseUrl();
  if (!base) throw new Error('OCR_BASE_URL is not set (remote submit needs the OCR server)');
  if (!sources.length) throw new Error('submit needs at least one PDF path');

  const fd = new FormData();
  const files: PendingFile[] = [];
  for (const src of sources) {
    const buf = await fs.readFile(src);
    const name = path.basename(src);
    const stem = name.replace(/\.pdf$/i, '') || 'doc';
    const slug = opts.name ? slugify(opts.name) : slugify(stem);
    files.push({ stem, name, slug, source: src });
    fd.append('files', new Blob([buf as unknown as BlobPart], { type: 'application/pdf' }), name);
  }

  const resp = await fetchWithRetry(`${base}/jobs`, {
    method: 'POST',
    body: fd,
    signal: AbortSignal.timeout(600_000), // big multi-PDF uploads over a slow tunnel
  });
  if (!resp.ok) {
    throw new Error(`remote submit failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
  }
  const data = await resp.json();
  const pending = await readPendingJobs();
  const entry: PendingJob = { job_id: String(data.job_id), createdAt: Date.now(), files };
  pending.push(entry);
  await writePendingJobs(pending);
  return { job_id: entry.job_id, files, pending };
}

export async function remoteJobStatus(job_id: string): Promise<any> {
  const base = ocrBaseUrl();
  if (!base) return { status: 'unknown', error: 'no OCR_BASE_URL' };
  const resp = await fetchWithRetry(`${base}/jobs/${job_id}`, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`job status failed: HTTP ${resp.status}`);
  return resp.json();
}

// Fetch every finished pending job and ingest it into the KB. Idempotent:
// already-pulled jobs and already-indexed slugs are skipped unless replace.
export async function pullFinishedJobs(opts: { replace?: boolean } = {}): Promise<{
  pulled: string[];
  waiting: string[];
  failed: { job_id: string; error: string }[];
}> {
  const base = ocrBaseUrl();
  if (!base) throw new Error('OCR_BASE_URL is not set (pull needs the OCR server)');
  const pending = await readPendingJobs();
  const existing = new Set(listDocuments().map((d) => d.slug));
  const pulled: string[] = [];
  const waiting: string[] = [];
  const failed: { job_id: string; error: string }[] = [];

  for (const job of pending) {
    if (job.pulled) continue;
    let st: any = null;
    try {
      st = await remoteJobStatus(job.job_id);
    } catch (e) {
      failed.push({ job_id: job.job_id, error: (e as Error).message });
      continue;
    }
    if (st.status === 'queued' || st.status === 'processing') {
      waiting.push(`${job.job_id} (${st.progress ?? 'queued'})`);
      continue;
    }
    if (st.status === 'error') {
      failed.push({ job_id: job.job_id, error: st.error ?? 'job error' });
      continue;
    }
    if (st.status !== 'done') {
      waiting.push(`${job.job_id} (${st.status})`);
      continue;
    }

    const results = st.results ?? {};
    for (const f of job.files) {
      const md = results[f.stem]?.md_content;
      if (typeof md !== 'string' || !md.trim()) {
        failed.push({ job_id: job.job_id, error: `no OCR result for ${f.stem}` });
        continue;
      }
      if (existing.has(f.slug) && !opts.replace) {
        pulled.push(`${f.slug} (already indexed, skipped)`);
        continue;
      }
      const sections = markdownToSections(md);
      const pageCount = sections.reduce((m, s) => Math.max(m, s.page), 1) || 1;
      const chunks = chunkSections(sections, 2000);
      const { dense, sparse } = await embedTexts(chunks.map((c) => c.text));
      ingestChunks({
        slug: f.slug,
        source: f.source,
        pages: pageCount,
        chunks,
        dense,
        sparse,
        ocr: 'marker',
      });
      existing.add(f.slug);
      pulled.push(`${f.slug} (${chunks.length} chunks, ${pageCount}p)`);
    }
    job.pulled = true;
  }

  await writePendingJobs(pending);
  return { pulled, waiting, failed };
}
