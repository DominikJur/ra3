// SQLite-backed knowledge base (sqlite-vec dense + in-memory BM25 keyword).
// Indexing is fully local: PDFs are extracted + chunked on this machine and embedded via
// EMBED_BASE_URL (dense + learned-sparse); the query vector comes from the same server at
// search time. There is deliberately NO local vector fallback: only the FlagEmbedding BGE-M3
// build that produced the stored vectors lives on the same embedding manifold, so a different
// build (Xenova/bge-m3 q8, ollama bge-m3, …) must never be mixed in. If the server is
// unreachable, search degrades honestly to keyword-only (BM25).
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { Worker } from 'node:worker_threads';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib';
import { promisify } from 'node:util';
const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBM25Async, bm25Search, type BM25Index } from './lexical.ts';
import { simpleHash } from './shared.ts';

export const KB_ROOT = process.env.KB_ROOT ?? path.join(os.homedir(), 'pi_research', 'books');
export const DB_PATH = path.join(KB_ROOT, 'kb.sqlite');
export const EMBED_BASE_URL = process.env.EMBED_BASE_URL ?? 'http://localhost:8001';
export const DIM = 1024; // bge-m3

export function docDir(slug: string): string {
  return path.join(KB_ROOT, slug);
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS docs (
  slug TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'bge-m3',
  dim INTEGER NOT NULL DEFAULT 1024,
  ocr TEXT NOT NULL DEFAULT 'unknown',
  lang TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc TEXT NOT NULL REFERENCES docs(slug) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(doc, page);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[1024] distance_metric=cosine
);
CREATE TABLE IF NOT EXISTS sparse_terms (
  chunk_id INTEGER NOT NULL,
  term TEXT NOT NULL,
  weight REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sparse_term ON sparse_terms(term);
`;

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(KB_ROOT, { recursive: true });
  db = new DatabaseSync(DB_PATH, { allowExtension: true });
  try {
    sqliteVec.load(db);
  } catch (e) {
    throw new Error(`sqlite-vec failed to load (run: npm i sqlite-vec): ${(e as Error).message}`);
  }
  db.exec(SCHEMA);
  // migration: OCR provenance column for KBs created before it existed
  try { db.exec("ALTER TABLE docs ADD COLUMN ocr TEXT NOT NULL DEFAULT 'unknown'"); } catch { /* already present */ }
  return db;
}

// ---- portable indexing (local extract/chunk + EMBED_BASE_URL embedding) ----

// Batch-embed texts via the embedding server, returning dense (1024) + learned-sparse weights.
// Retry a batch embed a few times: the embed server is reached over an SSH tunnel that can drop
// a kept-alive connection, and a mid-book failure is expensive (the whole indexing job fails).
async function embedBatchWithRetry(batch: string[]): Promise<any> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${EMBED_BASE_URL}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: batch, return_sparse: true }),
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e as Error;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr ?? new Error('embed batch failed');
}

export async function embedTexts(
  texts: string[],
): Promise<{ dense: Float32Array[]; sparse: Map<string, number>[] }> {
  const dense: Float32Array[] = [];
  const sparse: Map<string, number>[] = [];
  const B = 32;
  for (let i = 0; i < texts.length; i += B) {
    const batch = texts.slice(i, i + B);
    const j = await embedBatchWithRetry(batch);
    for (let k = 0; k < batch.length; k++) {
      dense.push(new Float32Array(j.dense[k]));
      const m = new Map<string, number>();
      for (const [t, w] of Object.entries(j.sparse?.[k] ?? {})) m.set(t, w as number);
      sparse.push(m);
    }
  }
  return { dense, sparse };
}

// Insert a fully-indexed doc (chunks + dense + sparse) atomically, replacing any prior copy.
export function ingestChunks(opts: {
  slug: string;
  source: string;
  pages: number;
  chunks: Array<{ page: number; section: string; text: string }>;
  dense: Float32Array[];
  sparse: Map<string, number>[];
  ocr?: string; // 'marker' | 'tesseract' | 'pdfjs' | 'unknown'
}): number {
  const d = getDb();
  const oldIds = (
    d.prepare('SELECT chunk_id FROM chunks WHERE doc = ?').all(opts.slug) as any[]
  ).map((r) => BigInt(r.chunk_id));
  d.exec('BEGIN');
  try {
    if (oldIds.length) {
      const ph = oldIds.map(() => '?').join(',');
      d.prepare(`DELETE FROM vec_chunks WHERE chunk_id IN (${ph})`).run(...oldIds);
      d.prepare(`DELETE FROM sparse_terms WHERE chunk_id IN (${ph})`).run(...oldIds);
    }
    d.prepare('DELETE FROM chunks WHERE doc = ?').run(opts.slug);
    d.prepare('DELETE FROM docs WHERE slug = ?').run(opts.slug);
    d.prepare(
      'INSERT INTO docs (slug, source, pages, chunks, hash, model, dim, lang, ocr) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      opts.slug,
      opts.source,
      opts.pages,
      opts.chunks.length,
      simpleHash(opts.source),
      'bge-m3',
      DIM,
      null,
      opts.ocr ?? 'unknown',
    );
    const ins = d.prepare('INSERT INTO chunks (doc, page, section, text) VALUES (?,?,?,?)');
    const insVec = d.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?,?)');
    const insSp = d.prepare('INSERT INTO sparse_terms (chunk_id, term, weight) VALUES (?,?,?)');
    for (let i = 0; i < opts.chunks.length; i++) {
      const c = opts.chunks[i];
      const r = ins.run(
        opts.slug,
        Number(c.page ?? 0),
        String(c.section ?? ''),
        String(c.text ?? ''),
      );
      const cid = r.lastInsertRowid;
      insVec.run(
        BigInt(cid),
        Buffer.from(opts.dense[i].buffer, opts.dense[i].byteOffset, opts.dense[i].byteLength),
      );
      for (const [term, w] of opts.sparse[i]) insSp.run(Number(cid), term, w);
    }
    d.exec('COMMIT');
    // Fold the WAL back periodically so kb.sqlite-wal doesn't grow unbounded
    // (a 300+ MB stale WAL was seen; the search worker's own connection still
    // works because WAL allows concurrent readers).
    try {
      d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* best effort */
    }
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  invalidateBM25();
  return opts.chunks.length;
}

// ---- search --------------------------------------------------------------

interface BM25Cache {
  index: BM25Index;
  idToChunkId: number[];
  meta: Map<number, { doc: string; page: number; section: string }>;
  count: number;
}
let bm25Cache: BM25Cache | null = null;
let bm25Promise: Promise<BM25Cache> | null = null;
let bm25Count = -1;

function getBM25(d: DatabaseSync): Promise<BM25Cache> {
  const count = Number((d.prepare('SELECT count(*) AS c FROM chunks').get() as any).c);
  if (bm25Promise && bm25Count === count) return bm25Promise;
  bm25Count = count;
  bm25Promise = (async () => {
    if (bm25Cache && bm25Cache.count === count) return bm25Cache;
    const rows = d
      .prepare('SELECT chunk_id, doc, page, section, text FROM chunks ORDER BY chunk_id')
      .all() as any[];
    const idToChunkId = rows.map((r) => Number(r.chunk_id));
    const meta = new Map<number, { doc: string; page: number; section: string }>();
    rows.forEach((r) =>
      meta.set(Number(r.chunk_id), {
        doc: String(r.doc),
        page: Number(r.page),
        section: String(r.section),
      }),
    );
    const index = await buildBM25Async(rows.map((r, i) => ({ id: i, text: String(r.text) })));
    index.chunks = index.chunks.map((c) => ({ id: c.id, text: '' })); // drop text copies; search needs only length/postings
    bm25Cache = { index, idToChunkId, meta, count };
    return bm25Cache;
  })();
  return bm25Promise;
}

function invalidateBM25(): void {
  bm25Cache = null;
  bm25Promise = null;
  bm25Count = -1;
}

export interface QueryEmbed {
  dense: Float32Array | null;
  sparse: Map<string, number>;
}

// Query embedding uses the SAME BGE-M3 build as the indexed docs (FlagEmbedding, served by
// EMBED_BASE_URL). Returns dense (1024) + learned-sparse lexical weights. Retries once with a
// short backoff: the embed server is reached over an SSH tunnel and occasionally drops a
// kept-alive connection, which otherwise surfaces as a spurious "keyword-only" search.
async function embedQuery(text: string): Promise<QueryEmbed> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${EMBED_BASE_URL}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: [text], return_sparse: true }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
      const j = await res.json();
      const dense = new Float32Array(j.dense[0]);
      const sparse = new Map<string, number>();
      for (const [t, w] of Object.entries(j.sparse?.[0] ?? {})) sparse.set(t, w as number);
      return { dense, sparse };
    } catch {
      if (attempt === 1) await new Promise((r) => setTimeout(r, 250));
    }
  }
  // No local vector fallback on purpose: the stored vectors are FlagEmbedding BGE-M3 fp16.
  // Any other build (Xenova q8, ollama bge-m3, …) is a *different embedding manifold*, so its
  // cosine scores against the stored vectors are meaningless: better to drop the dense+sparse
  // legs than to return silently-wrong rankings. BM25 still covers the query.
  return { dense: null, sparse: new Map() };
}

// Learned-sparse retrieval: inner product of query term weights and doc term weights via the
// sparse_terms inverted index.
function sparseSearch(
  d: DatabaseSync,
  qs: Map<string, number>,
  kk: number,
  allowed: (cid: number) => boolean,
): Array<{ id: number; score: number }> {
  const scores = new Map<number, number>();
  for (const [term, qw] of qs) {
    const rows = d
      .prepare('SELECT chunk_id, weight FROM sparse_terms WHERE term = ?')
      .all(term) as any[];
    for (const r of rows) {
      const cid = Number(r.chunk_id);
      if (!allowed(cid)) continue;
      scores.set(cid, (scores.get(cid) ?? 0) + qw * Number(r.weight));
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, kk * 4)
    .map(([id, score]) => ({ id, score }));
}

// Exact dense top-k over vec_chunks (sqlite-vec vec0, float32, cosine distance).
// sqlite-vec caps a KNN probe at k = 4096 ("k value in knn query too large"), so:
//   * loose filters (≈ the whole corpus) use the brute-force MATCH KNN (k ≤ 4096, exact)
//     and then intersect with the filter — the top-4096 window yields far more than kk
//     allowed chunks, so the cap never matters here;
//   * tight filters (a doc, a page range) may not surface kk allowed chunks within the
//     top-4096 window, so the small allowed subset is ranked exactly in JS instead —
//     no cap, and fast because few vectors are touched.
function denseTopK(
  d: DatabaseSync,
  qvec: Float32Array,
  kk: number,
  allowedIds: number[],
  allowedSet: Set<number>,
): Array<{ id: number; score: number }> {
  const total = Number((d.prepare('SELECT count(*) AS c FROM vec_chunks').get() as any).c);
  if (!total || !allowedIds.length) return [];
  const q = Buffer.from(qvec.buffer, qvec.byteOffset, qvec.byteLength);
  const rows = (
    d
      .prepare('SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ?')
      .all(q, Math.min(total, 4096)) as any[]
  ).map((r) => ({
    id: Number(r.chunk_id),
    dist: Number(r.distance),
  }));
  let filtered = rows.filter((r) => allowedSet.has(r.id));

  if (filtered.length < kk) {
    // Tight filter: rank the allowed subset exactly.
    const qn = Math.sqrt(qvec.reduce((s, x) => s + x * x, 0));
    const stmt = d.prepare('SELECT embedding FROM vec_chunks WHERE chunk_id = ?');
    const out: Array<{ id: number; dist: number }> = [];
    for (const cid of allowedIds) {
      try {
        const r = stmt.get(BigInt(cid)) as any;
        if (!r?.embedding) continue;
        const b = Buffer.from(r.embedding);
        const v = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
        let dot = 0,
          na = 0;
        for (let i = 0; i < v.length; i++) {
          dot += v[i] * qvec[i];
          na += v[i] * v[i];
        }
        const nv = Math.sqrt(na);
        out.push({ id: cid, dist: nv && qn ? 1 - dot / (nv * qn) : 1 });
      } catch {
        /* skip */
      }
    }
    out.sort((a, b) => a.dist - b.dist);
    filtered = out.slice(0, kk);
  }
  return filtered.slice(0, kk).map((r) => ({ id: r.id, score: Number((1 - r.dist).toFixed(4)) }));
}

function denseChunkVectors(d: DatabaseSync, ids: number[]): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  const q = d.prepare('SELECT embedding FROM vec_chunks WHERE chunk_id = ?');
  for (const id of ids) {
    try {
      const r = q.get(BigInt(id)) as any;
      if (!r?.embedding) continue;
      const b = Buffer.from(r.embedding);
      out.set(id, new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)));
    } catch {
      /* skip */
    }
  }
  return out;
}

// Maximal marginal relevance over an already-scored candidate list.
// candidates: [id, relevance]; sim(a, b) is a similarity in [0, 1]; lambda weights
// relevance vs diversity (0.7 = mostly relevance, still diverse).
function mmr(
  candidates: Array<[number, number]>,
  k: number,
  sim: (a: number, b: number) => number,
  lambda = 0.7,
): number[] {
  const chosen: number[] = [];
  const pool = candidates.slice();
  while (chosen.length < k && pool.length) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const [id, rel] = pool[i];
      let maxSim = 0;
      for (const c of chosen) {
        const s = sim(id, c);
        if (s > maxSim) maxSim = s;
      }
      const score = lambda * rel - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    chosen.push(pool[best][0]);
    pool.splice(best, 1);
  }
  return chosen;
}

// ---- search worker ---------------------------------------------------------
// The search legs (sqlite-vec KNN, learned-sparse, BM25) are synchronous SQLite calls that
// block pi's event loop: ~0.5 s KNN + ~0.15 s sparse on a 42k-chunk KB, plus ~0.8 s once to
// pull chunks for the BM25 index. Run the whole search in a worker thread so the TUI stays
// responsive; the worker imports runSearchDocuments (below) and does embed + legs + fusion.

const searchWorkerUrl = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'search-worker.mjs',
);

let searchWorker: Worker | null = null;
let searchReqId = 1;
const searchPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function getSearchWorker(): Worker {
  if (searchWorker) return searchWorker;
  const w = new Worker(searchWorkerUrl);
  w.on('message', (msg: any) => {
    const p = searchPending.get(msg?.id);
    if (!p) return;
    searchPending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'search worker failed'));
  });
  w.on('error', (e) => {
    for (const [, p] of searchPending) p.reject(e);
    searchPending.clear();
    searchWorker = null;
  });
  w.on('exit', () => {
    searchWorker = null;
  });
  searchWorker = w;
  return w;
}

function callSearchWorker(type: string, payload: any): Promise<any> {
  const id = searchReqId++;
  return new Promise((resolve, reject) => {
    searchPending.set(id, { resolve, reject });
    getSearchWorker().postMessage({ id, type, ...payload });
  });
}

export async function searchDocuments(
  query: string,
  opts: {
    k?: number;
    docs?: string[];
    keyword?: boolean;
    pageFrom?: number;
    pageTo?: number;
    section?: string;
  } = {},
): Promise<any> {
  return callSearchWorker('search', { query, opts });
}

export async function runSearchDocuments(
  query: string,
  opts: {
    k?: number;
    docs?: string[];
    keyword?: boolean;
    pageFrom?: number;
    pageTo?: number;
    section?: string;
  } = {},
): Promise<any> {
  const d = getDb();
  const kk = Math.min(Math.max(opts.k ?? 10, 1), 20);
  // hybrid by default: dense bge-m3 + BM25 keyword, fused with RRF; keyword:false opts out to dense-only
  const useKeyword = opts.keyword !== false;
  const total = Number((d.prepare('SELECT count(*) AS c FROM chunks').get() as any).c);
  if (total === 0) {
    return {
      results: [],
      total: 0,
      model: '',
      dense: false,
      message: 'Knowledge base is empty: docs may still be queued (see document_status).',
    };
  }

  const allowedSet = opts.docs && opts.docs.length ? new Set(opts.docs) : null;
  const bm = await getBM25(d);
  const allowed = (cid: number): boolean => {
    const m = bm.meta.get(cid);
    if (!m) return false;
    if (allowedSet && !allowedSet.has(m.doc)) return false;
    if (opts.pageFrom != null && m.page < opts.pageFrom) return false;
    if (opts.pageTo != null && m.page > opts.pageTo) return false;
    if (opts.section && !m.section.toLowerCase().includes(opts.section.toLowerCase())) return false;
    return true;
  };

  // query embedding (dense + learned-sparse), same BGE-M3 build as the indexed docs
  const allowedIds: number[] = [];
  for (const cid of bm.meta.keys()) if (allowed(cid)) allowedIds.push(cid);
  const allowedIdSet = new Set(allowedIds);
  const qe = await embedQuery(query);
  let dense: Array<{ id: number; score: number }> = [];
  let denseOk = false;
  if (qe.dense) {
    try {
      dense = denseTopK(d, qe.dense, Math.max(kk * 4, 20), allowedIds, allowedIdSet);
      denseOk = true;
    } catch {
      denseOk = false;
    }
  }
  const sparseLeg = qe.sparse.size ? sparseSearch(d, qe.sparse, kk, allowed) : [];

  const keyword = useKeyword
    ? bm25Search(bm.index, query, Math.max(kk * 4, 20), (lid) => allowed(bm.idToChunkId[lid])).map(
        (r) => ({
          id: bm.idToChunkId[r.id],
          score: r.score,
        }),
      )
    : [];

  if (!denseOk && !useKeyword && !sparseLeg.length) {
    return {
      results: [],
      total,
      model: 'bge-m3',
      dense: false,
      message: 'No embedding available (dense API down and keyword leg disabled).',
    };
  }

  const fused = new Map<number, number>();
  const addRRF = (list: Array<{ id: number; score: number }>) =>
    list.forEach((r, rank) => fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (rank + 60)));
  if (denseOk) addRRF(dense);
  if (useKeyword) addRRF(keyword);
  if (sparseLeg.length) addRRF(sparseLeg);

  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, kk);
  if (!ranked.length) return { results: [], total, model: 'bge-m3', dense: denseOk };

  // ---- dense MMR diversity pass (pure hybrid) ----
  // Re-rank the fused candidates with MMR over dense (bge-m3) cosine similarity
  // so the top-k isn't a pile of near-duplicate chunks. Relevance = normalized
  // RRF score; diversity = cosine(chunk_i, chunk_j).
  let finalIds: number[] = ranked.map(([id]) => id);
  try {
    const poolSize = Math.max(kk * 2, 20);
    const pool = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, poolSize);
    if (pool.length > 1) {
      const vecs = denseChunkVectors(
        d,
        pool.map(([id]) => id),
      );
      if (vecs.size >= 2) {
        const sim = (a: number, b: number): number => {
          const va = vecs.get(a),
            vb = vecs.get(b);
          if (!va || !vb) return 0;
          let dot = 0,
            na = 0,
            nb = 0;
          for (let i = 0; i < va.length; i++) {
            dot += va[i] * vb[i];
            na += va[i] * va[i];
            nb += vb[i] * vb[i];
          }
          return na && nb ? dot / Math.sqrt(na * nb) : 0;
        };
        const maxS = pool[0][1],
          minS = pool[pool.length - 1][1];
        const norm = pool.map(
          ([id, s]) => [id, maxS === minS ? 1 : (s - minS) / (maxS - minS)] as [number, number],
        );
        finalIds = mmr(norm, kk, sim, 0.7);
      }
    }
  } catch {
    /* MMR best-effort; keep plain ranked */
  }

  const ids = finalIds;
  const ph = ids.map(() => '?').join(',');
  const rows = d
    .prepare(`SELECT chunk_id, doc, page, section, text FROM chunks WHERE chunk_id IN (${ph})`)
    .all(...ids) as any[];
  const byId = new Map(rows.map((r) => [Number(r.chunk_id), r]));
  const byScore = new Map([...fused.entries()].map(([id, score]) => [id, score]));
  const results = ids.map((id) => {
    const r = byId.get(id);
    return {
      id,
      doc: r.doc,
      page: Number(r.page),
      section: r.section,
      score: Number((byScore.get(id) ?? 0).toFixed(4)),
      snippet: (r.text ?? '').slice(0, 400),
    };
  });
  const out: any = {
    results,
    total,
    model: 'bge-m3',
    dim: DIM,
    dense: denseOk,
    strength: denseOk && dense.length ? Number(dense[0].score.toFixed(4)) : 0,
  };
  if (!denseOk && useKeyword)
    out.message =
      'Embed server unreachable: dense+sparse legs off (no vector fallback: a different BGE-M3 build would be a mismatched manifold); results are keyword-only (BM25).';
  return out;
}

// ---- status --------------------------------------------------------------

export function listDocuments(): any[] {
  const d = getDb();
  const map = new Map<string, any>();
  for (const doc of d
    .prepare('SELECT slug, source, pages, chunks, model, dim, ocr, created_at FROM docs ORDER BY slug')
    .all() as any[]) {
    map.set(doc.slug, {
      slug: doc.slug,
      source: doc.source,
      pages: Number(doc.pages),
      chunks: Number(doc.chunks),
      model: doc.model,
      dim: Number(doc.dim),
      ocr: doc.ocr ?? 'unknown',
      createdAt: doc.created_at,
      status: 'indexed',
    });
  }
  return [...map.values()];
}

// Full text of one page (chunks concatenated in order). document_search returns short
// snippets; this returns the whole page so exact equations/derivations can be quoted.
export function getPageText(
  slug: string,
  page: number,
): { text: string; chunks: number; section: string } | null {
  const d = getDb();
  const rows = d
    .prepare('SELECT section, text FROM chunks WHERE doc = ? AND page = ? ORDER BY chunk_id')
    .all(slug, Number(page)) as any[];
  if (!rows.length) return null;
  const section = rows[0].section ? String(rows[0].section) : '';
  const text = rows
    .map((r) => String(r.text ?? ''))
    .join('\n\n')
    .trim();
  return { text, chunks: rows.length, section };
}

// ---- export / import ------------------------------------------------------

// Snapshot the whole KB to a single portable SQLite file: lossless: docs + chunks +
// dense (vec_chunks) + learned-sparse (sparse_terms) vectors are copied verbatim, so the
// snapshot re-imports without re-embedding. Optionally gzip (inferred from a .gz extension
// or gzip:true).
export async function exportKb(
  dest: string,
  opts: { gzip?: boolean } = {},
): Promise<{ dest: string; docs: number; chunks: number; bytes: number }> {
  const d = getDb();
  // Fold the WAL into the main file so a plain byte-copy is a complete, self-contained snapshot.
  d.exec('PRAGMA wal_checkpoint(FULL);');
  const docs = Number((d.prepare('SELECT count(*) AS c FROM docs').get() as any).c);
  const chunks = Number((d.prepare('SELECT count(*) AS c FROM chunks').get() as any).c);
  const gz = opts.gzip === true || dest.toLowerCase().endsWith('.gz');
  const out = gz && !dest.toLowerCase().endsWith('.gz') ? `${dest}.gz` : dest;
  if (path.resolve(out) === path.resolve(DB_PATH))
    throw new Error('export destination must differ from the live KB file');
  await fsp.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  if (gz) await fsp.writeFile(out, await gzip(await fsp.readFile(DB_PATH)));
  else await fsp.copyFile(DB_PATH, out);
  const st = await fsp.stat(out);
  return { dest: out, docs, chunks, bytes: st.size };
}

// Copy one doc (chunks + dense + sparse) from a snapshot DB into the live DB, remapping
// chunk ids so they never collide with the live KB's own ids. Async: yields to the event
// loop between sparse batches so a full-KB import (millions of terms) doesn't freeze pi.
async function copyDocFromDb(
  srcDb: DatabaseSync,
  dstDb: DatabaseSync,
  slug: string,
): Promise<void> {
  const doc = srcDb
    .prepare(
      'SELECT slug, source, pages, chunks, hash, model, dim, lang, created_at FROM docs WHERE slug = ?',
    )
    .get(slug) as any;
  if (!doc) throw new Error(`snapshot has no doc '${slug}'`);
  const srcChunks = srcDb
    .prepare('SELECT chunk_id, page, section, text FROM chunks WHERE doc = ? ORDER BY chunk_id')
    .all(slug) as any[];
  if (!srcChunks.length) return;

  const oldIds = (
    dstDb.prepare('SELECT chunk_id FROM chunks WHERE doc = ?').all(slug) as any[]
  ).map((r) => BigInt(r.chunk_id));
  dstDb.exec('BEGIN');
  try {
    if (oldIds.length) {
      const ph = oldIds.map(() => '?').join(',');
      dstDb.prepare(`DELETE FROM vec_chunks WHERE chunk_id IN (${ph})`).run(...oldIds);
      dstDb.prepare(`DELETE FROM sparse_terms WHERE chunk_id IN (${ph})`).run(...oldIds);
    }
    dstDb.prepare('DELETE FROM chunks WHERE doc = ?').run(slug);
    dstDb.prepare('DELETE FROM docs WHERE slug = ?').run(slug);

    dstDb
      .prepare(
        'INSERT INTO docs (slug, source, pages, chunks, hash, model, dim, lang, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        slug,
        String(doc.source ?? slug),
        Number(doc.pages ?? 0),
        Number(doc.chunks ?? srcChunks.length),
        String(doc.hash ?? ''),
        String(doc.model ?? 'bge-m3'),
        Number(doc.dim ?? DIM),
        doc.lang ?? null,
        doc.created_at ? String(doc.created_at) : new Date().toISOString(),
      );

    // chunks → fresh live ids
    const idMap = new Map<number, number>();
    const ins = dstDb.prepare('INSERT INTO chunks (doc, page, section, text) VALUES (?,?,?,?)');
    for (const c of srcChunks) {
      const r = ins.run(slug, Number(c.page ?? 0), String(c.section ?? ''), String(c.text ?? ''));
      idMap.set(Number(c.chunk_id), Number(r.lastInsertRowid));
    }

    // dense (batch-read from snapshot, written under remapped ids)
    const srcIds = srcChunks.map((c) => Number(c.chunk_id));
    const ph = srcIds.map(() => '?').join(',');
    const insVec = dstDb.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?,?)');
    for (const v of srcDb
      .prepare(`SELECT chunk_id, embedding FROM vec_chunks WHERE chunk_id IN (${ph})`)
      .all(...srcIds) as any[]) {
      const nid = idMap.get(Number(v.chunk_id));
      if (nid != null && v.embedding) insVec.run(BigInt(nid), Buffer.from(v.embedding));
    }

    // learned-sparse (batched multi-row INSERT: 3.6M single-row execs is the import bottleneck)
    const spRows = srcDb
      .prepare(`SELECT chunk_id, term, weight FROM sparse_terms WHERE chunk_id IN (${ph})`)
      .all(...srcIds) as any[];
    const B = 500;
    for (let i = 0; i < spRows.length; i += B) {
      const vals: any[] = [];
      const phs: string[] = [];
      for (const row of spRows.slice(i, i + B)) {
        const nid = idMap.get(Number(row.chunk_id));
        if (nid == null) continue;
        phs.push('(?,?,?)');
        vals.push(nid, String(row.term), Number(row.weight));
      }
      if (phs.length)
        dstDb
          .prepare(`INSERT INTO sparse_terms (chunk_id, term, weight) VALUES ${phs.join(',')}`)
          .run(...vals);
      if ((i / B) % 25 === 0) await new Promise((r) => setImmediate(r));
    }

    dstDb.exec('COMMIT');
  } catch (e) {
    dstDb.exec('ROLLBACK');
    throw e;
  }
}

// Import docs from a snapshot produced by exportKb. Vectors are copied verbatim (no
// re-embedding). Merge by default (existing slugs are skipped); replace:true overwrites them.
export async function importKb(
  src: string,
  opts: { replace?: boolean } = {},
): Promise<{ docs: number; chunks: number; skipped: number }> {
  if (!existsSync(src)) throw new Error(`import source not found: ${src}`);
  let tmp: string | null = null;
  let srcDb: DatabaseSync | null = null;
  try {
    if (src.toLowerCase().endsWith('.gz')) {
      tmp = `${src}.unpacked.sqlite`;
      await fsp.writeFile(tmp, await gunzip(await fsp.readFile(src)));
    }
    const srcPath = tmp ?? src;
    if (path.resolve(srcPath) === path.resolve(DB_PATH))
      throw new Error('import source must differ from the live KB file');

    srcDb = new DatabaseSync(srcPath, { allowExtension: true, readOnly: true });
    sqliteVec.load(srcDb);
    for (const t of ['docs', 'chunks', 'vec_chunks', 'sparse_terms']) {
      const r = srcDb
        .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
        .get(t) as any;
      if (!r) throw new Error(`not a KB snapshot (missing ${t})`);
    }

    const d = getDb();
    const srcDocs = srcDb.prepare('SELECT slug, chunks FROM docs ORDER BY slug').all() as any[];
    // Decide what to copy up front so we can skip the index rebuild when nothing changes.
    const todo: Array<{ slug: string; chunks: number }> = [];
    let skipped = 0;
    for (const doc of srcDocs) {
      const slug = String(doc.slug);
      const exists = d.prepare('SELECT 1 FROM docs WHERE slug = ?').get(slug);
      if (exists && !opts.replace) {
        skipped++;
        continue;
      }
      todo.push({ slug, chunks: Number(doc.chunks ?? 0) });
    }
    if (!todo.length) return { docs: 0, chunks: 0, skipped };

    // Bulk-load optimization: drop the sparse index while inserting (index maintenance per
    // row is the dominant cost at ~3.5M terms), then rebuild it once at the end.
    d.exec('DROP INDEX IF EXISTS idx_sparse_term;');
    let docs = 0;
    let chunks = 0;
    try {
      for (const t of todo) {
        await copyDocFromDb(srcDb, d, t.slug);
        docs++;
        chunks += t.chunks;
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      d.exec('CREATE INDEX IF NOT EXISTS idx_sparse_term ON sparse_terms(term);');
      invalidateBM25();
    }
    return { docs, chunks, skipped };
  } finally {
    if (srcDb) srcDb.close();
    if (tmp) rmSync(tmp, { force: true });
  }
}
