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
- Every doc is OCR'd on index by default (`OCR_MODE=always`) so equations are exact; slow but one-time.
- Storage: `~/pi_research/books/<slug>/` (raw PDF) + `kb.sqlite` (docs, chunks, vectors).

## Queue behavior — storms, locks, page numbers (don't fight it)
- **Waiting/retrying is normal.** If a job's progress says "waiting for embed/OCR server" or
  "server dropped mid-job — retrying" (or "re-queued after server drop" after a restart), the
  queue is intentionally waiting out a VPN/tunnel outage. **Do NOT re-submit the same document**
  to "fix" it — that duplicates work (an OCR checkpoint already makes retries resume cheaply).
  It completes on its own as soon as the servers are reachable.
- **Any session can enqueue; jobs run exactly once.** The queue lives in SQLite
  (ra3-queue.sqlite) and jobs are claimed transactionally, so it doesn't matter how many pi
  sessions are open: `document_index` never fails with a lock error, and each job is processed
  by exactly one session (a heartbeat lease requeues work from crashed sessions).
- **Page numbers are PDF page numbers.** KB pages = the PDF's pages (OCR keeps them via
  per-page markers). Exception: `langtangen-fdm` — book page = PDF page − 24.

## Fire-and-forget batch indexing (close the PC)
- **`document_submit({ sources: [paths...] })`** uploads several PDFs to server as ONE async OCR
  job and returns immediately — server keeps OCRing in the background even with this PC off
  (results persist on the server). Each file becomes a KB doc (slug = filename stem).
- **`document_pull({ replace? })`** (or `node server-jobs.mjs pull`) fetches finished jobs and
  ingests them (chunk → embed → KB). Idempotent: run it whenever you're back; jobs still
  running are reported as waiting. `document_status` shows pending remote jobs.
- CLI equivalent: `node server-jobs.mjs <submit|status|pull>`.
