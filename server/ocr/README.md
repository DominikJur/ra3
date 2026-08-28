# OCR server: Marker 2 / Surya 2 (GPU, exact math)

The recommended OCR backend. Runs `marker_single --force_ocr` (Surya 2, a 650M VLM) so **every
page** is OCR'd with exact LaTeX math — no dependence on the PDF's text layer, no mangled
`λᵏe⁻λ/k!`-style garbage. Reconstructs **per-page markdown** from Marker's JSON block tree and
emits `<!-- page N -->` markers, so KB page numbers stay correct.

- Beats the old MinerU pipeline on accuracy (olmOCR-bench 76.0 vs 72.7) and is ~5–10× faster
  on a 16 GB GPU (~2–5 pages/s).
- License: Marker code Apache-2.0; **Surya model weights OpenRAIL-M** (free for research /
  personal / startups < $5M revenue; commercial above needs a datalab.to license).

## Contract

```text
GET  /health     -> {"ok": true, "ocr": "marker/surya-2"}
POST /file_parse multipart: files (PDF) -> {"results": {"<stem>": {"md_content": "..."}}}   (sync)
POST /jobs       multipart: files (PDF) -> {"job_id": "...", "status": "queued"}          (async, storm-safe)
GET  /jobs/<id>  -> {"status": "queued|processing|done|error", "md_content": "...", ...}
```

`md_content` is markdown with `<!-- page N -->` markers separating pages. `lib/ocr.ts` splits on
those markers, so no client changes are needed for correct page numbers.

The client uses the **async** `/jobs` flow first (one upload, the server computes in the background,
client polls with tiny requests) and falls back to sync `/file_parse` for servers without `/jobs`
(e.g. ocr-light). Async survives VPN/tunnel flap storms: every step needs only a short connection.

## Deployment (user-space, no sudo — e.g. a GPU box with `uv`)

```bash
uv venv ~/marker-venv --python 3.12
source ~/marker-venv/bin/activate
uv pip install marker-pdf fastapi uvicorn python-multipart
uv pip install ninja                       # flashinfer JIT needs it (pip wheel, no apt)
```

**Inference backend (Surya):** an OpenAI-compatible `/v1/chat/completions` server. On NVIDIA,
run vLLM natively (no docker needed — set `SURYA_INFERENCE_URL` so surya attaches instead of
docker-spawning):

```bash
uv venv ~/vllm-venv --python 3.12 && source ~/vllm-venv/bin/activate && uv pip install vllm
# NB: gcc-15 symlinks + ninja pip wheel required for flashinfer JIT (see below)
export CUDA_HOME=/opt/cuda PATH=$HOME/vllm-venv/bin:$HOME/bin:/opt/cuda/bin:$PATH
export PATH=$HOME/bin:$PATH   # ~/bin has gcc -> gcc-15, g++ -> g++-15 symlinks
vllm serve datalab-to/surya-ocr-2 \
  --dtype bfloat16 --max-model-len 18000 --gpu-memory-utilization 0.7 \
  --enable-prefix-caching \
  --limit-mm-per-prompt '{"image": 4, "video": 0}' \
  --served-model-name datalab-to/surya-ocr-2 --port 8000
```

Notes from a real deployment (RTX 5060 Ti 16 GB, Arch, GCC 16):
- **`--limit-mm-per-prompt '{"image": 4, "video": 0}'` is essential**: without it vLLM
  pre-allocates the vision encoder cache for a 14-frame *video* item (114k tokens, ~9.5 GiB) and
  the KV cache budget goes negative ("No available memory for the cache blocks"). With video
  disabled the encoder cache is 16k tokens and KV cache gets ~7.5 GiB.
- `--gpu-memory-utilization` must fit the free VRAM; 0.7 was needed with ~2.5 GB used by other
  processes. 0.8 OOMs during torch.compile (needs headroom).
- MTP/speculative decoding (`--speculative-config '{"method":"mtp","num_speculative_tokens":2}'`)
  does NOT fit on 16 GB with this hybrid Mamba model (KV cache budget goes negative); skip it.
- flashinfer JIT-compiles kernels on first run and needs `ninja` (pip wheel) + `nvcc` on PATH.
  With GCC 16 the build can fail (`__self` errors) — use GCC 15 if installed (PATH-preprend a
  dir with `gcc -> gcc-15`, `g++ -> g++-15` symlinks).
- First run downloads the Surya 2 weights into `~/.cache/huggingface` (~1–2 GB).
- Measured: ~2.7 s/page marginal on a 5060 Ti (10 pages in ~27 s, warm server) — the first
  page pays ~15–20 s of one-time startup.

Then run the server (port 8002 = `OCR_BASE_URL` default):

```bash
scp ocr-marker.py <your-server>:~/   # or wherever the server lives
SURYA_INFERENCE_URL=http://127.0.0.1:8000/v1 \
setsid nohup ~/marker-venv/bin/python ~/ocr-marker.py > ~/marker-ocr.log 2>&1 &
curl -s http://127.0.0.1:8002/health   # {"ok":true,"ocr":"marker/surya-2"}
```

Env knobs: `OCR_TIMEOUT` (per-file seconds, default 7200), `MARKER_MODE` (balanced/fast),
`SURYA_INFERENCE_URL`, `SURYA_INFERENCE_BACKEND` (vllm default; `llamacpp` also works if you
point it at an OpenAI-compatible server), `OCR_HOST` (default 127.0.0.1).

## CPU / no-GPU fallback

Marker can run in `--mode fast` with a llama.cpp backend (`SURYA_INFERENCE_BACKEND=llamacpp` +
a CUDA/CPU `llama-server` binary), but for CPU-only boxes the `server/ocr-light/` Tesseract
server is the pragmatic choice (plain text, no math).
