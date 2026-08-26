---
name: deep-research
description: Academic deep-research pipeline. Use when the user asks to research a topic, gather literature, or produce a cited report. Coordinates planning, Semantic Scholar search, citation traversal, Unpaywall DOI resolution, and PDF extraction (text + page images).
---

# Deep Research

Run a literature-backed research pipeline end-to-end. Work in these phases and write the final report to `report.md`.

## 1. Plan
- If `research-plan.md` or `PLAN.md` already exists in the working directory, read it first and use it as the plan.
- Otherwise, produce a short plan first: the research question, 3–5 sub-questions, candidate search queries per sub-question, source inclusion criteria, and the structure of the final report. You may use `/plan` (plan mode) for this, but a concise inline plan is enough.

## 2. Gather
- Call `academic_graph_search` with several **distinct** queries (different phrasings/angles). Record title, abstract, year, authors, citation count, DOI/arXiv id, and open-access PDF link for each result.
- **Index key papers immediately.** The moment a result looks relevant, call `document_index({ source: "<doi-or-url>" })` to index it into the knowledge base (extract → embed → ingest). Indexing is synchronous — the paper is searchable the moment the call returns — so index early rather than batching at the end. `document_index` is idempotent (re-submitting the same source is harmless; pass `reindex: true` to replace a previous copy).
- Note non-paper leads as they surface — GitHub repositories, datasets, code, tools, demos — with URLs; they feed the report's *Promising leads* section.

## 3. Expand
- For the most relevant papers, call `academic_citations` in both directions (`direction="citations"` = who cites it; `direction="references"` = what it cites) to find related work.

## 4. Deep-read
For papers that actually matter:
- `pdf_extract` with `mode="text"` to skim the full text cheaply.
- `pdf_extract` with `mode="render"` to produce page PNGs, then call the `read` tool on the `.png` files to read figures, tables, and equations. Rendered pages preserve two-column layout exactly, which plain text extraction does not.
- Prefer `doi` (or arXiv id) over a raw URL so the open-access copy is resolved automatically.
- Papers are already indexed (from Gather/Expand) — do not re-index, `document_index` dedups. If a paper only proves key *after* deep-reading, index it then — but never later than the moment you decide it matters.

## 5. Synthesize
- Write the final report to `~/pi_research/<today-YYYY-MM-DD>/<topic-slug>.md` (create the folder if needed).
  - `~/pi_research/` is the default report root.
  - Use today's date as a subfolder in `YYYY-MM-DD` format (one folder per research run).
  - `<topic-slug>` is a short lowercase slug referencing the topic (underscores, e.g. `zernike_mean`).
- Use inline citations (author, year, DOI or URL) on every claim.
- State only what the sources say. Do not invent sources or claims. If evidence is thin or conflicting, say so explicitly.
- End the report with a **`## Promising leads`** section: non-paper leads found during the run — GitHub repos, datasets, code, preprints, tools, demos — each with a one-line description and URL, explicitly flagged as *unverified leads*.

## Mathematics formatting
Write all mathematics in real LaTeX embedded in the Markdown (it must render in GitHub/VS Code):
- Inline math in `$...$` (e.g. `$Z_{nm}$`); display math as block equations in `$$ ... $$`.
- Conventions: scalar variables in italics (`$f$`, `$r$`, `$\theta$`, `$Z_{nm}$`); named functions upright (`\sin`, `\cos`, `\exp`, `\ln`, `\log`, `\operatorname{reconstruct}`); operators upright (`\sum`, `\prod`, `\int`, `\iint`, `\lim`, `\arg\min`); differential `\mathrm{d}`; the imaginary unit `\mathrm{i}` and Euler's number `\mathrm{e}` upright; vectors bold (`\mathbf{v}`); matrices bold upright (`\mathbf{A}`); units upright.
- Use `\frac`, `\sqrt`, `\left( \right)`, `\partial`, `\langle \rangle`, `\bar{...}`, `\hat{...}`, `^{\circ}`, and proper `_{...}`/`^{...}` sub/superscripts.
- Never write pseudo-math in plain text or ASCII art (avoid `Z_nm`, `∫∫`, `e^(−imα)`, `(1/K) Σ_k`); always use real LaTeX so the rendered report is unambiguous.

## Tools reference
- `academic_graph_search(query, limit=5, yearFrom?, yearTo?)`
- `academic_citations(paperId, direction="citations"|"references", limit=10)`
- `unpaywall_resolver(doi)` → `{ is_oa, pdf, oa_status, ... }`
- `pdf_extract(url? | doi?, mode="text"|"render", pages="1-5", dpi=150)`
- `document_index(source, name?, reindex?)` → append a PDF/paper to the knowledge base
- `document_search(query, k=10, docs?, keyword?)` → hybrid (dense + BM25 + sparse) top-k chunks with page/section/snippet (pass `keyword=false` for dense-only; LaTeX may have stray spaces)
- `document_status()` → list indexed documents

## Notes
- Search falls back to Crossref automatically when Semantic Scholar is rate-limited. Citation *forward* traversal (who cites a paper) needs `S2_API_KEY`; backward references fall back to Crossref with no key.
- Unpaywall uses `UNPAYWALL_EMAIL` (set to your real email).
- Extracted files live under `.deep-research/papers/<slug>/` (`paper.pdf`, `paper.txt`, `page-NN.png`).
- Text extraction is best-effort reading order. For exact layout, tables, and figures, use the rendered PNGs.
- The knowledge base lives in `~/pi_research/books/` and is **persistent and evolving**: every paper indexed during a run stays there and is searchable in later sessions via `document_search`.
