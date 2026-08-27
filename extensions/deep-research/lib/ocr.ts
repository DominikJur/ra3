// Optional OCR backend for scanned/image PDFs.
//
// pdfjs (lib/chunk.ts) extracts text natively for text-based PDFs but yields
// almost nothing for scanned pages. When OCR_MODE says so (default: always),
// document_index routes the PDF to a self-hosted OCR server reached via
// OCR_BASE_URL (default http://localhost:8002). Servers ship in server/:
// Marker 2 / Surya 2 (`server/ocr/`, GPU: exact LaTeX math on every page via
// --force_ocr) and Tesseract (`server/ocr-light/`, CPU: plain text only). Both
// implement POST /file_parse -> {results: {<stem>: {md_content}}}; the server
// is responsible for emitting <!-- page N --> markers so the per-page split
// below assigns correct KB page numbers.
//
// OCR_BASE_URL is optional: unset or unreachable → document_index simply
// indexes whatever pdfjs extracted (scanned PDFs will be near-empty).
export interface OcrSection { heading: string; page: number; text: string; }

export function ocrBaseUrl(): string | undefined {
  const u = (process.env.OCR_BASE_URL ?? "http://localhost:8002").trim().replace(/\/+$/, "");
  return u || undefined;
}

// When to run OCR on a document. Settings-driven (env), NOT an agent parameter:
//   "always" (default) — every doc goes through the OCR server (exact math everywhere)
//   "auto"             — only scanned/image PDFs (pdfjs text density below the threshold)
//   "off"              — never OCR
export function ocrMode(): "always" | "auto" | "off" {
  const m = (process.env.OCR_MODE ?? "always").trim().toLowerCase();
  return m === "auto" ? "auto" : m === "off" ? "off" : "always";
}

const MIN_CHARS_PER_PAGE = 40;

// A PDF is "scanned" if pdfjs produced very little text per page (image-only
// pages). Below the threshold we route to OCR.
export function isScannedPdf(sections: { text: string }[], pageCount: number): boolean {
  if (pageCount <= 0) return false;
  const total = sections.reduce((a, s) => a + s.text.length, 0);
  return total / pageCount < MIN_CHARS_PER_PAGE;
}

const PAGE_MARKERS = [
  /<!--\s*page\s*\d+\s*-->/gi,
  /-{5,}\s*page\s*\d+\s*-{5,}/gi,
  /={5,}\s*page\s*\d+\s*={5,}/gi,
  /#{2,}\s*page\s*\d+\s*/gi,
  /\f/gi,
];

function splitPages(md: string): string[] {
  // Find the earliest marker hit and split on it, preserving marker text.
  const hits: { idx: number; len: number }[] = [];
  for (const re of PAGE_MARKERS) {
    for (const m of md.matchAll(re)) hits.push({ idx: m.index ?? 0, len: m[0].length });
  }
  if (!hits.length) return [md];
  hits.sort((a, b) => a.idx - b.idx);
  const pages: string[] = [];
  let start = 0;
  for (const h of hits) {
    if (h.idx > start) pages.push(md.slice(start, h.idx));
    start = h.idx + h.len;
  }
  if (start < md.length) pages.push(md.slice(start));
  return pages.map((p) => p.trim()).filter(Boolean);
}

// Marker/Surya block tree → per-page sections. The server emits <!-- page N -->
// markers (splitPages below); if the markdown has no page markers we fall back
// to markdown headings as section boundaries, else a single section.
export function markdownToSections(md: string): OcrSection[] {
  const pages = splitPages(md);
  if (pages.length > 1) {
    return pages.map((text, i) => ({ heading: `Page ${i + 1}`, page: i + 1, text }));
  }
  // No page markers: split on markdown headings (# / ## / ### ...).
  const sections: OcrSection[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  for (const line of md.split("\n")) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      if (cur && cur.lines.join("\n").trim()) {
        sections.push({ heading: cur.heading, page: 1, text: cur.lines.join("\n").trim() });
      }
      cur = { heading: h[2].trim() || "(section)", lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      cur = { heading: "", lines: [line] };
    }
  }
  if (cur && cur.lines.join("\n").trim()) {
    sections.push({ heading: cur.heading, page: 1, text: cur.lines.join("\n").trim() });
  }
  return sections.length ? sections : [{ heading: "", page: 1, text: md }];
}

export async function ocrPdf(
  buf: Uint8Array,
  baseUrl: string,
  progress?: (msg: string) => void,
): Promise<{ sections: OcrSection[]; pageCount: number }> {
  progress?.("Submitting to OCR server (Marker 2/Surya; this can take a while)...");
  const fd = new FormData();
  fd.append("files", new Blob([buf as unknown as BlobPart], { type: "application/pdf" }), "paper.pdf");
  // Marker 2 (server/ocr/) and Tesseract (server/ocr-light/) both use only the
  // files field; MinerU-specific fields (backend/parse_method/...) are gone.
  const resp = await fetch(`${baseUrl}/file_parse`, {
    method: "POST",
    body: fd,
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OCR request failed: HTTP ${resp.status} ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  // Results are keyed by upload filename stem (e.g. "paper"), not "paper.pdf".
  let md: unknown;
  const results = data?.results;
  if (results && typeof results === "object") {
    const keys = Object.keys(results);
    if (keys.length) md = results[keys[0]]?.md_content;
  }
  if (typeof md !== "string" || !md.trim()) {
    throw new Error("OCR returned no markdown content");
  }
  return { sections: markdownToSections(md), pageCount: sectionsPageGuess(md) };
}

// Best-effort page count from the markdown (used for docs.pages metadata only).
function sectionsPageGuess(md: string): number {
  let max = 0;
  for (const re of PAGE_MARKERS) {
    for (const m of md.matchAll(re)) {
      const n = parseInt(m[0].replace(/\D/g, ""), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return max || 1;
}
