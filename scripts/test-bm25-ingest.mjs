// Unit test: BM25 table maintenance on ingest (scratch KB via KB_ROOT env var).
// Run as: KB_ROOT=C:/Users/Dominik/pi_research/kbtest node scripts/test-bm25-ingest.mjs
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
if (!process.env.KB_ROOT) {
  console.error('Refusing to run: KB_ROOT not set (this test writes a scratch KB).');
  console.error('Use: KB_ROOT=C:/path/to/kbtest node scripts/test-bm25-ingest.mjs');
  process.exit(1);
}
const kb = await import('../extensions/deep-research/lib/kb-sqlite.ts');
const { ingestChunks, listDocuments } = kb;
rmSync(process.env.KB_ROOT, { recursive: true, force: true });

const D = 1024;
const vec = (seed) => {
  const v = new Float32Array(D);
  for (let i = 0; i < D; i++) v[i] = Math.sin(seed * 1000 + i) * 0.01;
  return v;
};
const mk = (texts) => ({
  chunks: texts.map((t, i) => ({ page: i + 1, section: 's', text: t })),
  dense: texts.map((_, i) => vec(i)),
  sparse: texts.map(() => new Map()),
});

const q = (sql, ...args) => {
  const d = new DatabaseSync(process.env.KB_ROOT + '/kb.sqlite', { readOnly: true });
  const r = d.prepare(sql).all(...args).map((row) => Object.values(row));
  d.close();
  return r;
};

// doc A: 2 chunks with known words
ingestChunks({ slug: 'doctest-a', source: 'a.pdf', pages: 2, ...mk(['the quick brown fox jumps', 'lazy dog sleeps']) });
// doc B: 1 chunk
ingestChunks({ slug: 'doctest-b', source: 'b.pdf', pages: 1, ...mk(['quick fox again']) });

console.log('meta after 2 docs:', JSON.stringify(q('SELECT * FROM bm25_meta')));
console.log('postings:', JSON.stringify(q('SELECT term, id, tf FROM bm25_postings ORDER BY term')));
console.log('n =', q('SELECT count(*) c FROM chunks')[0][0], 'postings rows =', q('SELECT count(*) c FROM bm25_postings')[0][0], 'doclen rows =', q('SELECT count(*) c FROM bm25_doclen')[0][0]);

// re-ingest doc A with different text (old chunk ids change → replace path)
ingestChunks({ slug: 'doctest-a', source: 'a.pdf', pages: 2, ...mk(['completely different words here']) });

console.log('meta after re-ingest A:', JSON.stringify(q('SELECT * FROM bm25_meta')));
console.log('postings:', JSON.stringify(q('SELECT term, id, tf FROM bm25_postings ORDER BY term')));
console.log('n =', q('SELECT count(*) c FROM chunks')[0][0], 'postings rows =', q('SELECT count(*) c FROM bm25_postings')[0][0]);
const orphaned = q('SELECT p.term FROM bm25_postings p LEFT JOIN chunks c ON c.chunk_id = p.id WHERE c.chunk_id IS NULL');
console.log('orphaned postings (should be []):', JSON.stringify(orphaned));
console.log('docs:', listDocuments().map((x) => x.slug));
process.exit(0);
