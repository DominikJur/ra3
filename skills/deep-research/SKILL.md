---
name: deep-research
description: Academic deep-research pipeline. Use when asked to research a topic, gather literature, or produce a cited report.
---

# Deep Research

Run a literature-backed research pipeline end-to-end; write the final report to `report.md`.

## 1. Plan
- If `research-plan.md` / `PLAN.md` exists, use it. Else write a short plan: the question, 3–5
  sub-questions, search queries per sub-question, inclusion criteria, report structure.

## 2. Gather
- `academic_graph_search` with several distinct queries. Record title, abstract, year, authors,
  citation count, DOI/arXiv id, open-access link.
- **Queue key papers immediately** with `document_index({ source: "<doi-or-url>" })`: async, so
  queue as you find them, never batch at the end. Re-submitting re-indexes (wasteful for books).
  The queue is shared + exactly-once across pi sessions: any session can queue, jobs run once
  (never re-queue because another session "owns" it — there is no owner).
- Note non-paper leads (repos, datasets, code, tools) with URLs: for *Promising leads*.

## 3. Expand
- `academic_citations` both directions (`citations` = who cites it; `references` = what it cites).

## 4. Deep-read (papers that matter)
- `pdf_extract({ mode: "text" })` to skim the full text. For an indexed paper, `document_page({ doc, page })` returns a page's full text for exact equations. (Text-only: don't try to read rendered PNGs.)
- Prefer DOI/arXiv id over raw URL. Don't queue the same paper twice.

## 5. Synthesize
- Write to `~/pi_research/<YYYY-MM-DD>/<topic-slug>.md`.
- Inline citations (author, year, DOI/URL) on every claim; state only what sources say; flag thin or
  conflicting evidence.
- End with `## Promising leads`: non-paper leads, one line + URL each, flagged *unverified*.

## Mathematics
Real LaTeX in the Markdown (must render on GitHub/VS Code):
- Inline `$...$`, display `$$ ... $$`. Scalars italic; functions/operators upright
  (`\sin \cos \exp \sum \int \lim`); differential `\mathrm{d}`; vectors `\mathbf{v}`; matrices
  `\mathbf{A}`; units upright.
- Use `\frac \sqrt \left(\right) \partial \langle\rangle \bar{} \hat{} ^{\circ}` and proper
  sub/superscripts. Never ASCII pseudo-math (`Z_nm`, `e^(-imα)`, `(1/K) Σ_k`).

## Tools
- `academic_graph_search(query, limit?, yearFrom?, yearTo?)`
- `academic_citations(paperId, direction="citations"|"references", limit?)`
- `unpaywall_resolver(doi)` → `{ is_oa, pdf, ... }`
- `pdf_extract(url?|doi?, mode="text"|"render", pages?, dpi?)`
- `document_index(source, name?, reindex?)` → queue for background indexing (async, exactly-once)
- `document_submit(sources[], name?)` → upload N PDFs to your OCR server as ONE fire-and-forget job (OCR +
  chunk + embed all server-side; close the PC, pull later)
- `document_pull(replace?)` → download finished remote jobs and merge them into the KB
- `document_search(query, k?, docs?, keyword?)` → top-k chunks (keyword=false = dense-only)
- `document_page(doc, page)` → full text of one page (for exact equations/derivations)
- `document_status()` → indexed docs + queue

## Notes
- Semantic Scholar rate limits fall back to Crossref; forward citations need `S2_API_KEY`.
- Unpaywall uses `UNPAYWALL_EMAIL`.
- Extracted files: `.deep-research/papers/<slug>/` (`paper.pdf`, `paper.txt`, `page-NN.png`).
- KB lives in `~/pi_research/books/`; papers indexed in a run stay searchable in later sessions.
