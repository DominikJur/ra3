// PDF extraction with font-aware line grouping, section detection, chunking, and page rendering.
import path from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export interface Line { page: number; text: string; size: number; bold: boolean; }
export interface Section { heading: string; page: number; text: string; }
export interface ChunkSpec { page: number; section: string; text: string; }

function fontsDir(): string | undefined {
  // Resolve pdfjs-dist's `standard_fonts` directory via Node module resolution instead of a
  // hard-coded relative path: this works under both pi's CJS bundler (__filename) and bare
  // node ESM (import.meta.url), and regardless of whether node_modules is hoisted or nested.
  // pdfjs concatenates `standardFontDataUrl + filename` and reads it with fs.readFile in Node,
  // so the baseUrl must be a filesystem path ending in a separator (a file:// URL or a missing
  // trailing slash both break the fetch and emit the "fetchStandardFontData … LiberationSans-
  // Regular.ttf" warning).
  try {
    const base = typeof __filename === "string" ? __filename : import.meta.url;
    const req = createRequire(base);
    const dir = path.join(path.dirname(req.resolve("pdfjs-dist/package.json")), "standard_fonts");
    if (existsSync(path.join(dir, "LiberationSans-Regular.ttf"))) {
      return dir + path.sep;
    }
  } catch { /* ignore: leave standardFontDataUrl undefined */ }
  return undefined;
}

async function loadPdf(buf: Uint8Array): Promise<{ doc: any }> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: buf, disableWorker: true, standardFontDataUrl: fontsDir() }).promise;
  return { doc };
}

function groupLines(items: any[]): { text: string; size: number; bold: boolean; y: number }[] {
  const byY = new Map<number, { y: number; parts: { x: number; w: number; str: string; size: number; bold: boolean }[] }>();
  for (const it of items) {
    if (!it || typeof it.str !== "string" || !it.str) continue;
    const x = it.transform?.[4] ?? 0;
    const y = it.transform?.[5] ?? 0;
    const size = typeof it.height === "number" ? it.height : 0;
    const fontName = String(it.fontName ?? "");
    const bold = /bold|heavy|black|semibold|demi/i.test(fontName);
    const w = typeof it.width === "number" ? it.width : it.str.length * (size || 8) * 0.5;
    const key = Math.round(y);
    let line = byY.get(key);
    if (!line) {
      line = { y, parts: [] };
      byY.set(key, line);
    }
    line.parts.push({ x, w, str: it.str, size, bold });
  }
  const out: { text: string; size: number; bold: boolean; y: number }[] = [];
  for (const l of [...byY.values()].sort((a, b) => b.y - a.y)) {
    const parts = l.parts.sort((a, b) => a.x - b.x);
    let s = "";
    let prevEnd: number | null = null;
    let maxSize = 0;
    let bold = false;
    for (const p of parts) {
      if (prevEnd !== null && p.x - prevEnd > 2) s += " ";
      s += p.str;
      prevEnd = p.x + p.w;
      if (p.size > maxSize) maxSize = p.size;
      if (p.bold) bold = true;
    }
    const text = s.replace(/[ \t]+/g, " ").trim();
    if (text) out.push({ text, size: maxSize, bold, y: l.y });
  }
  return out;
}

export async function extractPdf(
  buf: Uint8Array,
  onPage?: (page: number, total: number) => void,
): Promise<{ fullText: string; sections: Section[]; pageCount: number }> {
  const { doc } = await loadPdf(buf);
  const pageCount = doc.numPages;
  const lines: Line[] = [];
  const pageTexts: string[] = [];
  try {
    for (let p = 1; p <= pageCount; p++) {
      const pg = await doc.getPage(p);
      const tc = await pg.getTextContent();
      const ls = groupLines(tc.items);
      for (const l of ls) lines.push({ page: p, text: l.text, size: l.size, bold: l.bold });
      pageTexts.push(ls.map((l) => l.text).join("\n"));
      if (onPage && (p % 5 === 0 || p === pageCount)) onPage(p, pageCount);
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  const fullText = pageTexts.map((t, i) => `\n\n## Page ${i + 1}\n${t}`).join("\n");
  const sections = detectSections(lines);
  return { fullText, sections, pageCount };
}

export function detectSections(lines: Line[]): Section[] {
  if (!lines.length) return [];
  const counts = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.size * 2) / 2;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let body = 0;
  let best = 0;
  for (const [k, c] of counts) {
    if (c > best) {
      best = c;
      body = k;
    }
  }
  const HEAD_RE = /^(chapter|section|part|appendix|abstract|introduction|conclusion|acknowledg|references|bibliography|table of contents|contents|methods?|results?|discussion|summary|preface|foreword)\b/i;
  const NUM_RE = /^\s*\d+(\.\d+)*\.?\s+\S/;
  const isHeading = (l: Line): boolean => {
    const t = l.text;
    if (!t || t.length > 120) return false;
    if (body > 0 && l.size > 0 && l.size >= body * 1.15) return true;
    if (l.bold && t.length <= 80) return true;
    if (t.length <= 80 && (HEAD_RE.test(t) || NUM_RE.test(t))) return true;
    if (t.length >= 3 && t.length <= 80 && t === t.toUpperCase() && /[A-Z]{3}/.test(t)) return true;
    return false;
  };
  const sections: Section[] = [];
  let cur: { heading: string; page: number; lines: string[] } | null = null;
  for (const l of lines) {
    if (isHeading(l)) {
      if (cur && cur.lines.length) sections.push({ heading: cur.heading, page: cur.page, text: cur.lines.join("\n") });
      cur = { heading: l.text, page: l.page, lines: [] };
    } else if (cur) {
      cur.lines.push(l.text);
    } else {
      cur = { heading: "", page: l.page, lines: [l.text] };
    }
  }
  if (cur && cur.lines.length) sections.push({ heading: cur.heading, page: cur.page, text: cur.lines.join("\n") });
  return sections;
}

// Split text into sentences at sentence terminators, respecting paragraph breaks.
// Uses a lookbehind so the terminator stays attached to its own sentence.
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const t = para.trim();
    if (!t) continue;
    const parts = t.split(/(?<=[.!?;:])\s+(?=[A-Z0-9("])/);
    for (const p of parts) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

// Sentence-aware flat chunking: never cuts mid-sentence/mid-equation. Greedily
// accumulates sentences up to maxLen, emitting a chunk at each boundary.
export function chunkSections(sections: Section[], maxLen = 2000): ChunkSpec[] {
  const chunks: ChunkSpec[] = [];
  for (const sec of sections) {
    const heading = sec.heading || "(preamble)";
    const sentences = splitSentences(sec.text);
    if (sentences.length === 0) continue;
    let cur: string[] = [];
    let curLen = 0;
    const flush = () => {
      if (cur.length === 0) return;
      chunks.push({ page: sec.page, section: heading, text: (sec.heading ? sec.heading + "\n\n" : "") + cur.join(" ") });
      cur = [];
      curLen = 0;
    };
    for (const s of sentences) {
      if (curLen + s.length > maxLen && cur.length > 0) flush();
      cur.push(s);
      curLen += s.length;
    }
    flush();
  }
  return chunks;
}

// Small-to-big (parent-child) chunking. Big units = sentence-aware sections (heading + text,
// capped at maxLen). Small units = sentence clusters (~smallMax chars) that are embedded and
// searched; each carries `parent` = big-unit id so retrieval can expand a hit back to its
// full section context.
export interface BigUnit extends ChunkSpec { id: number; }
export interface SmallUnit extends ChunkSpec { parent: number; }

export function chunkSmallToBig(
  sections: Section[],
  opts: { maxLen?: number; smallMax?: number } = {},
): { bigUnits: BigUnit[]; smallUnits: SmallUnit[] } {
  const maxLen = opts.maxLen ?? 2000;
  const smallMax = opts.smallMax ?? 600;
  const bigUnits: BigUnit[] = [];
  const smallUnits: SmallUnit[] = [];

  for (const sec of sections) {
    const heading = sec.heading || "(preamble)";
    const sentences = splitSentences(sec.text);
    if (sentences.length === 0) continue;

    let cur: string[] = [];
    let curLen = 0;
    const flushBig = () => {
      if (cur.length === 0) return;
      const id = bigUnits.length;
      bigUnits.push({ id, page: sec.page, section: heading, text: (sec.heading ? sec.heading + "\n\n" : "") + cur.join(" ") });
      // Build small units from this big unit's sentences, linked to `id`.
      let sm: string[] = [];
      let smLen = 0;
      const flushSmall = () => {
        if (sm.length === 0) return;
        smallUnits.push({ page: sec.page, section: heading, parent: id, text: sm.join(" ") });
        sm = [];
        smLen = 0;
      };
      for (const s of cur) {
        if (smLen + s.length > smallMax && sm.length > 0) flushSmall();
        sm.push(s);
        smLen += s.length;
      }
      flushSmall();
      cur = [];
      curLen = 0;
    };
    for (const s of sentences) {
      if (curLen + s.length > maxLen && cur.length > 0) flushBig();
      cur.push(s);
      curLen += s.length;
    }
    flushBig();
  }
  return { bigUnits, smallUnits };
}

export async function renderPages(buf: Uint8Array, pages: number[], dpi = 150): Promise<{ page: number; png: Buffer }[]> {
  const { doc } = await loadPdf(buf);
  try {
    const napi: any = await import("@napi-rs/canvas");
    if (napi.Path2D) globalThis.Path2D = napi.Path2D;
    if (napi.DOMMatrix) globalThis.DOMMatrix = napi.DOMMatrix;
    if (napi.ImageData) globalThis.ImageData = napi.ImageData;
    const { createCanvas } = napi;
    const scale = Math.min(Math.max(dpi, 72), 300) / 72;
    const out: { page: number; png: Buffer }[] = [];
    for (const n of pages) {
      const pg = await doc.getPage(n);
      const vp = pg.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const g = canvas.getContext("2d");
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: g, viewport: vp }).promise;
      out.push({ page: n, png: canvas.toBuffer("image/png") });
    }
    return out;
  } finally {
    await doc.destroy().catch(() => {});
  }
}
