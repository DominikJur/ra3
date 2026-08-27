#!/usr/bin/env node
// Import a KB snapshot into the live knowledge base.
//
// Usage:
//   node import-kb.mjs <src.sqlite[.gz]> [--replace]
//
// Merges by default (existing slugs are skipped); --replace overwrites them. Vectors are
// copied verbatim: no re-embedding.
import { importKb } from "./extensions/deep-research/lib/kb-sqlite.ts";

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith("--"));
if (!src) {
  console.error("Usage: node import-kb.mjs <src.sqlite[.gz]> [--replace]");
  process.exit(1);
}
const res = await importKb(src, { replace: args.includes("--replace") });
console.log(JSON.stringify(res, null, 2));
