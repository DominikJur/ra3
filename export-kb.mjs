#!/usr/bin/env node
// Export the knowledge base to a portable single-file SQLite snapshot.
//
// Usage:
//   node export-kb.mjs <dest.sqlite[.gz]> [--gzip]
//
// Lossless: docs + chunks + dense + sparse vectors are copied verbatim, so the snapshot
// re-imports (import-kb.mjs / document_import_kb) without re-embedding.
import { exportKb } from "./extensions/deep-research/lib/kb-sqlite.ts";

const args = process.argv.slice(2);
const dest = args.find((a) => !a.startsWith("--"));
if (!dest) {
  console.error("Usage: node export-kb.mjs <dest.sqlite> [--gzip]");
  process.exit(1);
}
const res = await exportKb(dest, { gzip: args.includes("--gzip") });
console.log(JSON.stringify(res, null, 2));
