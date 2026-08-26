# RA³ — Retrieval-Augmented Academic Agent

Ask questions of your books and papers — and get answers grounded in the text, with page
citations, that you can verify yourself.

## What it does

RA³ turns your PDFs into a private, searchable knowledge base that your agent cites instead of
guessing. Built for researchers who need answers that trace to specific passages — not
plausible-sounding prose.

- **Cited, verifiable answers.** Every claim is backed by a retrieved passage and cited as
  `(source, page)`, so you can flip to the page and check it.
- **Your literature stays private.** Documents never leave your machine. No cloud accounts, no
  corpus uploads.
- **A complete research loop.** Discover papers (Semantic Scholar, citation traversal, open-access
  PDF resolution), read them (text + page images, OCR for scans), index them, and query the result.
- **An evolving knowledge base.** Everything you index — including the papers a deep-research run
  reads — accumulates permanently in one SQLite file, so your library compounds with each session
  and stays searchable later.
- **Retrieval you can rely on.** Zero-shot SciFact nDCG@10 of 0.70 — on par with SPLADE, ahead of
  ColBERT and Contriever — so the passages it cites are the right ones.
- **Bring your own model.** RA³ does retrieval; pair it with whichever LLM you run (local or
  hosted). No vendor lock-in.

## How it works

Retrieval fuses three complementary signals — BGE-M3 dense embeddings, BM25 keyword match, and
BGE-M3 learned-sparse weights — via reciprocal-rank fusion and a diversity reranking pass, stored
in one SQLite file (`sqlite-vec`). Documents are chunked locally; scanned PDFs are OCR'd by a
pluggable server (MinerU for math/layout, Tesseract for plain text). The only out-of-process
compute is an embedding server you run yourself — CPU or GPU, or rented — see `server/`.

## Install

1. Install pi, then this package:
   ```bash
   pi install git:github.com/DominikJur/ra3
   ```
   (or `pi install ./ra3` from a local checkout)
2. `npm install` (installs the runtime deps: pdfjs, sqlite-vec, canvas).
3. Point embedding at a server (default `http://localhost:8001`) — a FlagEmbedding BGE-M3 service
   that answers `POST /embed` with `{dense: [[1024]], sparse: [{term: weight}]}` for
   `{texts: [...]}`:
   ```bash
   export EMBED_BASE_URL=http://localhost:8001
   ```

> **One embedding manifold, one build.** The dense vectors in `kb.sqlite` were produced by
> FlagEmbedding BGE-M3 (fp16). The query embedder must be the **same build** — a different
> BGE-M3 build (Xenova/bge-m3 q8, ollama bge-m3, …) is a different embedding manifold, so its
> cosine scores against the stored vectors are meaningless. There is **no** silent local vector
> fallback: if the embed server is unreachable, search degrades honestly to keyword-only (BM25),
> and indexing fails. Stand up the server first (`server/embed/embed-server.py` — see
> `server/README.md`).
> **No GPU?** It runs on CPU (same build, slower), or deploy the bundled Docker image to a rented
> GPU box (RunPod/Vast/Lambda/…) and point `EMBED_BASE_URL` at it — the server is just a URL.

## Quickstart

```
document_index({ source: "path/to/book.pdf" })     # index a PDF (local/URL/DOI)
document_search({ query: "bias variance tradeoff" }) # hybrid search, cites (source, page)
```

Scanned/image PDFs are auto-routed to an optional OCR backend (only when pdfjs text density is
below ~40 chars/page; text PDFs are extracted fully locally by `lib/ocr.ts`). Two interchangeable
servers ship in `server/` — point `OCR_BASE_URL` at whichever you run:

```bash
# light (recommended without a GPU): Tesseract — plain text only, no math/table fidelity
#   docker build -t ra3-ocr-light server/ocr-light && docker run -p 8002:8002 ra3-ocr-light
export OCR_BASE_URL=http://localhost:8002

# heavy (GPU): MinerU — math, tables, and layout preserved
#   see server/ocr/README.md
export OCR_BASE_URL=http://localhost:8002
```

See `server/README.md` for the full comparison and the documented weaknesses of each.
(**Vulnerability TL;DR:** the light server OCRs plain text well but mangles math, tables, and
multi-column reading order — equations become garbage. Use MinerU if those matter.)

## Import / export the knowledge base

The whole KB is one portable SQLite file, so it can be backed up or moved between machines.

**Tools** (recommended, run inside pi):

```
document_export_kb({ dest: "path/to/kb-export.sqlite" })    # lossless snapshot (docs+chunks+dense+sparse)
document_import_kb({ source: "path/to/kb-export.sqlite" })   # merge (skip existing) or replace:true
```

**CLI** (without pi):

```bash
node export-kb.mjs kb-export.sqlite[.gz] [--gzip]   # ~2 s for a 77-doc KB
node import-kb.mjs kb-export.sqlite[.gz] [--replace]
```

Notes:

- Export is a byte-exact snapshot (the WAL is folded first) — vectors are copied **verbatim**, so
  importing needs **no re-embedding** and **no GPU**.
- Import **merges by default** (slugs already present are skipped); `replace:true` overwrites them.
  A full-KB merge import is I/O-bound by sqlite-vec's per-row insert (~6 ms/vector-row on a laptop);
  a few docs import in seconds.
- **Fast restore** (no merge): quit pi, copy the snapshot over `kb.sqlite`, relaunch.
- A `.gz` extension (or `--gzip`) compresses the snapshot; import auto-detects it.

## Configuration (all via env)

| var | default | meaning |
|---|---|---|
| `EMBED_BASE_URL` | `http://localhost:8001` | BGE-M3 dense+sparse embed server |
| `OCR_BASE_URL` | `http://localhost:8002` | OCR server for scanned PDFs (optional): MinerU (`server/ocr/`) or Tesseract (`server/ocr-light/`) |
| `KB_ROOT` | `~/pi_research/books` | where `kb.sqlite` + per-doc dirs live |
| `S2_API_KEY` | — | Semantic Scholar API key (avoids rate limits) |
| `UNPAYWALL_EMAIL` | — | email for the Unpaywall API |

## Retrieval benchmark — SciFact (zero-shot)

300 test queries, retrieval-only (no LLM):

| Leg | nDCG@10 | Recall@100 |
|---|---|---|
| dense only | 0.6415 | 0.9037 |
| BM25 only | 0.6621 | 0.8792 |
| sparse only | 0.6340 | 0.9002 |
| **3-leg (RRF)** | **0.7011** | **0.9477** |

Ties SPLADE (0.706) and beats ColBERT / Contriever on SciFact — with single-vector-per-chunk
storage. Run it yourself: `python scifact_eval/eval.py` (embeds via `EMBED_BASE_URL`, caches
corpus vectors). See `scifact_eval/README.md`.

## Demo

`./fetch-corpus.sh` downloads the CC-BY demo book; `demo/README.md` has a hard finite-difference
question whose answer lives only in the book; `demo/retrieve.mjs` runs the 3-leg retrieval.

## Layout

- `extensions/deep-research/` — the tools (`document_index/search/status/export_kb/import_kb`,
  `academic_graph_search`, `academic_citations`, `unpaywall_resolver`, `pdf_extract`).
  `lib/kb-sqlite.ts` is the KB engine.
- `export-kb.mjs` / `import-kb.mjs` — standalone CLI wrappers for KB snapshot/merge.
- `server/` — reference compute servers: `embed/` (FlagEmbedding BGE-M3), `ocr/` (MinerU),
  `ocr-light/` (Tesseract). See `server/README.md`.
- `skills/book/` + `skills/deep-research/` — the workflow instructions.
- `scifact_eval/` — retrieval-only benchmark harness.
- `demo/` — the demo corpus question + retrieval script.
- `AGENTS.md` — the RAG-first (anti-hallucination) policy.

## Credits & citations

Everything this package builds on is cited here.

**Retrieval & embeddings**

- **BGE-M3** — Jianlv Chen, Shitao Xiao, Peitian Zhang, Kun Luo, Defu Lian, Zheng Liu.
  *“M3-Embedding: Multi-Linguality, Multi-Functionality, Multi-Granularity Text Embeddings
  Through Self-Knowledge Distillation.”* Findings of the Association for Computational
  Linguistics: ACL 2024. arXiv:2402.03216, DOI 10.18653/v1/2024.findings-acl.137.
  Model `BAAI/bge-m3` (MIT); served via [FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding) (MIT).
- **BM25** — S. E. Robertson & S. Walker (1994), *“Some Simple Effective Approximations to the
  2-Poisson Model for Probabilistic Weighted Retrieval,”* SIGIR; and S. Robertson & H. Zaragoza
  (2009), *“The Probabilistic Relevance Framework: BM25 and Beyond,”* Foundations and Trends in
  Information Retrieval 3(4).
- **Reciprocal Rank Fusion** — G. V. Cormack, C. L. A. Clarke, S. Büttcher (2009),
  *“Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods,”* SIGIR.
- **Maximal Marginal Relevance** — J. Carbonell & J. Goldstein (1998), *“The Use of MMR,
  Diversity-Based Reranking for Reordering Documents and Producing Summaries,”* SIGIR.

**OCR**

- **MinerU** — Bin Wang, Chao Xu, Xiaomeng Zhao, Linke Ouyang, Fan Wu, et al. (2024),
  *“MinerU: An Open-Source Solution for Precise Document Content Extraction.”* arXiv:2409.18839.
  © Shanghai AI Laboratory. License: **AGPL-3.0** (recent releases have changed it — check the
  upstream `LICENSE`; the copyleft terms matter if you redistribute a bundled server).
- **Tesseract** — Ray Smith (2007), *“An Overview of the Tesseract OCR Engine,”* Proc. 9th
  Int. Conf. on Document Analysis and Recognition (ICDAR), pp. 629–633. Apache-2.0.

**Libraries & infrastructure**

- **pi** — the coding agent this package extends: [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
- **sqlite-vec** — Alex Garcia ([asg017/sqlite-vec](https://github.com/asg017/sqlite-vec)), MIT / Apache-2.0.
- **pdf.js** — Mozilla ([pdfjs-dist](https://github.com/mozilla/pdf.js)), Apache-2.0.
- **@napi-rs/canvas** — PDF page rendering to PNG (MIT).
- **Semantic Scholar API**, **Crossref**, **Unpaywall** — academic metadata and open-access PDF
  resolution for the deep-research tools.

**Benchmark & demo corpus**

- **SciFact** — David Wadden, Shanchuan Lin, Kyle Lo, Lucy Lu Wang, Madeleine van Zuylen,
  Arman Cohan, Hannaneh Hajishirzi. *“Fact or Fiction: Verifying Scientific Claims.”* EMNLP 2020,
  arXiv:2004.14974. (Retrieval benchmark, used via BEIR.)
- **Demo corpus** — Hans Petter Langtangen & Svein Linge, *“Finite Difference Computing with
  PDEs,”* Springer 2017, CC BY 4.0 (downloaded by `fetch-corpus.sh`, not bundled).

## License

Apache-2.0. (The demo corpus is CC BY 4.0 and is *not* bundled — `fetch-corpus.sh` downloads it.
Do not substitute the UDL edition, which is CC BY-NC-ND.)
