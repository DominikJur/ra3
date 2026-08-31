import json, os, urllib.request, zipfile, math, re, time, collections
import numpy as np

BASE = os.environ.get("SCIFACT_EVAL_DIR", os.path.expanduser("~/pi_research/scifact_eval"))
os.makedirs(BASE, exist_ok=True)
EMBED = os.environ.get("EMBED_BASE_URL", "http://localhost:8001") + "/embed"
B = 128

# ---------- 1. data ----------
zip_path = os.path.join(BASE, "scifact.zip")
if not os.path.exists(zip_path):
    print("downloading SciFact (BEIR) ...", flush=True)
    urllib.request.urlretrieve("https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip", zip_path)
with zipfile.ZipFile(zip_path) as z:
    z.extractall(BASE)

def load_jsonl(p):
    return [json.loads(l) for l in open(p, encoding="utf-8")]

corpus = load_jsonl(os.path.join(BASE, "scifact", "corpus.jsonl"))
queries = load_jsonl(os.path.join(BASE, "scifact", "queries.jsonl"))
qrels = {}
with open(os.path.join(BASE, "scifact", "qrels", "test.tsv"), encoding="utf-8") as f:
    next(f, None)
    for line in f:
        qid, docid, rel = line.strip().split("\t")
        qrels.setdefault(qid, {})[docid] = int(rel)

docs = [(d["_id"], (d.get("title", "") + " " + d.get("text", "")).strip()) for d in corpus]
test_queries = [q for q in queries if q["_id"] in qrels]
print(f"corpus={len(corpus)}  all_queries={len(queries)}  test_queries={len(test_queries)}", flush=True)

# ---------- 2. embed via EMBED_BASE_URL (cached) ----------
def embed(texts):
    for attempt in range(4):
        try:
            req = urllib.request.Request(EMBED, data=json.dumps({"texts": texts, "return_sparse": True}).encode(),
                                         headers={"content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except Exception as e:
            if attempt == 3:
                raise
            print(f"  embed retry {attempt+1}: {e}", flush=True)
            time.sleep(3 * (attempt + 1))

def embed_all(texts):
    dense = np.zeros((len(texts), 1024), dtype=np.float32)
    sparse = [{} for _ in texts]
    t0 = time.time()
    for i in range(0, len(texts), B):
        r = embed(texts[i:i + B])
        for j in range(len(r["dense"])):
            dense[i + j] = np.array(r["dense"][j], dtype=np.float32)
            sparse[i + j] = r["sparse"][j]
        if (i // B) % 25 == 0:
            print(f"  {min(i+B,len(texts))}/{len(texts)} ({time.time()-t0:.0f}s)", flush=True)
    dense /= np.linalg.norm(dense, axis=1, keepdims=True)
    return dense, sparse

CD = os.path.join(BASE, "doc_dense.npy")
CS = os.path.join(BASE, "doc_sparse.json")
if os.path.exists(CD) and os.path.exists(CS):
    print("loading cached corpus embeddings ...", flush=True)
    doc_dense = np.load(CD)
    doc_sparse = json.load(open(CS, encoding="utf-8"))
else:
    t0 = time.time()
    print("embedding corpus (no cache) ...", flush=True)
    doc_dense, doc_sparse = embed_all([t for _, t in docs])
    np.save(CD, doc_dense)
    json.dump(doc_sparse, open(CS, "w", encoding="utf-8"))
    print(f"corpus embedded + cached in {time.time()-t0:.0f}s", flush=True)

print("embedding test queries ...", flush=True)
QD = os.path.join(BASE, "q_dense.npy")
QS = os.path.join(BASE, "q_sparse.json")
if os.path.exists(QD) and os.path.exists(QS):
    print("loading cached query embeddings ...", flush=True)
    q_dense = np.load(QD)
    q_sparse = json.load(open(QS, encoding="utf-8"))
else:
    q_dense, q_sparse = embed_all([q["text"] for q in test_queries])
    np.save(QD, q_dense)
    json.dump(q_sparse, open(QS, "w", encoding="utf-8"))

# ---------- 3. BM25 ----------
def tokenize(s):
    return [t for t in re.findall(r"[a-z0-9]+", s.lower()) if len(t) >= 2]

doc_toks = [tokenize(t) for _, t in docs]
N = len(docs)
df = collections.Counter()
for toks in doc_toks:
    df.update(set(toks))
avgdl = np.mean([len(t) for t in doc_toks])
doc_len = [len(t) for t in doc_toks]
doc_tf = [collections.Counter(t) for t in doc_toks]
K1, Bb = 1.5, 0.75
idf = {term: math.log((N - c + 0.5) / (c + 0.5) + 1) for term, c in df.items()}

def bm25_scores(qtoks):
    scores = np.zeros(N)
    for term in set(qtoks):
        if term not in idf:
            continue
        w = idf[term]
        for i in range(N):
            tf = doc_tf[i].get(term, 0)
            if tf:
                scores[i] += w * (tf * (K1 + 1)) / (tf + K1 * (1 - Bb + Bb * doc_len[i] / avgdl))
    return scores

sp_inv = collections.defaultdict(list)
for i, sp in enumerate(doc_sparse):
    for term, w in sp.items():
        sp_inv[term].append((i, w))

def sparse_scores(qsp, prune=False):
    scores = np.zeros(N)
    if prune:
        # Mirror kb-sqlite.ts sparseSearch pruning: top-32 terms by weight,
        # skip terms with df > 15% of the corpus, cap total postings at 150k.
        terms = sorted(qsp.items(), key=lambda kv: -kv[1])[:32]
        budget = 150_000
        for term, qw in terms:
            pl = sp_inv.get(term, [])
            if len(pl) > 0.15 * N:
                continue
            if budget <= 0:
                break
            for (i, dw) in pl:
                scores[i] += qw * dw
            budget -= len(pl)
    else:
        for term, qw in qsp.items():
            for (i, dw) in sp_inv.get(term, []):
                scores[i] += qw * dw
    return scores

# ---------- 4. evaluate ----------
def ndcg_at_k(ranked_ids, rel, k=10):
    ideal = sorted(rel.values(), reverse=True)[:k]
    idcg = sum(r / math.log2(i + 2) for i, r in enumerate(ideal))
    return 0.0 if idcg == 0 else sum(rel.get(d, 0) / math.log2(i + 2) for i, d in enumerate(ranked_ids[:k])) / idcg

def recall_at_k(ranked_ids, rel, k=100):
    rel_docs = {d for d, r in rel.items() if r > 0}
    return len(set(ranked_ids[:k]) & rel_docs) / len(rel_docs) if rel_docs else 0.0

res = {name: {"ndcg10": [], "r100": []} for name in ("dense", "bm25", "sparse", "3leg", "3leg+prune")}
doc_ids = [d[0] for d in docs]

for qi, q in enumerate(test_queries):
    rel = qrels[q["_id"]]
    ds = q_dense[qi] @ doc_dense.T
    bs = bm25_scores(tokenize(q["text"]))
    ss = sparse_scores(q_sparse[qi])
    ss_p = sparse_scores(q_sparse[qi], prune=True)
    rank = lambda s: [doc_ids[i] for i in np.argsort(-s)]
    rd, rb, rs, rsp = rank(ds), rank(bs), rank(ss), rank(ss_p)
    rrf = {}
    for lst in (rd, rb, rs):
        for r, did in enumerate(lst[:200]):
            rrf[did] = rrf.get(did, 0) + 1 / (r + 60)
    r3 = sorted(rrf, key=lambda d: -rrf[d])
    rrf_p = {}
    for lst in (rd, rb, rsp):
        for r, did in enumerate(lst[:200]):
            rrf_p[did] = rrf_p.get(did, 0) + 1 / (r + 60)
    r3p = sorted(rrf_p, key=lambda d: -rrf_p[d])
    for name, lst in (("dense", rd), ("bm25", rb), ("sparse", rs), ("3leg", r3), ("3leg+prune", r3p)):
        res[name]["ndcg10"].append(ndcg_at_k(lst, rel))
        res[name]["r100"].append(recall_at_k(lst, rel))

print("\n=== SciFact retrieval ablation (300 test queries) ===")
print(f"{'leg':8s}  {'nDCG@10':>9s}  {'Recall@100':>11s}")
for name, m in res.items():
    print(f"{name:8s}  {np.mean(m['ndcg10']):9.4f}  {np.mean(m['r100']):11.4f}")
