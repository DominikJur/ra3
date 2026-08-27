// Lexical (keyword) retrieval: real BM25 plus raw-token preservation for exact
// symbols, DOIs, and chemical names that a naive word tokenizer would destroy.
const STOP = new Set(
  "the a an and or of to in on for with is are was were be been being this that these those it its as at by from we you they i he she him her them not but so if then than also can may will would should could about into over under between through during using via".split(" "),
);

export function wordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

// Raw tokens: preserve exact symbols that word splitting destroys (C++, DOIs,
// chemical formulas, m_pq / x^2 notation, arXiv ids).
export function rawTokens(text: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.trim().toLowerCase();
    if (t.length >= 2) out.push(t);
  };
  for (const m of text.matchAll(/\b(?:10\.\d{4,9}\/[^\s,;)\]"']+|arXiv:\d{4}\.\d{4,5}(?:v\d+)?)/gi)) add(m[0]);
  for (const m of text.matchAll(/\b[a-zA-Z][a-zA-Z0-9_]*(?:[+*/=<>!&|%#@:][a-zA-Z0-9_+*/=<>!&|%#@:.]*)+\b/g)) add(m[0]);
  for (const m of text.matchAll(/\b(?:[A-Z][a-z]?\d*){2,}\b/g)) add(m[0]);
  for (const m of text.matchAll(/\b[a-zA-Z][a-zA-Z0-9]*[_\^][a-zA-Z0-9]+\b/g)) add(m[0]);
  return out;
}

export function tokenize(text: string): string[] {
  return [...wordTokens(text), ...rawTokens(text)];
}

export interface LexicalChunk {
  id: number;
  text: string;
}

export interface BM25Index {
  chunks: LexicalChunk[];
  postings: Map<string, Array<{ id: number; tf: number }>>;
  docLen: Int32Array;
  avgLen: number;
  k1: number;
  b: number;
}

export function buildBM25(chunks: LexicalChunk[], k1 = 1.2, b = 0.75): BM25Index {
  const postings = new Map<string, Array<{ id: number; tf: number }>>();
  const docLen = new Int32Array(chunks.length);
  let totalLen = 0;
  for (const c of chunks) {
    const terms = tokenize(c.text);
    docLen[c.id] = terms.length;
    totalLen += terms.length;
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) {
      let arr = postings.get(t);
      if (!arr) {
        arr = [];
        postings.set(t, arr);
      }
      arr.push({ id: c.id, tf: n });
    }
  }
  return { chunks, postings, docLen, avgLen: totalLen / Math.max(1, chunks.length), k1, b };
}

// Async variant of buildBM25: identical output, but yields to the event loop every
// `yieldEvery` chunks. Building the index over a large corpus (tens of thousands of
// chunks) is otherwise a single synchronous pass that freezes the TUI; the yields keep
// the terminal responsive while the index is constructed on first use / after ingest.
export async function buildBM25Async(
  chunks: LexicalChunk[],
  k1 = 1.2,
  b = 0.75,
  yieldEvery = 400,
): Promise<BM25Index> {
  const postings = new Map<string, Array<{ id: number; tf: number }>>();
  const docLen = new Int32Array(chunks.length);
  let totalLen = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const terms = tokenize(c.text);
    docLen[c.id] = terms.length;
    totalLen += terms.length;
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) {
      let arr = postings.get(t);
      if (!arr) {
        arr = [];
        postings.set(t, arr);
      }
      arr.push({ id: c.id, tf: n });
    }
    if ((i + 1) % yieldEvery === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return { chunks, postings, docLen, avgLen: totalLen / Math.max(1, chunks.length), k1, b };
}

export function bm25Search(
  index: BM25Index,
  query: string,
  kk: number,
  allowed: (id: number) => boolean,
): Array<{ id: number; score: number }> {
  const N = index.chunks.length;
  const scores = new Map<number, number>();
  for (const t of new Set(tokenize(query))) {
    const postings = index.postings.get(t);
    if (!postings) continue;
    const df = postings.length;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const { id, tf } of postings) {
      if (!allowed(id)) continue;
      const len = index.docLen[id] || 1;
      const denom = tf + index.k1 * (1 - index.b + (index.b * len) / index.avgLen);
      const s = idf * ((tf * (index.k1 + 1)) / denom);
      scores.set(id, (scores.get(id) || 0) + s);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, kk)
    .map(([id, score]) => ({ id, score }));
}
