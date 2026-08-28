#!/usr/bin/env node
// Fire-and-forget remote batch indexing (submit multiple PDFs to your server, close the
// PC, pull the results whenever you're back).
//
//   node remote-jobs.mjs submit <pdf...> [--name slug]
//   node remote-jobs.mjs status
//   node remote-jobs.mjs pull [--replace]
//
// submit: uploads all PDFs as ONE async job (returns immediately) and
//         records it in ~/.pi/agent/ra3-pending-jobs.json
// status: reports each pending job's state on the server
// pull:   fetches finished jobs, chunks + embeds + ingests them into kb.sqlite
//         (skips slugs already indexed unless --replace)
import { submitRemoteJob, remoteJobStatus, pullFinishedJobs, readPendingJobs } from './extensions/deep-research/lib/remote-jobs.ts';

const cmd = process.argv[2];
const args = process.argv.slice(3);

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

try {
  if (cmd === 'submit') {
    const pdfs = args.filter((a) => !a.startsWith('--'));
    if (!pdfs.length) throw new Error('usage: remote-jobs.mjs submit <pdf...> [--name slug]');
    const name = flag('--name');
    const { job_id, files } = await submitRemoteJob(pdfs, { name });
    console.log(`submitted ${files.length} file(s) as remote job ${job_id}`);
    console.log('your server will OCR, chunk, embed and build the KB entries in the background. You can close this PC.');
    console.log(`come back and run: node remote-jobs.mjs pull  (or in pi: document_pull)`);
    for (const f of files) console.log(`  ${f.name} -> KB slug "${f.slug}"`);
  } else if (cmd === 'status') {
    const pending = await readPendingJobs();
    if (!pending.length) {
      console.log('no pending remote jobs');
      process.exit(0);
    }
    for (const job of pending) {
      const label = job.pulled ? 'pulled' : 'pending';
      try {
        const st = await remoteJobStatus(job.job_id);
        console.log(
          `${job.job_id} [${label}] ${st.status}${st.progress ? ` — ${st.progress}` : ''} (${job.files.length} file(s))`,
        );
      } catch (e) {
        console.log(`${job.job_id} [${label}] unreachable: ${e.message}`);
      }
    }
  } else if (cmd === 'pull') {
    const replace = args.includes('--replace');
    const res = await pullFinishedJobs({ replace });
    console.log(`pulled: ${res.pulled.length ? res.pulled.join(' | ') : '(none)'}`);
    if (res.waiting.length) console.log(`still running on your server: ${res.waiting.join(' | ')} — run pull again later`);
    if (res.failed.length) console.log(`failed: ${res.failed.map((f) => `${f.job_id}: ${f.error}`).join(' | ')}`);
    if (!res.pulled.length && !res.failed.length) console.log('nothing new to pull');
  } else {
    throw new Error('usage: remote-jobs.mjs <submit|status|pull>');
  }
} catch (e) {
  console.error(`remote-jobs failed: ${e.message}`);
  process.exit(1);
}
