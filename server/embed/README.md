# Embedding server (FlagEmbedding BGE-M3)

`embed-server.py` is the reference encoder for RA³: a FastAPI wrapper around
FlagEmbedding's `BGEM3FlagModel('BAAI/bge-m3')`, returning both **dense** (1024-d) and
**learned-sparse** lexical weights per text. It auto-detects GPU (fp16) vs CPU (fp32).

## Why this exact build matters

The dense vectors stored in `kb.sqlite` were produced by **FlagEmbedding BGE-M3**. Cosine
similarity is only meaningful *within one embedding manifold*. A different build: **Xenova/bge-m3
(q8/ONNX), ollama's `bge-m3`, a different pooling mode, or a generic hosted embedding API
(OpenAI/Cohere/Voyage/…)**: projects queries onto a *different* manifold, so its scores against
the stored vectors are noise. That is why:

- the query embedder **must** be this server (or a bit-identical equivalent), and
- there is **no** silent local vector fallback in the code: if the server is down, search
  degrades honestly to keyword-only (BM25) and indexing fails.

fp16 (GPU) vs fp32 (CPU) of **this** build is *not* a manifold change: same weights, different
numeric precision, so cosine rankings are unaffected. (Bit-exact vector equality across torch
versions isn't guaranteed, but retrieval rankings are insensitive to it.)

## No GPU? Run on CPU or rent compute

BGE-M3 runs on CPU: slower, same manifold. The server is also just a URL
(`EMBED_BASE_URL`), so any deployment below is a config change, not a code change.

**1. Local CPU** (fine for a few books/papers; ~5–50 texts/s indexing, ~100–500 ms/query)

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu   # CPU torch, not the 2.5 GB CUDA wheel
pip install -r requirements.txt
python embed-server.py
```

**2. Docker** (any machine)

```bash
docker build -t ra3-embed .                       # CPU
docker run -p 8001:8001 ra3-embed
```

GPU box:

```bash
docker build --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu121 -t ra3-embed .
docker run --gpus all -p 8001:8001 ra3-embed
```

**3. Cloud GPU** (RunPod / Vast.ai / Lambda / Modal / Fly.io GPU / any GPU VPS)

Deploy this exact server (git clone, or the Docker image above) on the box, then point at it:

```bash
export EMBED_BASE_URL=http://<host>:8001        # or an https endpoint / SSH tunnel to localhost
```

> ⚠️ The server has **no auth**. Bind `127.0.0.1` (default) and tunnel, or expose `0.0.0.0`
> only behind a firewall / private network (`EMBED_HOST=0.0.0.0`).
>
> ⚠️ Do **not** substitute a generic hosted embedding API or a different BGE-M3 server
> (ollama `bge-m3`, TEI, hosted BGE-M3): those live on different manifolds. The KB vectors were
> made by FlagEmbedding BGE-M3; only that build gives meaningful cosine scores.

## Contract

| endpoint | request | response |
|---|---|---|
| `GET /health` |: | `{"ok": true, "model": "bge-m3", "device": "cuda"\|"cpu", "fp16": bool}` |
| `POST /embed` | `{"texts": ["..."], "return_sparse": true}` | `{"dense": [[1024]], "sparse": [{"term": weight}], "dim": 1024}` |

The model downloads from the HF hub on first run (BGE-M3 ≈ 2.3 GB), then is cached.
