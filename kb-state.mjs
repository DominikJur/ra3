#!/usr/bin/env node
// KB state viewer.
//
//   node kb-state.mjs            list every indexed document with its real title,
//                                embedding model, OCR method and sizes
//   node kb-state.mjs <n>        details for the n-th document in the list
//   node kb-state.mjs <slug>     details for a document by slug
//
// Real titles come from the stored PDF's metadata (pdfjs); fallbacks: the first
// chunk's first line, then the slug. Reads kb.sqlite read-only (no sqlite-vec
// needed for metadata).
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';

const KB_ROOT = process.env.KB_ROOT ?? path.join(os.homedir(), 'pi_research', 'books');
const DB_PATH = path.join(KB_ROOT, 'kb.sqlite');

const db = new DatabaseSync(DB_PATH);
// same migration as the extension: OCR provenance column for pre-2026-08-27 KBs
try {
  db.exec("ALTER TABLE docs ADD COLUMN ocr TEXT NOT NULL DEFAULT 'unknown'");
} catch {
  /* already present */
}

async function pdfTitle(slug) {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const buf = await readFile(path.join(KB_ROOT, slug, 'paper.pdf'));
    const doc = await getDocument({ data: new Uint8Array(buf), disableWorker: true }).promise;
    const meta = await doc.getMetadata();
    await doc.destroy().catch(() => {});
    const t = meta?.info?.Title;
    return typeof t === 'string' && t.trim() ? t.trim().replace(/\s+/g, ' ') : '';
  } catch {
    return '';
  }
}

function chunkTitle(slug) {
  try {
    const rows = db
      .prepare('SELECT text FROM chunks WHERE doc = ? ORDER BY chunk_id LIMIT 1')
      .all(slug);
    const line = (rows[0]?.text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^<!--\s*page\s*\d+\s*-->$/.test(l));
    return line ? line.replace(/^#+\s*/, '').slice(0, 110) : '';
  } catch {
    return '';
  }
}

function loadDocs() {
  return db
    .prepare(
      'SELECT slug, source, pages, chunks, model, dim, ocr, lang, created_at, hash FROM docs ORDER BY slug',
    )
    .all()
    .map((r) => ({
      slug: String(r.slug),
      source: String(r.source ?? ''),
      pages: Number(r.pages ?? 0),
      chunks: Number(r.chunks ?? 0),
      model: String(r.model ?? ''),
      dim: Number(r.dim ?? 0),
      ocr: String(r.ocr ?? 'unknown'),
      lang: r.lang ? String(r.lang) : '',
      createdAt: String(r.created_at ?? ''),
      hash: String(r.hash ?? ''),
    }));
}

function fmtOcr(ocr) {
  const map = { marker: 'marker2/surya', tesseract: 'tesseract', pdfjs: 'none (pdfjs)', ocr: 'ocr server', unknown: 'unknown (pre-2026-08-27)' };
  return map[ocr] ?? ocr;
}

async function main() {
  const arg = process.argv[2];
  const docs = loadDocs();

  // resolve titles (pdfjs metadata; concurrency 6 so the list stays fast)
  const titles = new Map();
  let next = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (next < docs.length) {
      const i = next++;
      const t = await pdfTitle(docs[i].slug);
      titles.set(docs[i].slug, t || chunkTitle(docs[i].slug));
    }
  });
  await Promise.all(workers);

  if (!arg) {
    // list mode
    console.log(`KB: ${docs.length} document(s) | ${db.prepare('SELECT count(*) c FROM chunks').get().c} chunks\n`);
    docs.forEach((d, i) => {
      const title = titles.get(d.slug) || d.slug;
      console.log(
        `${String(i + 1).padStart(3)}. ${title}\n     slug: ${d.slug} | ${d.pages}p | ${d.chunks}ch | embed: ${d.model}${d.dim ? ` (${d.dim}d)` : ''} | ocr: ${fmtOcr(d.ocr)}`,
      );
    });
    return;
  }

  // detail mode: by index or slug
  let doc = null;
  const n = Number(arg);
  if (!Number.isNaN(n) && n >= 1 && n <= docs.length) doc = docs[n - 1];
  else doc = docs.find((d) => d.slug === arg);
  if (!doc) {
    console.error(`no document matches '${arg}' (use a list index or a slug; see 'node kb-state.mjs')`);
    process.exit(1);
  }

  const title = titles.get(doc.slug) || doc.slug;
  const sections = db
    .prepare("SELECT page, section, count(*) c FROM chunks WHERE doc = ? GROUP BY page, section ORDER BY page, c DESC")
    .all(doc.slug);
  const perPage = new Map();
  for (const s of sections) perPage.set(Number(s.page), (perPage.get(Number(s.page)) ?? 0) + Number(s.c));
  const topPages = [...perPage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  console.log(`\n=== ${title} ===`);
  console.log(`slug:        ${doc.slug}`);
  console.log(`source:      ${doc.source || '(unknown)'}`);
  console.log(`pages:       ${doc.pages}`);
  console.log(`chunks:      ${doc.chunks}`);
  console.log(`embedding:   ${doc.model}${doc.dim ? `, ${doc.dim}-dim` : ''}${doc.model === 'bge-m3' ? ' (FlagEmbedding BGE-M3, dense + learned-sparse)' : ''}`);
  console.log(`ocr method:  ${fmtOcr(doc.ocr)}`);
  console.log(`lang:        ${doc.lang || '(auto)'}`);
  console.log(`created:     ${doc.createdAt}`);
  console.log(`hash:        ${doc.hash || ''}`);
  console.log(`chunk spread: ${topPages.map(([p, c]) => `p${p} x${c}`).join(', ')}${perPage.size > topPages.length ? `, +${perPage.size - topPages.length} more pages` : ''}`);
  console.log(`sections:    ${[...new Set(sections.map((s) => s.section).filter(Boolean))].slice(0, 6).join(' | ') || '(none)'}`);
  console.log(`provenance:  ${doc.ocr === 'unknown' ? 'indexed before the OCR provenance column existed (pre-2026-08-27)' : `OCR via ${fmtOcr(doc.ocr)}, embedded with ${doc.model}`}\n`);
}

main().catch((e) => {
  console.error(`kb-state failed: ${e.message}`);
  process.exit(1);
});
