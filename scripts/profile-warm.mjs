// Timing check with per-stage profile lines (worker stderr), single warm hybrid search.
import { searchDocuments } from '../extensions/deep-research/lib/kb-sqlite.ts';
const t0 = performance.now();
const res = await searchDocuments('leapfrog scheme diffusion equation amplification factor', { k: 10 });
console.log(`search: ${(performance.now() - t0).toFixed(0)}ms  dense=${res.dense} strength=${res.strength} results=${res.results.length}`);
console.log('  top:', res.results.slice(0, 3).map((r) => `${r.doc} p.${r.page} [${r.score}]`).join(' | '));
process.exit(0);
