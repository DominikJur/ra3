// Demo retrieval: run the demo questions through the real knowledge base.
//
// Usage:
//   node demo/retrieve.mjs                              # run the default demo questions
//   node demo/retrieve.mjs "your question here"         # custom query
//
// Requires: node >= 22.5 (node:sqlite), `npm install` at the repo root, and an
// embedding server at EMBED_BASE_URL (default http://localhost:8001) serving
// BGE-M3 dense + sparse: the same build used to index the corpus.
import { searchDocuments } from "../extensions/deep-research/lib/kb-sqlite.ts";

const DEFAULT_Q = [
  "leapfrog scheme for the diffusion equation amplification factor unstable roots",
  "CFL condition leapfrog advection amplification factor stability C less than 1 amplitude reduction",
  "nonlinear diffusion equation Backward Euler Picard iteration Newton linearization explicit stability limit",
];

const questions = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_Q;

for (const q of questions) {
  console.log(`\n### QUERY: ${q}`);
  try {
    const res = await searchDocuments(q, { k: 4 });
    if (!res.results.length) {
      console.log("  (no results: index the demo book first, see demo/README.md)");
      continue;
    }
    for (const r of res.results) {
      console.log(
        `  (source: ${r.doc}, p. ${r.page}) [score ${r.score}] ${r.section}\n    ${r.snippet.replace(/\s+/g, " ").slice(0, 200)}`,
      );
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}
