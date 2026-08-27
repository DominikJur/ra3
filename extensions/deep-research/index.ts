// Deep-research tools for Pi:
// academic_graph_search · academic_citations · unpaywall_resolver · pdf_extract
// document_index · document_search · document_status · document_export_kb · document_import_kb
// (local knowledge base)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { promises as fs } from "node:fs";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fetchJson,
  fetchBuffer,
  fetchPdfByDoi,
  slugify,
  s2FetchJson,
  S2_FIELDS,
  compactPaper,
  crossrefPaper,
  toDoi,
  crossrefRefPaper,
  UNPAYWALL_EMAIL,
  type Json,
} from "./lib/shared.ts";
import { extractPdf, renderPages, chunkSections } from "./lib/chunk.ts";
import { embedTexts, ingestChunks, searchDocuments, listDocuments, exportKb, importKb, docDir, getPageText } from "./lib/kb-sqlite.ts";
import { ocrBaseUrl, ocrMode, isScannedPdf, ocrPdf } from "./lib/ocr.ts";

// Render a tool call's input arguments in the TUI. Without a renderCall, pi
// only shows the tool name, so the agent's inputs are invisible to the user.
function renderToolCall(args: unknown, theme: Theme): Component {
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    text = String(args);
  }
  if (text.length > 300) text = `${text.slice(0, 300)}…`;
  return new Text(theme.fg("muted", text), 0, 0);
}


// Error result for tool catch blocks. `details: any` keeps the union assignable to
// AgentToolResult<D> for whatever D the tool declares; success paths stay strictly typed.
function toolError(message: string): { content: { type: "text"; text: string }[]; details: any } {
  return { content: [{ type: "text", text: message }], details: { error: message } };
}

function parsePages(spec: string | undefined, pageCount: number): number[] {
  if (!spec || !spec.trim() || spec.trim().toLowerCase() === "all") {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const p = part.trim();
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.add(n);
    } else {
      const n = parseInt(p, 10);
      if (!Number.isNaN(n)) out.add(n);
    }
  }
  return [...out].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
}

async function resolveSource(source: string): Promise<{ buf: Buffer; slug: string; label: string }> {
  const s = source.trim();
  let buf: Buffer;
  let slug: string;
  if (/^https?:\/\//i.test(s)) {
    buf = await fetchBuffer(s);
    slug = slugify((s.split("/").pop() || "document").replace(/\.pdf$/i, ""));
  } else if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(s) || toDoi(s)) {
    buf = await fetchPdfByDoi(s);
    slug = slugify(s);
  } else {
    const p = path.resolve(s);
    buf = await fs.readFile(p);
    slug = slugify(path.basename(p).replace(/\.pdf$/i, ""));
  }
  return { buf, slug: slug || "document", label: s };
}

async function indexDoc(params: any, progress: (msg: string) => void): Promise<any> {
  progress(`Resolving source: ${params.source}`);
  const src = String(params.source).trim();
  const { buf, slug: derivedSlug } = await resolveSource(src);
  const slug = (params.name ? slugify(params.name) : derivedSlug) || "document";

  // save the PDF so pdf_extract / render can reuse it later
  const dir = docDir(slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "paper.pdf"), buf);

  progress("Extracting text + chunking...");
  let { sections, pageCount } = await extractPdf(new Uint8Array(buf));
  const ocrUrl = ocrBaseUrl();
  const mode = ocrMode();
  const wantOcr = mode === "always" || (mode === "auto" && isScannedPdf(sections, pageCount));
  if (ocrUrl && wantOcr) {
    progress(mode === "always" ? "OCR enabled (OCR_MODE=always): routing to OCR server..." : "Low text density: routing to OCR server...");
    try {
      ({ sections, pageCount } = await ocrPdf(buf, ocrUrl, progress));
      progress(`OCR complete: ${pageCount} pages, ${sections.reduce((a, s) => a + s.text.length, 0)} chars`);
    } catch (e) {
      progress(`OCR failed (${(e as Error).message}): falling back to pdfjs extraction`);
    }
  }
  const chunks = chunkSections(sections, 2000);

  progress(`Embedding ${chunks.length} chunks...`);
  const { dense, sparse } = await embedTexts(chunks.map((c) => c.text));

  progress(`Ingesting ${chunks.length} chunks...`);
  const n = ingestChunks({ slug, source: src, pages: pageCount, chunks, dense, sparse });

  return { slug, source: src, status: "indexed", chunks: n, dir };
}

// ---- background indexing queue --------------------------------------------
// document_index returns immediately; the heavy pipeline (resolve → extract → OCR →
// embed → ingest) runs here, one job at a time, so the TUI stays responsive and several
// books can be queued while the user keeps working. Progress shows in a widget + footer
// status; completion/failure fires a notification.

interface IndexJob {
  id: number;
  label: string;   // display only (name or filename)
  name?: string;   // explicit slug passed through to indexDoc
  source: string;
  reindex: boolean;
  status: "queued" | "processing" | "done" | "error";
  progress: string;
  chunks?: number;
  error?: string;
  queuedAt: number;
}

const jobQueue: IndexJob[] = [];
const jobsById = new Map<number, IndexJob>();
let nextJobId = 1;
let pumping = false;
let sessionCtx: any = null; // stashed in session_start / first tool call

// Queue state persists to ~/.pi/agent/ra3-queue.json so a pi restart resumes queued work
// (an in-memory queue would silently drop books on restart).
const queueFile = path.join(os.homedir(), ".pi", "agent", "ra3-queue.json");
let restored = false;

function persistQueue(): void {
  try {
    const jobs = [...jobsById.values()];
    const active = jobs.filter((j) => j.status === "queued" || j.status === "processing");
    const finished = jobs.filter((j) => j.status === "done" || j.status === "error").slice(-20);
    const toStore = [...active, ...finished];
    mkdirSync(path.dirname(queueFile), { recursive: true });
    const tmp = `${queueFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(toStore, null, 2));
    renameSync(tmp, queueFile);
  } catch { /* persistence is best-effort; never break indexing */ }
}

function restoreQueue(): void {
  if (restored) return;
  restored = true;
  try {
    if (!existsSync(queueFile)) return;
    const jobs = JSON.parse(readFileSync(queueFile, "utf8")) as IndexJob[];
    if (!Array.isArray(jobs)) return;
    for (const j of jobs) {
      if (j.status === "processing") {
        // interrupted by a previous shutdown: retry it
        j.status = "queued";
        j.progress = "queued (resumed after restart)";
      }
      jobsById.set(j.id, j);
      if (j.id >= nextJobId) nextJobId = j.id + 1;
      if (j.status === "queued") jobQueue.push(j);
    }
  } catch { /* ignore corrupt/missing queue file */ }
}

function notify(message: string, level: "info" | "warning" | "error"): void {
  try { sessionCtx?.ui?.notify?.(message, level); } catch { /* no-op in non-TUI modes */ }
}

function refreshQueueUi(): void {
  try {
    if (!sessionCtx?.ui) return;
    const processing = [...jobsById.values()].filter((j) => j.status === "processing");
    const queued = [...jobsById.values()].filter((j) => j.status === "queued");
    const active = [...processing, ...queued];
    if (!active.length) {
      sessionCtx.ui.setWidget?.("ra3-kb", undefined);
      sessionCtx.ui.setStatus?.("ra3-kb", undefined);
      return;
    }
    const lines = active.slice(0, 6).map((j) => `${j.status === "processing" ? "⏳" : "⏱"} ${j.label}: ${j.progress}`);
    if (active.length > 6) lines.push(`… +${active.length - 6} more`);
    sessionCtx.ui.setWidget?.("ra3-kb", lines);
    sessionCtx.ui.setStatus?.("ra3-kb", `indexing ${processing.length} · ${queued.length} queued`);
  } catch { /* ignore UI errors */ }
}

async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (jobQueue.length) {
      const job = jobQueue.shift()!;
      job.status = "processing";
      persistQueue();
      refreshQueueUi();
      try {
        const result = await indexDoc(
          { source: job.source, name: job.name, reindex: job.reindex },
          (msg) => { job.progress = msg; refreshQueueUi(); },
        );
        job.status = "done";
        job.chunks = result.chunks;
        persistQueue();
        notify(`${job.label}: indexed ${result.chunks} chunks: searchable now`, "info");
      } catch (e) {
        job.status = "error";
        job.error = (e as Error).message;
        persistQueue();
        notify(`${job.label}: indexing failed: ${(e as Error).message}`, "error");
      }
      refreshQueueUi();
    }
  } finally {
    pumping = false;
  }
}

function enqueueIndexJob(params: any): IndexJob {
  const src = String(params.source).trim();
  const name = params.name ? String(params.name) : undefined;
  const label = name ?? (src.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || src);
  const job: IndexJob = {
    id: nextJobId++,
    label,
    name,
    source: src,
    reindex: !!params.reindex,
    status: "queued",
    progress: "queued",
    queuedAt: Date.now(),
  };
  jobsById.set(job.id, job);
  jobQueue.push(job);
  persistQueue();
  refreshQueueUi();
  void pumpQueue();
  return job;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx; // stash for background-job notifications + progress UI
    restoreQueue();
    if (jobQueue.length) void pumpQueue();
  });

  // Re-frame pi's default "expert coding assistant" identity: RA³ is an academic research
  // assistant, not a software-engineering tool.
  pi.on("before_agent_start", async (event, _ctx) => {
    const role =
      "You are RA³, an academic research assistant operating inside pi, a coding agent harness. " +
      "You help researchers search, read, cite, and synthesize scholarly books and papers. " +
      "Ground every answer in retrieved sources, cited by page. You write code only as a means to that end.";
    const sys = event.systemPrompt.includes("You are an expert coding assistant")
      ? event.systemPrompt.replace(/You are an expert coding assistant[^.\n]*\./, role)
      : `${role}\n\n${event.systemPrompt}`;
    return { systemPrompt: sys };
  });

  pi.registerTool({
    name: "academic_graph_search",
    label: "Academic Search",
    renderCall: renderToolCall,
    description:
      "Search academic literature via the Semantic Scholar API. Returns papers with title, abstract, year, authors, citation count, DOI/arXiv ids, and open-access PDF links. Falls back to Crossref when Semantic Scholar is rate-limited.",
    promptSnippet: "Search academic papers (Semantic Scholar)",
    promptGuidelines: [
      "Use academic_graph_search to find papers for a research topic; issue several distinct queries to cover different angles.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query, e.g. 'solid-state battery electrolytes'" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 5, max 20)" })),
      yearFrom: Type.Optional(Type.Number({ description: "Filter: earliest publication year" })),
      yearTo: Type.Optional(Type.Number({ description: "Filter: latest publication year" })),
    }),
    async execute(_id: string, params: any, _signal?: AbortSignal) {
      try {
        const limit = Math.min(Math.max(params.limit ?? 5, 1), 20);
        let source = "semantic_scholar";
        let papers: any[];
        let total: number;

        const q = new URLSearchParams();
        q.set("query", params.query);
        q.set("limit", String(limit));
        q.set("fields", S2_FIELDS);
        if (params.yearFrom || params.yearTo) q.set("year", `${params.yearFrom ?? ""}-${params.yearTo ?? ""}`);

        try {
          const data = await s2FetchJson(
            `https://api.semanticscholar.org/graph/v1/paper/search?${q.toString()}`,
            _signal,
            2,
          );
          papers = (data.data ?? []).map(compactPaper);
          total = data.total ?? papers.length;
        } catch {
          const cq = new URLSearchParams();
          cq.set("query", params.query);
          cq.set("rows", String(limit));
          cq.set("select", "DOI,title,abstract,author,issued,is-referenced-by-count,container-title,URL");
          cq.set("mailto", UNPAYWALL_EMAIL);
          const cr = await fetchJson(`https://api.crossref.org/works?${cq.toString()}`, {}, _signal, 2);
          papers = (cr.message?.items ?? []).map(crossrefPaper);
          total = cr.message?.["total-results"] ?? papers.length;
          source = "crossref";
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ source, total, papers }, null, 2) }],
          details: { papers },
        };
      } catch (e) {
        return toolError(`academic_graph_search failed: ${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "academic_citations",
    label: "Citation Graph",
    renderCall: renderToolCall,
    description:
      "Traverse the citation graph for one paper. Gets papers that cite it (direction='citations') or that it references (direction='references'). paperId can be a Semantic Scholar id, 'DOI:10.x/y', 'arXiv:1234.5678', or 'CorpusId:n'. Backward references fall back to Crossref when Semantic Scholar is unavailable (no key needed).",
    promptSnippet: "Get citing/referenced papers",
    promptGuidelines: [
      "Use academic_citations to expand the literature set around key papers, both forward (who cites it) and backward (what it cites).",
    ],
    parameters: Type.Object({
      paperId: Type.String({ description: "Paper identifier: S2 id, DOI:..., arXiv:..., or CorpusId:..." }),
      direction: Type.Optional(
        Type.String({ description: "'citations' (papers citing this one, default) or 'references' (papers this one cites)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)" })),
    }),
    async execute(_id: string, params: any, _signal?: AbortSignal) {
      try {
        const direction = params.direction === "references" ? "references" : "citations";
        const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
        let source = "semantic_scholar";
        let papers: any[];
        try {
          const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(params.paperId)}/${direction}?limit=${limit}&fields=${S2_FIELDS}`;
          const data = await s2FetchJson(url, _signal, 2);
          papers = (data.data ?? []).map((c: any) => compactPaper(c.citingPaper ?? c.citedPaper ?? c));
        } catch {
          const doi = toDoi(params.paperId);
          if (direction === "references" && doi) {
            const cr = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {}, _signal, 2);
            papers = (cr.message?.reference ?? []).slice(0, limit).map(crossrefRefPaper);
            source = "crossref";
          } else {
            throw new Error(
              direction === "citations"
                ? "Semantic Scholar is unavailable and forward citations have no keyless fallback. Set S2_API_KEY."
                : "Semantic Scholar is unavailable and no DOI was provided for the Crossref fallback.",
            );
          }
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ source, direction, papers }, null, 2) }],
          details: { papers },
        };
      } catch (e) {
        return toolError(`academic_citations failed: ${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "unpaywall_resolver",
    label: "Unpaywall Resolver",
    renderCall: renderToolCall,
    description: "Resolve a DOI to an open-access full-text PDF link using the Unpaywall API.",
    promptSnippet: "Resolve DOI to open-access PDF",
    parameters: Type.Object({
      doi: Type.String({ description: "DOI, e.g. '10.1038/nature12373'" }),
    }),
    async execute(_id: string, params: any, _signal?: AbortSignal) {
      try {
        const doi = params.doi.trim().replace(/^https?:\/\/doi\.org\//i, "");
        const data = await fetchJson(
          `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`,
          {},
          _signal,
        );
        const out = {
          doi: data.doi,
          is_oa: data.is_oa,
          oa_status: data.oa_status,
          title: data.title ?? null,
          year: data.year ?? null,
          pdf: data.best_oa_location?.url_for_pdf ?? data.best_oa_location?.url ?? null,
        };
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: out };
      } catch (e) {
        return toolError(`unpaywall_resolver failed: ${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "pdf_extract",
    label: "PDF Extract",
    renderCall: renderToolCall,
    description:
      "Download a paper PDF (by URL or DOI) and extract text, and optionally render pages to PNG for visual reading. mode='text' returns a text file + preview (skimming). mode='render' also renders pages to PNG at the given dpi so you can read two-column layout, figures, tables, and equations by calling 'read' on the .png files. Files are written under .deep-research/papers/<slug>/.",
    promptSnippet: "Download and extract a paper PDF (text and/or page images)",
    promptGuidelines: [
      "Use pdf_extract mode='text' to skim a paper cheaply; use mode='render' and then read the .png page images when you need figures, tables, equations, or exact layout.",
      "Prefer reading rendered .png pages with the read tool when the model is multimodal, since two-column text extraction order is unreliable.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Direct PDF URL (https://...pdf) or a local file path (e.g. C:/.../paper.pdf). Takes precedence over doi." })),
      doi: Type.Optional(Type.String({ description: "DOI or arXiv id; resolved to an open-access PDF automatically." })),
      mode: Type.Optional(Type.String({ description: "'text' (default) or 'render'" })),
      pages: Type.Optional(Type.String({ description: "Pages to render, e.g. '1-5' or '1,3,7'. Default: first 8 pages. Max 30 rendered pages." })),
      dpi: Type.Optional(Type.Number({ description: "Render resolution (default 150, max 300)" })),
    }),
    async execute(_id: string, params: any, _signal?: AbortSignal, onUpdate?: any, ctx?: any) {
      const mode = params.mode === "render" ? "render" : "text";
      try {
        let pdfUrl: string | null = params.url ?? null;
        let slug = "";
        let buf: Buffer;
        if (params.doi && !pdfUrl) {
          slug = slugify(params.doi);
          onUpdate?.({ content: [{ type: "text", text: `Resolving DOI ${params.doi}...` }] });
          buf = await fetchPdfByDoi(params.doi, _signal);
        } else if (pdfUrl) {
          const isHttp = /^https?:\/\//i.test(pdfUrl);
          if (isHttp) {
            slug = slugify(params.url ?? "paper");
            onUpdate?.({ content: [{ type: "text", text: `Downloading ${pdfUrl} ...` }] });
            buf = await fetchBuffer(pdfUrl, _signal);
            if (buf.length < 1024) throw new Error("Downloaded file is suspiciously small: probably not a PDF.");
          } else {
            slug = slugify(path.basename(pdfUrl).replace(/\.pdf$/i, "")) || "paper";
            onUpdate?.({ content: [{ type: "text", text: `Reading local PDF ${pdfUrl} ...` }] });
            buf = await fs.readFile(path.resolve(pdfUrl));
          }
        } else {
          return toolError("pdf_extract: provide a PDF url (http or local path), or a doi that resolves to an open-access PDF (try unpaywall_resolver first).");
        }

        const dir = path.join(ctx?.cwd ?? process.cwd(), ".deep-research", "papers", slug);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "paper.pdf"), buf);

        onUpdate?.({ content: [{ type: "text", text: "Parsing PDF..." }] });
        const u8 = new Uint8Array(buf);
        const { fullText, pageCount } = await extractPdf(u8);
        await fs.writeFile(path.join(dir, "paper.txt"), fullText);

        const result: any = {
          dir,
          pdf: path.join(dir, "paper.pdf"),
          textFile: path.join(dir, "paper.txt"),
          pageCount,
          textPreview: fullText.slice(0, 4000),
        };

        if (mode === "render") {
          onUpdate?.({ content: [{ type: "text", text: "Rendering pages..." }] });
          const dpi = Math.min(Math.max(params.dpi ?? 150, 72), 300);
          let pages = parsePages(params.pages, pageCount);
          if (!params.pages) pages = pages.slice(0, 8);
          const MAXPAGES = 30;
          if (pages.length > MAXPAGES) {
            pages = pages.slice(0, MAXPAGES);
            result.renderTruncated = true;
          }
          const rendered = await renderPages(u8, pages, dpi);
          const outPages = [];
          for (const r of rendered) {
            const name = `page-${String(r.page).padStart(2, "0")}.png`;
            await fs.writeFile(path.join(dir, name), r.png);
            outPages.push({ page: r.page, png: path.join(dir, name) });
          }
          result.pages = outPages;
          result.hint = "To read figures/tables/equations, call the 'read' tool on the .png files listed in 'pages'.";
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      } catch (e) {
        return toolError(`pdf_extract failed: ${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "document_index",
    label: "Index Document",
    renderCall: renderToolCall,
    description:
      "Index a PDF (path, URL, DOI, or arXiv id) into the knowledge base. Runs in the background: queues the job and returns immediately; searchable when it finishes. Every PDF routes to the OCR server (OCR_MODE=always by default) for exact math; set OCR_MODE=auto/off via env to change.",
    promptSnippet: "Index a PDF into the knowledge base (background)",
    promptGuidelines: [
      "Asynchronous: queues and returns immediately. Watch document_status for progress.",
      "Queue papers as soon as you find them (don't batch at the end).",
      "OCR runs on every document by default (settings-driven via OCR_MODE env); no per-call OCR flag.",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "Local path, https URL, DOI, or arXiv id of the PDF." }),
      name: Type.Optional(Type.String({ description: "Optional slug/name for the document (defaults to filename/DOI)." })),
      reindex: Type.Optional(Type.Boolean({ description: "Replace any existing chunks for this document (default false)." })),
    }),
    async execute(_id: string, params: any, _signal?: AbortSignal, _onUpdate?: any, ctx?: any) {
      try {
        if (ctx) sessionCtx = ctx;
        const job = enqueueIndexJob(params);
        const result = {
          status: "queued",
          job_id: job.id,
          label: job.label,
          note: "Indexing runs in the background, you can keep working and queue more documents. Track progress with document_status; a notification fires when the job finishes.",
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      } catch (e) {
        return toolError(`document_index failed: ${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "document_search",
    label: "Search Knowledge Base",
    renderCall: renderToolCall,
    description:
      "Hybrid (dense + keyword) search over the local knowledge base. Returns top-k chunks with doc, page, section, snippet.",
    promptSnippet: "Search the knowledge base (hybrid dense+keyword)",
    promptGuidelines: [
      "Hybrid (dense + keyword) is the default; pass keyword=false for dense-only.",
      "LaTeX in chunks may have stray spaces (x ^ { p }, \\int _ { a }); match symbols loosely.",
      "k defaults to 10 and is cheap: cite returned page numbers and read those pages for detail.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language or keyword query." }),
      k: Type.Optional(Type.Number({ description: "Number of results (default 10, max 20)." })),
      docs: Type.Optional(Type.String({ description: "Optional comma-separated document slugs to restrict the search." })),
      keyword: Type.Optional(Type.Boolean({ description: "Keyword leg is on by default (hybrid). Pass false for dense-only. Exact symbols/DOIs are matched by the keyword leg." })),
      pageFrom: Type.Optional(Type.Number({ description: "Optional minimum page number (inclusive) to restrict results." })),
      pageTo: Type.Optional(Type.Number({ description: "Optional maximum page number (inclusive) to restrict results." })),
      section: Type.Optional(Type.String({ description: "Optional section-heading substring to restrict results." })),
    }),
    async execute(_id: string, params: any) {
      try {
        const docs = params.docs
          ? String(params.docs).split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
        const res = await searchDocuments(params.query, {
          k: params.k,
          docs,
          keyword: params.keyword,
          pageFrom: params.pageFrom,
          pageTo: params.pageTo,
          section: params.section,
        });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], details: res };
      } catch (e) {
        return toolError(`document_search failed: ${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "document_status",
    label: "Knowledge Base Status",
    renderCall: renderToolCall,
    description: "List indexed documents plus any background indexing jobs (queued / processing / recently finished).",
    promptSnippet: "List indexed documents + indexing queue",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any, _signal?: AbortSignal, _onUpdate?: any, ctx?: any) {
      try {
        if (ctx) sessionCtx = ctx;
        const docs = await listDocuments();
        const queue = [...jobsById.values()]
          .filter((j) => j.status === "queued" || j.status === "processing")
          .map((j) => ({ job_id: j.id, label: j.label, source: j.source, status: j.status, progress: j.progress }));
        const recent = [...jobsById.values()]
          .filter((j) => j.status === "done" || j.status === "error")
          .slice(-5)
          .map((j) => ({ job_id: j.id, label: j.label, status: j.status, chunks: j.chunks, error: j.error }));
        const payload = { docs, queue, recent };
        const head = [
          `${docs.length} indexed document(s)`,
          queue.length ? `${queue.length} job(s) in the background queue` : "No indexing jobs in queue",
        ].join("\n");
        return {
          content: [{ type: "text", text: `${head}\n${JSON.stringify(payload, null, 2)}` }],
          details: payload,
        };
      } catch (e) {
        return toolError(`document_status failed: ${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "document_page",
    label: "Read KB Page",
    renderCall: renderToolCall,
    description:
      "Return the full text of one page of an indexed document, by slug + page number. document_search returns short snippets only; use this when you need the exact equation, derivation, or full paragraph on a page.",
    promptSnippet: "Read a full page of an indexed document",
    promptGuidelines: [
      "Use document_page when a document_search snippet isn't enough (exact formula or derivation needed). Pass the slug + page number from document_search.",
      "Page numbers are the KB/PDF page number, which may be offset from the book's printed page numbers.",
    ],
    parameters: Type.Object({
      doc: Type.String({ description: "Document slug (from document_search / document_status)." }),
      page: Type.Number({ description: "Page number as stored in the KB." }),
    }),
    async execute(_id: string, params: any) {
      try {
        const page = getPageText(String(params.doc), Number(params.page));
        if (!page) return toolError(`document_page: no chunks for doc '${params.doc}' page ${params.page}.`);
        const result = { doc: params.doc, page: Number(params.page), section: page.section, text: page.text };
        return { content: [{ type: "text", text: page.text }], details: result };
      } catch (e) {
        return toolError(`document_page failed: ${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "document_export_kb",
    label: "Export Knowledge Base",
    renderCall: renderToolCall,
    description:
      "Export the knowledge base to a portable single-file SQLite snapshot (optionally gzipped). Lossless: docs, chunks, and vectors are copied verbatim, so it re-imports without re-embedding.",
    promptSnippet: "Export the knowledge base to a portable .sqlite file",
    promptGuidelines: [
      "Append .gz (or gzip=true) to compress; document_import_kb auto-detects .gz.",
    ],
    parameters: Type.Object({
      dest: Type.String({ description: "Destination file path (e.g. C:/Users/you/kb-export.sqlite or .../kb-export.sqlite.gz)." }),
      gzip: Type.Optional(Type.Boolean({ description: "Gzip the snapshot (default: infer from a .gz extension)." })),
    }),
    async execute(_id: string, params: any) {
      try {
        const result = exportKb(String(params.dest), { gzip: params.gzip });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      } catch (e) {
        return toolError(`document_export_kb failed: ${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "document_import_kb",
    label: "Import Knowledge Base",
    renderCall: renderToolCall,
    description:
      "Import documents from a KB snapshot (from document_export_kb) into the live knowledge base. Merges by default; replace=true overwrites. Vectors are copied verbatim: no re-embedding.",
    promptSnippet: "Import a KB snapshot (.sqlite or .sqlite.gz)",
    promptGuidelines: [
      "Merges by default; replace=true overwrites existing docs.",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "Path to a KB snapshot file (.sqlite or .sqlite.gz)." }),
      replace: Type.Optional(Type.Boolean({ description: "Overwrite docs that already exist (default: skip them)." })),
    }),
    async execute(_id: string, params: any) {
      try {
        const result = importKb(String(params.source), { replace: params.replace });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      } catch (e) {
        return toolError(`document_import_kb failed: ${(e as Error).message}`);
      }
    },
  });
}
