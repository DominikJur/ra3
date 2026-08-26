# Reference embedding server — FlagEmbedding BGE-M3 (dense + learned-sparse).
#
# This is the canonical encoder for RA³. The vectors stored in kb.sqlite were produced by
# THIS build (BGE-M3, fp16, CLS pooling, L2-normalized dense). Keep the query embedder identical:
# a different BGE-M3 build (Xenova q8, ollama bge-m3, a different pooling mode, …) is a different
# embedding manifold — cosine scores between mismatched manifolds are meaningless.
#
# fp16 vs fp32 of THIS build is NOT a manifold change: it is the same weights computed at
# different precision, so cosine rankings are unaffected. We therefore use fp16 only when a GPU
# is present (fast on CUDA, unsupported/slow on CPU) and fp32 on CPU.
#
# Contract (what lib/kb-sqlite.ts expects):
#   GET  /health            -> {"ok": true, "model": "bge-m3", "device": ..., "fp16": ...}
#   POST /embed             body {"texts": [str], "return_sparse": bool}
#                           -> {"dense": [[1024]], "sparse": [{term: weight}], "dim": 1024}
#
# Run (see server/README.md for CPU / Docker / cloud):
#   pip install -r requirements.txt
#   python embed-server.py            # serves 127.0.0.1:8001
import os
import torch
from fastapi import FastAPI
from pydantic import BaseModel
from FlagEmbedding import BGEM3FlagModel

# fp16 on GPU, fp32 on CPU (same manifold). Override with EMBED_USE_FP16=1/0 if needed.
_override = os.environ.get("EMBED_USE_FP16")
USE_FP16 = torch.cuda.is_available() if _override is None else _override.lower() in ("1", "true", "yes")

app = FastAPI()
model = BGEM3FlagModel("BAAI/bge-m3", use_fp16=USE_FP16)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

class Req(BaseModel):
    texts: list[str]
    return_sparse: bool = True

@app.get("/health")
def health():
    return {"ok": True, "model": "bge-m3", "device": DEVICE, "fp16": USE_FP16}

@app.post("/embed")
def embed(req: Req):
    out = model.encode(req.texts, return_dense=True, return_sparse=req.return_sparse,
                       return_colbert_vecs=False, batch_size=32, max_length=512)
    dense = [v.tolist() for v in out["dense_vecs"]]
    resp = {"dense": dense, "dim": len(dense[0]) if dense else 0}
    if req.return_sparse:
        sparse = []
        for lw in out["lexical_weights"]:
            terms = {}
            for tid, w in lw.items():
                tok = model.tokenizer.convert_ids_to_tokens(int(tid))
                if tok and tok not in ("[CLS]", "[SEP]", "[PAD]", "<s>", "</s>", "[UNK]"):
                    terms[tok] = float(w)
            sparse.append(terms)
        resp["sparse"] = sparse
    return resp

if __name__ == "__main__":
    import uvicorn
    # 127.0.0.1 by default (safe, reachable via SSH tunnel). Set EMBED_HOST=0.0.0.0 to expose
    # on a cloud GPU box — the server has NO auth, so only do that behind a firewall/private net.
    uvicorn.run(app, host=os.environ.get("EMBED_HOST", "127.0.0.1"), port=8001)
