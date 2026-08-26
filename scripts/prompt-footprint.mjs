#!/usr/bin/env node
// Measure RA³'s contribution to pi's system prompt (the text that gets injected into the
// agent's context): skills + policy files, plus the tool definition strings.
// Reproducible: `node scripts/prompt-footprint.mjs`
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 1. Skills + policy: injected into the prompt verbatim.
const files = ["AGENTS.md", "skills/book/SKILL.md", "skills/deep-research/SKILL.md"];
let skillsChars = 0;
for (const f of files) skillsChars += readFileSync(path.join(root, f), "utf8").length;

// 2. Tool definitions: extract the prompt-facing string fields from index.ts.
const src = readFileSync(path.join(root, "extensions/deep-research/index.ts"), "utf8");
const sum = (re) => { let t = 0; for (const m of src.matchAll(re)) t += m[1].length; return t; };
const toolChars =
  sum(/description:\s*"([\s\S]*?)"\s*,\n\s*promptSnippet:/g) + // tool descriptions
  sum(/promptSnippet:\s*"([^"]*)"/g) +                         // tool snippets
  sum(/promptGuidelines:\s*\[([\s\S]*?)\]\s*,/g) +             // tool guidelines
  sum(/description:\s*"([^"\n]*)"\s*\}\)/g) +                  // parameter descriptions
  sum(/name:\s*"([^"]*)"/g);                                   // tool names

const totalChars = skillsChars + toolChars;
const tokens = (n) => Math.round(n / 4);

console.log(`skills + policy (AGENTS.md + 2 SKILL.md): ${skillsChars} chars ≈ ${tokens(skillsChars)} tokens`);
console.log(`tool definitions (9 tools, prompt fields): ${toolChars} chars ≈ ${tokens(toolChars)} tokens`);
console.log(`RA³ total system-prompt delta: ${totalChars} chars ≈ ${tokens(totalChars)} tokens`);
