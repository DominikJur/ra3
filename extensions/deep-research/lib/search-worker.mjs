// Background search worker: runs the synchronous DB-heavy search off the main thread so the
// TUI stays responsive. Imports the real search (runSearchDocuments) and does everything here.
import { parentPort } from 'node:worker_threads';
import { runSearchDocuments } from './kb-sqlite.ts';

parentPort.on('message', async (msg) => {
  try {
    if (msg.type !== 'search') throw new Error(`unknown worker message type: ${msg.type}`);
    const result = await runSearchDocuments(msg.query, msg.opts ?? {});
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String(e?.message ?? e) });
  }
});
