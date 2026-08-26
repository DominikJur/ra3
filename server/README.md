# Servers

RA³ keeps heavy compute behind HTTP URLs, so the package stays code + config and the compute can
live on your machine, a rented GPU, or not at all. Three reference servers ship here:

| dir | service | role | GPU | good at | bad at |
|---|---|---|---|---|---|
| [`embed/`](embed/) | FlagEmbedding BGE-M3 | dense + sparse embeddings (`EMBED_BASE_URL`) | no (CPU ok) | — the one embedding manifold | — |
| [`ocr/`](ocr/) | MinerU 3.x | OCR of scanned PDFs (`OCR_BASE_URL`) | strongly recommended | math, tables, layout | huge install, slow on CPU |
| [`ocr-light/`](ocr-light/) | Tesseract | light OCR of scanned PDFs (`OCR_BASE_URL`) | no | plain printed text | math, tables, multi-column order |

## Do I need any of these?

- **Embedding** — yes. Search degrades to keyword-only and indexing fails without it. No GPU
  needed (CPU is fine; the model is ~2.3 GB).
- **OCR** — only for **scanned/image PDFs**. Text-based PDFs are extracted locally by pdfjs and
  never touch OCR. If you have no scanned PDFs, skip it entirely.

## Which OCR to use

Both OCR servers implement the same `POST /file_parse` contract, so `lib/ocr.ts` is agnostic —
you pick by setting `OCR_BASE_URL` to the one you run.

| | `ocr/` MinerU (pipeline) | `ocr-light/` Tesseract |
|---|---|---|
| plain printed text | ✅ | ✅ (good on clean scans) |
| math / formulas | ✅ LaTeX-ish | ❌ garbage |
| tables | ✅ structured | ❌ flattened |
| multi-column reading order | ✅ | ⚠️ may scramble |
| handwriting | ⚠️ | ❌ |
| install size | huge (torch + ~8 GB models) | small |
| speed | ~s/page on GPU | ~1–3 s/page on CPU |
| needs GPU | recommended | no |

**Rule of thumb:** math/table-heavy scans → `ocr/`. Everything else → `ocr-light/`, or no OCR at
all.

## Common setup

```bash
# embedding (required)
export EMBED_BASE_URL=http://localhost:8001

# OCR (optional, scanned PDFs only) — point at whichever server you run:
export OCR_BASE_URL=http://localhost:8002
```

## Security

None of these servers have auth. Bind `127.0.0.1` (the default) and reach them over an SSH
tunnel, or bind `0.0.0.0` (`EMBED_HOST` / `OCR_HOST`, or the `--host` flag) only behind a
firewall / private network.
