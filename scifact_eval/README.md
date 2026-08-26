# SciFact retrieval ablation

Retrieval-only evaluation of the hybrid retrieval (no LLM, no cost). Downloads the BEIR
SciFact corpus, embeds the corpus + 300 test queries via `EMBED_BASE_URL` (dense 1024-d +
learned-sparse), and scores nDCG@10 / Recall@100 for a 4-way ablation.

## Run

```bash
pip install numpy
python scifact_eval/eval.py          # EMBED_BASE_URL defaults to http://localhost:8001
```

The corpus (~4k docs) is embedded once and cached as `doc_dense.npy` + `doc_sparse.json` in
`SCIFACT_EVAL_DIR` (default `~/pi_research/scifact_eval`); delete those files to re-embed.

## Results (zero-shot, BGE-M3 via FlagEmbedding, 300 test queries)

| Leg          | nDCG@10 | Recall@100 |
|--------------|---------|------------|
| dense only   | 0.6415  | 0.9037     |
| BM25 only    | 0.6621  | 0.8792     |
| sparse only  | 0.6340  | 0.9002     |
| **3-leg RRF**| **0.7011** | **0.9477** |

Context: ties SPLADE (0.706) and beats ColBERT / Contriever on SciFact, with a single
1024-d dense vector + one sparse vector per chunk. The BM25 leg (0.6621) matches the
published BM25 number (~0.665), which validates the harness.
