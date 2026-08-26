# OCR server — MinerU (heavy, math-capable)

Reference server for **scanned/image PDFs** only. Text-based PDFs never reach OCR — they're
extracted locally by pdfjs. `lib/ocr.ts` routes to `OCR_BASE_URL` only when a PDF's text density
is below ~40 chars/page.

This is the **heavy** option: MinerU 3.x with the `pipeline` backend (PDF-Extract-Kit-1.0).
It is the best choice when you need **math, formulas, tables, and layout** preserved. If you only
need the text and have no GPU, use `../ocr-light/` instead.

## What it's good / bad at

| | |
|---|---|
| ✅ plain printed text | excellent |
| ✅ math / formulas | yes (LaTeX-ish output) |
| ✅ tables | structured |
| ✅ multi-column reading order | yes |
| ⚠️ handwriting | partial |
| ❌ install size | huge — torch + ~8 GB models |
| ❌ CPU | slow (order of magnitude worse than GPU) |

## Run (Docker, GPU)

```bash
docker build -t ra3-ocr .
docker run --gpus all -p 8002:8002 \
  -v mineru-models:/models \
  -v mineru-hf-cache:/root/.cache/huggingface \
  ra3-ocr
```

Then point the package at it:

```bash
export OCR_BASE_URL=http://localhost:8002        # or http://<host>:8002 (cloud) / a tunnel
```

### Model download (one-time, ~8 GB)

MinerU fetches PDF-Extract-Kit-1.0 from Hugging Face on first use. With the `-v` volumes above,
the models and the HF cache persist across restarts. The `mineru.json` in this dir points
`models-dir.pipeline` at `/models/PDF-Extract-Kit-1.0` — after the first run, check where MinerU
actually placed the snapshot (a hash-suffixed path under the HF cache) and set `models-dir.pipeline`
to that, or leave it to MinerU's default resolution. The exact download/CLI behavior is
version-specific; this was written against **MinerU 3.4.5**.

## Vulnerabilities / gotchas

- **Version-sensitive config.** The `mineru.json` schema and `mineru-api` flags can change between
  MinerU releases. Treat this dir as a starting point, not gospel.
- **Backend must be `pipeline`.** The default `hybrid-engine` backend needs a local VLM that's too
  heavy for smaller cards; the client always sends `backend=pipeline`, matching this config.
- **No auth.** The API has none — keep it on `127.0.0.1` + tunnel, or expose `0.0.0.0` only behind
  a firewall.
- **GPU strongly recommended.** CPU OCR here is ~an order of magnitude slower (the reference
  deployment measured ~11 s/page on an RTX 5060 Ti 16 GB).

## Contract (same as `../ocr-light/`)

| endpoint | request | response |
|---|---|---|
| `GET /health` | — | `{"ok": true}` |
| `POST /file_parse` | multipart: `files` (PDF) + `backend=pipeline`, `parse_method=ocr`, `return_md=true`, … | `{"results": {"<stem>": {"md_content": "…"}}}` |

Both OCR servers implement this contract, so `lib/ocr.ts` is agnostic — choose by setting
`OCR_BASE_URL`.
