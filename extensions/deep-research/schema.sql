-- Local knowledge base: docs + chunks + sqlite-vec dense vectors + learned-sparse terms.
-- Reference copy of the schema that lib/kb-sqlite.ts creates at runtime (single source of
-- truth is the inline SCHEMA in kb-sqlite.ts; this file documents it for readers/migrations).
-- WAL mode, single writer. Never open this file over an SMB share.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS docs (
  slug       TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  pages      INTEGER NOT NULL DEFAULT 0,
  chunks     INTEGER NOT NULL DEFAULT 0,
  hash       TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT 'bge-m3',
  dim        INTEGER NOT NULL DEFAULT 1024,
  lang       TEXT,                              -- 'en' | 'pl' | null (auto-detected)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  doc       TEXT NOT NULL REFERENCES docs(slug) ON DELETE CASCADE,
  page      INTEGER NOT NULL,
  section   TEXT NOT NULL DEFAULT '',
  text      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc  ON chunks(doc);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(doc, page);

-- Dense leg (sqlite-vec). chunk_id == chunks.chunk_id (1:1).
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_id  INTEGER PRIMARY KEY,
  embedding float[1024] distance_metric=cosine
);

-- Learned-sparse leg (BGE-M3 lexical weights): inverted index over chunk terms.
CREATE TABLE IF NOT EXISTS sparse_terms (
  chunk_id INTEGER NOT NULL,
  term     TEXT NOT NULL,
  weight   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sparse_term ON sparse_terms(term);
