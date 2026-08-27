# OCR server: Marker 2 / Surya 2 (recommended default)

**This is the recommended OCR backend for RA³** — it replaces MinerU as the default
(`OCR_BASE_URL` → this server). Marker 2 (Datalab) with the **Surya 2** engine (650M VLM) beats
MinerU on the olmOCR-bench harness (76.0 vs 72.7) while being roughly **5–10× faster** on a 16 GB
GPU, and it outputs markdown with LaTeX math ("tex everywhere").

## Contract (identical to `../ocr/` and `../ocr-light/`)

| endpoint | request | response |
|---|---|---|
| `GET /health` | — | `{"ok": true, "ocr": "marker/surya-2"}` |
| `POST /file_parse` | multipart `files` (PDF) | `{"results": {"<stem>": {"md_content": "…"}}}` |

The client (`lib/ocr.ts`) is unchanged: point `OCR_BASE_URL` at this server and every
`document_index` call routes through Marker 2 (`OCR_MODE=always` is the default).

## Run (GPU, recommended)

```bash
docker build -t ra3-ocr-marker .
docker run --gpus all -p 8002:8002 \
  -v surya-cache:/root/.cache \
  -e SURYA_INFERENCE_BACKEND=vllm \
  -e SURYA_INFERENCE_KEEP_ALIVE=1 \
  ra3-ocr-marker
```

(Requires Docker + the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).)
CPU / Apple Silicon: install a `llama.cpp` `llama-server`, set `SURYA_INFERENCE_BACKEND=llamacpp`,
and drop `--gpus all`.

## Tuning

| env | default | meaning |
|---|---|---|
| `OCR_TIMEOUT` | `3600` | seconds allowed per file |
| `MARKER_MODE` | (auto) | `balanced` (GPU, best) or `fast` (CPU) |
| `SURYA_INFERENCE_BACKEND` | `vllm` | `vllm` (NVIDIA) or `llamacpp` (CPU/Apple) |
| `SURYA_INFERENCE_PARALLEL` | auto | concurrent Surya requests |
| `SURYA_INFERENCE_KEEP_ALIVE` | `1` | keep the Surya server warm between files |
| `VLLM_GPUS` | — | GPU indices for the Surya server |

## Why this over MinerU

- olmOCR-bench: **76.0** (balanced) vs MinerU pipeline **72.7** (third-party harness, 2026).
- Speed: ~5 pages/s on an RTX 5090; on a 5060 Ti 16 GB expect ~2–4 pages/s vs MinerU ~0.5
  pages/s (≈4–8× faster).
- Surya 2 is 650M params (~0.4–1.5 GB VRAM) — trivially fits 16 GB.
- `--force_ocr` is applied so **every page** is OCR'd (not just scanned pages), preserving
  equations exactly.

## License (check before commercial use)

- Code: **Apache 2.0** (free, including commercially).
- Surya/Marker model weights: **OpenRAIL-M** (free for research, personal use, and startups under
  $5M funding/revenue; commercial use beyond that requires a paid license from datalab.to).

## Validate on your own corpus

Run a small page sample through both this server and MinerU, and diff the math (formula
recognition) before a full re-index. The olmOCR-bench numbers are from a third-party harness
(2026) — see the RA³ report `~/pi_research/2026-08-27/ocr-faster-than-mineru.md`.
