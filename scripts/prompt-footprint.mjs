#!/usr/bin/env node
// Measure RA³'s contribution to pi's system prompt (the text that gets injected into the
// agent's context): skills + policy files, plus the tool definition strings.
// Reproducible: `node scripts/prompt-footprint.mjs`
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1. Skills + policy: injected into the prompt verbatim.
const files = ['AGENTS.md', 'skills/book/SKILL.md', 'skills/deep-research/SKILL.md'];
let skillsChars = 0;
for (const f of files) skillsChars += readFileSync(path.join(root, f), 'utf8').length;

// 2. Tool definitions: extract the prompt-facing string fields per tool block
//    (balanced-brace scan, so one tool's text can never bleed into another's).
const src = readFileSync(path.join(root, 'extensions/deep-research/index.ts'), 'utf8');

function toolBlocks(source) {
  const blocks = [];
  let i = 0;
  while ((i = source.indexOf('pi.registerTool({', i)) !== -1) {
    let depth = 0;
    let j = i;
    for (; j < source.length; j++) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(i, j + 1));
    i = j + 1;
  }
  return blocks;
}

const q = `["']`;
const field = (block, name) => {
  const m = block.match(
    new RegExp(`${name}:\\s*${q}([\\s\\S]*?)${q}\\s*[,}\\\\]`, 'g'),
  );
  return m ? m.map((x) => x.match(new RegExp(`${q}([\\s\\S]*?)${q}\\s*$`))[1]).join('') : '';
};

let toolChars = 0;
const blocks = toolBlocks(src);
for (const b of blocks) {
  // description (up to promptSnippet), snippet, guidelines array, parameter names/descriptions
  const desc = b.match(
    new RegExp(`description:\\s*${q}([\\s\\S]*?)${q}\\s*,\\s*\\n\\s*promptSnippet:`),
  );
  const snip = b.match(new RegExp(`promptSnippet:\\s*${q}([^${q}]*?)${q}`));
  const guide = b.match(new RegExp(`promptGuidelines:\\s*\\[([\\s\\S]*?)\\],`));
  const params = b.match(/parameters:\s*Type\.Object\(\{([\s\S]*?)\}\)\)/);
  let paramChars = 0;
  if (params) {
    for (const pm of params[1].matchAll(new RegExp(`description:\\s*${q}([^${q}\\n]*)${q}`, 'g')))
      paramChars += pm[1].length;
    for (const nm of params[1].matchAll(/name:\s*["']([^"']*)["']/g)) paramChars += nm[1].length;
  }
  toolChars += (desc ? desc[1].length : 0) + (snip ? snip[1].length : 0) + (guide ? guide[1].length : 0) + paramChars;
}

const totalChars = skillsChars + toolChars;
const tokens = (n) => Math.round(n / 4);
console.log(`skills + policy (AGENTS.md + 2 SKILL.md): ${skillsChars} chars ≈ ${tokens(skillsChars)} tokens`);
console.log(`tool definitions (${blocks.length} tools, prompt fields): ${toolChars} chars ≈ ${tokens(toolChars)} tokens`);
console.log(`RA³ total system-prompt delta: ${totalChars} chars ≈ ${tokens(totalChars)} tokens`);
