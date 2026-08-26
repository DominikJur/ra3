---
name: book
description: Local knowledge base over indexed books and papers. Use to index a PDF, book, or paper and then ask questions answered with page citations.
---

# Book / Document Knowledge Base

## Workflow
1. **Index once** — `document_index({ source })` where `source` is a local path, URL, DOI, or arXiv id.
   Indexing is async (queued to the GPU server); the doc becomes searchable only after it is
   processed — check `document_status`. A book takes minutes, one-time, and persists across sessions.
2. **Search** — `document_search({ query, k?, docs?, keyword? })`. Returns top-k chunks with `doc`,
   `page`, `section`, `snippet`. Hybrid (dense + keyword) by default; pass `keyword: false` for
   dense-only. LaTeX may contain stray spaces — match symbols loosely. Cite returned page numbers.
3. **Read figures/equations** — `pdf_extract({ mode: "render" })`, then `read` the `.png` pages.
4. **Status** — `document_status()` lists what is indexed.

## Rules
- Do **not** re-index the same document; index once, search many times. Use `reindex: true` only to
  replace a stale copy.
- For large books, prefer `document_index({ source, background: true })` so the terminal isn't blocked.
- Restrict a query to one document with `docs: "slug"` (or `"a,b"` for several).
- Scanned (image-only) PDFs are OCR'd automatically on index (slow, flagged in the result).

## Storage
- Per document: `~/pi_research/books/<slug>/` (`paper.pdf`, `paper.txt`, `structure.json`).
- Global index: `~/pi_research/books/.index/` (chunks, vectors, meta).
