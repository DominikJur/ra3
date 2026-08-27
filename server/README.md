# Servers

RA³ keeps heavy compute behind HTTP URLs, so the package stays code + config and the compute can
live on your machine, a rented GPU, or not at all. Four reference servers ship here:

| dir | service | role | GPU | good at | bad at |
|---|---|---|---|---|---|
| [`embed/`](embed/) | FlagEmbedding BGE-M3 | dense + sparse embeddings (`EMBED_BASE_URL`) | no (CPU ok) | the one embedding manifold | — |
| [`ocr-marker/`](ocr-marker/) | **Marker 2 / Surya 2 (recommended)** | OCR for exact math (`OCR_BASE_URL`) | recommended (vLLM) | math/equations, tables, speed | weights OpenRAIL-M |
| [`ocr/`](ocr/) | MinerU 3.x | heavy OCR (`OCR_BASE_URL`) | strongly recommended | math, tables, layout | huge install, slow |
| [`ocr-light/`](ocr-light/) | Tesseract | light OCR (`OCR_BASE_URL`) | no | plain printed text | math, tables, reading order |

## Do I need any of these?

- **Embedding**: yes. Search degrades to keyword-only and indexing fails without it. No GPU
  needed (CPU is fine; the model is ~2.3 GB).
- **OCR**: **runs on every document by default** (`OCR_MODE=always`) so equations are exact.
  Without an OCR server, documents fall back to local pdfjs extraction (math may be mangled).
  Set `OCR_MODE=auto` (scanned only) or `off` to change this.

## Which OCR to use

All OCR servers implement the same `POST /file_parse` contract; `lib/ocr.ts` is agnostic: point
`OCR_BASE_URL` at whichever you run. **Use `ocr-marker/` (Marker 2) by default** — it beats MinerU
on accuracy and is ~5–10× faster on a 16 GB GPU.

| | `ocr-marker/` Marker 2 | `ocr/` MinerU | `ocr-light/` Tesseract |
|---|---|---|---|
| math / formulas | ✅ LaTeX | ✅ LaTeX-ish | ❌ garbage |
| tables | ✅ | ✅ structured | ❌ flattened |
| reading order | ✅ | ✅ | ⚠️ |
| speed (16 GB GPU) | ~2–4 pages/s | ~0.5 pages/s | CPU ~1–3 s/page |
| license | Apache-2.0 code + OpenRAIL-M weights | AGPL-3.0 | Apache-2.0 |

## Common setup

```bash
export EMBED_BASE_URL=http://localhost:8001
export OCR_BASE_URL=http://localhost:8002    # Marker 2 (ocr-marker) recommended
export OCR_MODE=always                        # default: OCR every doc
```

## Security

None of these servers have auth. Bind `127.0.0.1` (the default) and tunnel, or bind `0.0.0.0`
only behind a firewall / private network.
