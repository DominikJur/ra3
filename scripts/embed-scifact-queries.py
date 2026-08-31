# Resilient pre-embed of the SciFact test queries (one at a time — tiny requests ride
# out tunnel flaps that kill 128-query batches). Writes q_dense.npy + q_sparse.json
# into the SCIFACT_EVAL_DIR, which eval.py now loads from cache.
import json, os, time, urllib.request
import numpy as np

BASE = os.environ.get("SCIFACT_EVAL_DIR", os.path.expanduser("~/pi_research/scifact_eval"))
EMBED = os.environ.get("EMBED_BASE_URL", "http://localhost:8001") + "/embed"

queries = [json.loads(l) for l in open(os.path.join(BASE, "scifact", "queries.jsonl"), encoding="utf-8")]
qrels = {}
with open(os.path.join(BASE, "scifact", "qrels", "test.tsv"), encoding="utf-8") as f:
    next(f, None)
    for line in f:
        qid, docid, rel = line.strip().split("\t")
        qrels.setdefault(qid, {})[docid] = int(rel)
test = [q for q in queries if q["_id"] in qrels]
print(f"embedding {len(test)} test queries, 1 per request (retry forever, backoff 2s)")
dense = np.zeros((len(test), 1024), dtype=np.float32)
sparse = [{} for _ in test]
t0 = time.time()
for i, q in enumerate(test):
    while True:
        try:
            req = urllib.request.Request(EMBED, data=json.dumps({"texts": [q["text"]], "return_sparse": True}).encode(),
                                         headers={"content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as r:
                j = json.load(r)
            dense[i] = np.array(j["dense"][0], dtype=np.float32)
            sparse[i] = j["sparse"][0]
            break
        except Exception as e:
            time.sleep(2)
    if (i + 1) % 50 == 0:
        print(f"  {i+1}/{len(test)} ({time.time()-t0:.0f}s)", flush=True)
dense /= np.linalg.norm(dense, axis=1, keepdims=True)
np.save(os.path.join(BASE, "q_dense.npy"), dense)
json.dump(sparse, open(os.path.join(BASE, "q_sparse.json"), "w", encoding="utf-8"))
print(f"done in {time.time()-t0:.0f}s -> q_dense.npy + q_sparse.json")
