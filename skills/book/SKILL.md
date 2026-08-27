---
name: book
description: Local knowledge base over indexed books and papers. Index PDFs and ask questions answered with page citations.
---

# Book / Document Knowledge Base

1. **Index once**: `document_index({ source })` where `source` is a path, URL, DOI, or arXiv id.
   Async: it queues and returns immediately; the doc is searchable when the job finishes: check
   `document_status`.
2. **Search**: `document_search({ query, k?, docs?, keyword? })` → top-k chunks with `doc`, `page`,
   `section`, `snippet`. Hybrid by default; `keyword: false` for dense-only. LaTeX may have stray
   spaces. Cite returned page numbers.
3. **Read full pages** — `document_page({ doc, page })` returns a page's full text when a search snippet isn't enough (e.g. to quote an exact equation or derivation).
4. **Status**: `document_status()` lists indexed docs + the queue.

## Rules
- Index once, search many times; `reindex: true` only to replace a stale copy.
- Scanned PDFs are auto-OCR'd on index (slow).
- Storage: `~/pi_research/books/<slug>/` (raw PDF) + `kb.sqlite` (docs, chunks, vectors).
