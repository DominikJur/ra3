// Multi-process job queue backed by SQLite (WAL). Replaces the old single-owner
// JSON queue + lock file: ANY pi session can enqueue, and jobs are *claimed*
// transactionally (BEGIN IMMEDIATE + CAS update), so exactly one session runs
// each job — no lock errors, no double-indexing, no single-owner bottleneck.
//
// Lease model: the worker heartbeats every HEARTBEAT_MS while processing; a job
// whose heartbeat goes stale (crashed session, blocked loop) is requeued by any
// session (at-least-once delivery; the OCR checkpoint + reindex-replace make a
// rare double-run harmless).
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

export const QUEUE_DB_PATH =
  process.env.QUEUE_DB_PATH ?? path.join(os.homedir(), '.pi', 'agent', 'ra3-queue.sqlite');

const STALE_MS = 3 * 60 * 1000; // processing lease expiry

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  name TEXT,
  source TEXT NOT NULL,
  reindex INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | processing | done | error
  progress TEXT NOT NULL DEFAULT '',
  chunks INTEGER,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  owner INTEGER,
  heartbeat INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, next_attempt_at, id);
`;

let db: DatabaseSync | null = null;

export function getQueueDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(QUEUE_DB_PATH);
  db.exec(SCHEMA);
  return db;
}

export interface QueueJob {
  id: number;
  label: string;
  name?: string;
  source: string;
  reindex: boolean;
  status: string;
  progress: string;
  chunks?: number;
  error?: string;
  attempts: number;
  nextAttemptAt: number;
  owner?: number;
  createdAt: number;
  updatedAt: number;
}

function rowToJob(r: any): QueueJob {
  return {
    id: Number(r.id),
    label: String(r.label),
    name: r.name ? String(r.name) : undefined,
    source: String(r.source),
    reindex: !!r.reindex,
    status: String(r.status),
    progress: String(r.progress ?? ''),
    chunks: r.chunks != null ? Number(r.chunks) : undefined,
    error: r.error ? String(r.error) : undefined,
    attempts: Number(r.attempts ?? 0),
    nextAttemptAt: Number(r.next_attempt_at ?? 0),
    owner: r.owner != null ? Number(r.owner) : undefined,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function enqueueJob(job: { label: string; name?: string; source: string; reindex: boolean }): QueueJob {
  const d = getQueueDb();
  const now = Date.now();
  const r = d
    .prepare(
      `INSERT INTO jobs (label, name, source, reindex, status, progress, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 'queued', 0, 0, ?, ?)`,
    )
    .run(job.label, job.name ?? null, job.source, job.reindex ? 1 : 0, now, now);
  return { ...job, id: Number(r.lastInsertRowid), status: 'queued', progress: 'queued', attempts: 0, nextAttemptAt: 0, createdAt: now, updatedAt: now };
}

// Atomic claim: within BEGIN IMMEDIATE no other process can interleave, so the
// SELECT-then-UPDATE is a safe compare-and-swap. Exactly one session wins.
export function claimNextJob(): QueueJob | null {
  const d = getQueueDb();
  const now = Date.now();
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = d
      .prepare("SELECT * FROM jobs WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT 1")
      .get(now);
    if (!row) {
      d.exec('ROLLBACK');
      return null;
    }
    d.prepare("UPDATE jobs SET status = 'processing', owner = ?, heartbeat = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(
      process.pid,
      now,
      now,
      Number(row.id),
    );
    d.exec('COMMIT');
    return rowToJob(row);
  } catch (e) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* no-op */
    }
    throw e;
  }
}

export function updateJob(id: number, fields: Partial<Pick<QueueJob, 'status' | 'progress' | 'chunks' | 'error' | 'attempts' | 'nextAttemptAt'>>): void {
  const d = getQueueDb();
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = k === 'nextAttemptAt' ? 'next_attempt_at' : k;
    sets.push(`${col} = ?`);
    vals.push((v ?? null) as string | number | null);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  vals.push(Date.now());
  vals.push(id);
  d.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function heartbeatJob(id: number): void {
  const now = Date.now();
  getQueueDb()
    .prepare('UPDATE jobs SET heartbeat = ?, updated_at = ? WHERE id = ? AND status = ?')
    .run(now, now, id, 'processing');
}

// Lease expiry: requeue processing jobs whose owner stopped heartbeating.
// Returns the number of jobs requeued.
export function requeueStaleJobs(): number {
  const d = getQueueDb();
  const now = Date.now();
  const staleBefore = now - STALE_MS;
  const r = d
    .prepare(
      `UPDATE jobs SET status = 'queued', progress = 're-queued (worker lost heartbeat)', next_attempt_at = ?, updated_at = ?
       WHERE status = 'processing' AND heartbeat < ?`,
    )
    .run(now, now, staleBefore);
  return Number(r.changes);
}

export function hasDueJobs(): boolean {
  const d = getQueueDb();
  const row = d
    .prepare("SELECT 1 FROM jobs WHERE status = 'queued' AND next_attempt_at <= ? LIMIT 1")
    .get(Date.now());
  return !!row;
}

export function listActiveJobs(): QueueJob[] {
  const d = getQueueDb();
  return (
    d
      .prepare("SELECT * FROM jobs WHERE status IN ('queued', 'processing') ORDER BY id")
      .all() as any[]
  ).map(rowToJob);
}

export function listRecentJobs(n = 20): QueueJob[] {
  const d = getQueueDb();
  return (
    d
      .prepare("SELECT * FROM jobs WHERE status IN ('done', 'error') ORDER BY id DESC LIMIT ?")
      .all(n) as any[]
  ).map(rowToJob);
}

// One-time migration from the legacy JSON queue file (~/.pi/agent/ra3-queue.json).
// Queued/processing jobs resume; retryable errors resurrect (same semantics as
// the old restoreQueue); done/error history is preserved. The JSON is renamed
// out of the way so the old file can never be re-read.
export function migrateLegacyQueueFile(): void {
  const legacy = path.join(os.homedir(), '.pi', 'agent', 'ra3-queue.json');
  const { existsSync, renameSync } = require('node:fs') as typeof import('node:fs');
  if (!existsSync(legacy)) return;
  try {
    const jobs = JSON.parse(require('node:fs').readFileSync(legacy, 'utf8')) as any[];
    if (!Array.isArray(jobs)) return;
    const RETRY_RE =
      /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|AbortError|timed out|timeout|unreachable|Could not fetch|HTTP 5\d\d|OCR request failed|embed HTTP|no markdown content/i;
    const d = getQueueDb();
    const ins = d.prepare(
      `INSERT INTO jobs (id, label, name, source, reindex, status, progress, chunks, error, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    d.exec('BEGIN IMMEDIATE');
    try {
      for (const j of jobs) {
        let status = String(j.status ?? 'queued');
        if (status === 'processing') {
          status = 'queued'; // interrupted: resume
        } else if (status === 'error') {
          // storm-killed (network) errors resurrect; genuine errors stay history
          status = RETRY_RE.test(String(j.error ?? '')) ? 'queued' : 'error';
        }
        const now = Date.now();
        ins.run(
          Number(j.id),
          String(j.label ?? 'job'),
          j.name ? String(j.name) : null,
          String(j.source ?? ''),
          j.reindex ? 1 : 0,
          status,
          status === 'queued' ? String(j.progress ?? 'queued (migrated)') : String(j.progress ?? ''),
          j.chunks != null ? Number(j.chunks) : null,
          j.error ? String(j.error) : null,
          Number(j.attempts ?? 0),
          0,
          Number(j.queuedAt ?? now),
          now,
        );
      }
      d.exec('COMMIT');
    } catch (e) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* no-op */
      }
      throw e;
    }
    renameSync(legacy, `${legacy}.migrated-${Date.now()}`);
  } catch {
    /* best-effort migration; never break startup */
  }
}

export function queueStats(): { active: number; queued: number; processing: number } {
  const d = getQueueDb();
  const active = Number((d.prepare("SELECT count(*) c FROM jobs WHERE status IN ('queued','processing')").get() as any).c);
  const queued = Number((d.prepare("SELECT count(*) c FROM jobs WHERE status = 'queued'").get() as any).c);
  const processing = Number((d.prepare("SELECT count(*) c FROM jobs WHERE status = 'processing'").get() as any).c);
  return { active, queued, processing };
}
