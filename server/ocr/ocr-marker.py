# Marker 2 (Surya 2) OCR server — the OCR backend for RA³.
#
# Runs marker_single --force_ocr (Surya 2 VLM, exact LaTeX math on every page) and returns
# per-page markdown with <!-- page N --> markers, so the client's page splitter (lib/ocr.ts)
# produces correct KB page numbers (Marker's flat markdown output has no page markers, so we
# reconstruct per-page markdown from Marker's JSON block tree, which carries a page number in
# every node id: /page/N/...).
#
# Contract (same as server/ocr-light/):
#   GET  /health            -> {"ok": true, "ocr": "marker/surya-2"}
#   POST /file_parse        multipart: files (PDF) -> {"results": {"<stem>": {"md_content": "..."}}}
#
# Inference backend: Surya talks to an OpenAI-compatible /v1/chat/completions server.
#   SURYA_INFERENCE_URL  (default http://127.0.0.1:8000/v1) — set this to your vLLM server;
#   SURYA_INFERENCE_BACKEND (default vllm). With SURYA_INFERENCE_URL set, no spawning happens.
# See server/ocr/README.md for the full server deployment.
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
import gzip
import sqlite3
from html import unescape
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import FileResponse

app = FastAPI()

# marker_single lives in the same venv as this server; resolve it explicitly so
# PATH doesn't matter.
MARKER_BIN = os.environ.get("MARKER_BIN") or os.path.join(
    os.path.dirname(sys.executable), "marker_single"
)
JOBS_DIR = os.environ.get("OCR_JOBS_DIR", os.path.expanduser("~/.ocr-jobs"))
os.makedirs(JOBS_DIR, exist_ok=True)
JOB_LOCK = threading.Lock()  # serialize marker runs: one GPU job at a time
EMBED_URL = os.environ.get("EMBED_BASE_URL", "http://127.0.0.1:8001")
DIM = 1024

# ---- local pipeline: chunk + embed + per-doc KB bundle ----------------------
# The KB bundle is a small SQLite file with the SAME schema as the client's
# kb.sqlite (docs/chunks/vec_chunks vec0/sparse_terms), gzipped. The client
# imports it with importKb() — no chunking/embedding needed on the returning
# machine: "we just get back the KB entries".

def split_sentences(text: str) -> list[str]:
    out: list[str] = []
    for para in re.split(r"\n{2,}", text):
        t = para.strip()
        if not t:
            continue
        parts = re.split(r"(?<=[.!?;:])\s+(?=[A-Z0-9(\"'])", t)
        for p in parts:
            s = p.strip()
            if s:
                out.append(s)
    return out


def markdown_to_sections(md: str) -> list[dict]:
    """Split per-page markdown (with <!-- page N --> markers, as this server
    emits) into sections — mirrors the client's markdownToSections."""
    sections: list[dict] = []
    parts = re.split(r"<!--\s*page\s*(\d+)\s*-->", md)
    for i in range(1, len(parts) - 1, 2):
        try:
            page = int(parts[i])
        except ValueError:
            page = 1
        text = (parts[i + 1] or "").strip()
        if text:
            sections.append({"heading": "", "page": page, "text": text})
    if not sections:
        sections.append({"heading": "", "page": 1, "text": md.strip()})
    return sections


def sections_page_guess(md: str) -> int:
    return max((s["page"] for s in markdown_to_sections(md)), default=1)


def chunk_sections(sections: list[dict], max_len: int = 2000) -> list[dict]:
    """Faithful port of lib/chunk.ts chunkSections (sentence-aware, heading-prefixed)."""
    chunks: list[dict] = []
    for sec in sections:
        heading = sec.get("heading") or "(preamble)"
        sentences = split_sentences(sec.get("text") or "")
        if not sentences:
            continue
        cur: list[str] = []
        cur_len = 0

        def flush() -> None:
            nonlocal cur, cur_len
            if not cur:
                return
            prefix = (sec.get("heading") + "\n\n") if sec.get("heading") else ""
            chunks.append(
                {"page": sec.get("page", 1), "section": heading, "text": prefix + " ".join(cur)}
            )
            cur, cur_len = [], 0

        for s in sentences:
            if cur_len + len(s) > max_len and cur:
                flush()
            cur.append(s)
            cur_len += len(s)
        flush()
    return chunks


def embed_texts(texts: list[str]) -> tuple[list[list[float]], list[dict]]:
    """Embed via the local BGE-M3 server (same manifold as the client's KB).
    Returns (dense 1024-d lists, sparse {term: weight} dicts)."""
    dense: list[list[float]] = []
    sparse: list[dict] = []
    B = 32
    for i in range(0, len(texts), B):
        batch = texts[i : i + B]
        payload = json.dumps({"texts": batch, "return_sparse": True}).encode()
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                req = urllib.request.Request(
                    f"{EMBED_URL}/embed", data=payload, headers={"content-type": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=180) as resp:
                    j = json.loads(resp.read())
                dense.extend(j["dense"])
                sparse.extend(j.get("sparse") or [{}] * len(batch))
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt == 2:
                    raise RuntimeError(f"embed failed: {last_err}") from last_err
                time.sleep(2 * (attempt + 1))
    return dense, sparse


def build_kb_bundle(job_id: str, stem: str, slug: str, source_name: str, sections: list[dict], page_count: int) -> str:
    """Chunk + embed + write gz-zipped per-doc KB sqlite; returns the bundle path."""
    try:
        import sqlite_vec  # noqa: PLC0415  (installed in the marker venv)
    except ImportError as e:
        raise RuntimeError("sqlite-vec python package missing (uv pip install sqlite-vec)") from e

    chunks = chunk_sections(sections)
    if not chunks:
        raise RuntimeError("no chunks produced")
    dense, sparse = embed_texts([c["text"] for c in chunks])

    bundle_dir = os.path.join(_job_path(job_id), "kb")
    os.makedirs(bundle_dir, exist_ok=True)
    raw = os.path.join(bundle_dir, f"{slug}.sqlite")
    gz = raw + ".gz"
    if os.path.exists(raw):
        os.remove(raw)
    if os.path.exists(gz):
        os.remove(gz)

    conn = sqlite3.connect(raw)
    try:
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.executescript(
            """
            CREATE TABLE docs (slug TEXT PRIMARY KEY, source TEXT NOT NULL, pages INTEGER NOT NULL DEFAULT 0,
              chunks INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT 'bge-m3',
              dim INTEGER NOT NULL DEFAULT 1024, ocr TEXT NOT NULL DEFAULT 'unknown', lang TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE TABLE chunks (chunk_id INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL REFERENCES docs(slug) ON DELETE CASCADE,
              page INTEGER NOT NULL, section TEXT NOT NULL DEFAULT '', text TEXT NOT NULL);
            CREATE INDEX idx_chunks_doc ON chunks(doc);
            CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[1024] distance_metric=cosine);
            CREATE TABLE sparse_terms (chunk_id INTEGER NOT NULL, term TEXT NOT NULL, weight REAL NOT NULL);
            CREATE INDEX idx_sparse_term ON sparse_terms(term);
            """
        )
        import hashlib

        conn.execute(
            "INSERT INTO docs (slug, source, pages, chunks, hash, model, dim, ocr, lang) VALUES (?,?,?,?,?,?,?,?,?)",
            (slug, source_name, page_count, len(chunks), hashlib.md5(source_name.encode()).hexdigest()[:10], "bge-m3", DIM, "marker", None),
        )
        for i, c in enumerate(chunks):
            cur = conn.execute(
                "INSERT INTO chunks (doc, page, section, text) VALUES (?,?,?,?)",
                (slug, c["page"], c["section"], c["text"]),
            )
            cid = cur.lastrowid
            blob = struct.pack(f"<{DIM}f", *dense[i])
            conn.execute("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?,?)", (cid, blob))
            for term, w in (sparse[i] or {}).items():
                conn.execute(
                    "INSERT INTO sparse_terms (chunk_id, term, weight) VALUES (?,?,?)", (cid, term, float(w))
                )
        conn.commit()
    finally:
        conn.close()

    with open(raw, "rb") as fh_in, gzip.open(gz, "wb", compresslevel=6) as fh_out:
        shutil.copyfileobj(fh_in, fh_out)
    os.remove(raw)
    return gz

OCR_TIMEOUT = int(os.environ.get("OCR_TIMEOUT", "7200"))  # seconds per file

ENV = {
    **os.environ,
    "SURYA_INFERENCE_URL": os.environ.get(
        "SURYA_INFERENCE_URL", "http://127.0.0.1:8000/v1"
    ),
    "SURYA_INFERENCE_BACKEND": os.environ.get("SURYA_INFERENCE_BACKEND", "vllm"),
    "SURYA_INFERENCE_KEEP_ALIVE": "1",
}


@app.get("/health")
def health():
    return {"ok": True, "ocr": "marker/surya-2"}


# ---- per-page markdown reconstruction from Marker's JSON block tree -------


def _leaf_md(html: str) -> str:
    """Convert one content node's html fragment to markdown text."""
    if not html:
        return ""
    h = html
    # block math: <math display="block">\LaTeX</math>
    h = re.sub(
        r"<math[^>]*display=\"block\"[^>]*>(.*?)</math>",
        lambda m: f"\n$$\n{unescape(m.group(1)).strip()}\n$$\n",
        h,
        flags=re.S,
    )
    # inline math: <math>\LaTeX</math>
    h = re.sub(
        r"<math>(.*?)</math>",
        lambda m: f"${unescape(m.group(1)).strip()}$",
        h,
        flags=re.S,
    )
    # tables: rows/cells -> markdown-ish pipes
    h = re.sub(r"</tr>", "\n", h, flags=re.I)
    h = re.sub(r"</t[dh]>", " | ", h, flags=re.I)
    h = re.sub(r"<t[dh][^>]*>", "", h, flags=re.I)
    # bold / italic / line breaks / code-ish
    h = re.sub(r"<b>(.*?)</b>", r"**\1**", h, flags=re.S | re.I)
    h = re.sub(r"<i>(.*?)</i>", r"*\1*", h, flags=re.S | re.I)
    h = re.sub(r"<br\s*/?>", "\n", h, flags=re.I)
    # strip any remaining tags
    h = re.sub(r"<[^>]+>", "", h)
    return unescape(h).strip()


def tree_to_pages(root: dict) -> list[str]:
    """Walk Marker's JSON block tree, emit ['page 1 md', 'page 2 md', ...] (1-indexed)."""
    pages: dict[int, list[str]] = {}
    order: dict[int, int] = {}

    def walk(node: dict) -> None:
        nid = node.get("id") or ""
        m = re.match(r"/page/(\d+)/", nid)
        page = int(m.group(1)) + 1 if m else 1
        if page not in pages:
            pages[page] = []
            order[page] = len(pages)
        html = node.get("html") or ""
        children = node.get("children") or []
        if html:
            md = _leaf_md(html)
            if md and "content-ref" not in html:
                pages[page].append(md)
        for c in children:
            walk(c)

    walk(root)
    if not pages:
        return []
    return ["\n\n".join(pages[n]) for n in sorted(order, key=order.get)]


def run_marker(pdf_path: str, out_dir: str, stem: str) -> str:
    cmd = [
        MARKER_BIN,
        pdf_path,
        "--output_dir",
        out_dir,
        "--output_format",
        "json",
        "--force_ocr",
    ]
    if os.environ.get("MARKER_MODE"):
        cmd += ["--mode", os.environ["MARKER_MODE"]]
    subprocess.run(cmd, env=ENV, check=True, capture_output=True, timeout=OCR_TIMEOUT)

    # Marker writes <out_dir>/<stem>/<stem>.json (or <out_dir>/<stem>.json depending on version).
    cands = [
        os.path.join(out_dir, stem, f"{stem}.json"),
        os.path.join(out_dir, f"{stem}.json"),
    ]
    json_path = next((c for c in cands if os.path.exists(c)), None)
    if not json_path:
        for root, _dirs, files in os.walk(out_dir):
            for fn in files:
                if fn.endswith(".json") and not fn.endswith("_meta.json"):
                    json_path = os.path.join(root, fn)
                    break
            if json_path:
                break
    if not json_path:
        return ""

    with open(json_path, encoding="utf-8") as fh:
        tree = json.load(fh)
    page_mds = tree_to_pages(tree)
    if not page_mds:
        return ""
    # Emit <!-- page N --> markers so the client splitter assigns correct KB pages.
    return "\n\n".join(f"<!-- page {i + 1} -->\n{md}" for i, md in enumerate(page_mds))


@app.post("/file_parse")
async def file_parse(files: list[UploadFile] = File(...)):
    out: dict[str, dict[str, str]] = {}
    for f in files:
        data = await f.read()
        name = f.filename or "doc"
        stem = name.rsplit(".", 1)[0] if "." in name else name
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = os.path.join(tmp, f"{stem}.pdf")
            out_dir = os.path.join(tmp, "out")
            with open(pdf_path, "wb") as fh:
                fh.write(data)
            try:
                md = run_marker(pdf_path, out_dir, stem)
            except subprocess.TimeoutExpired:
                md = f"<!-- marker timeout after {OCR_TIMEOUT}s -->"
            except subprocess.CalledProcessError as e:
                md = f"<!-- marker failed: {e.stderr.decode('utf-8', 'replace')[:500]} -->"
            out[stem] = {"md_content": md}
    return {"results": out}


# ---- async jobs: one upload, server computes, client polls ------------------
# Storm-friendly: POST /jobs returns the job id immediately (short tunnel
# window), the work runs here regardless of the tunnel, and GET /jobs/{id}
# answers with tiny requests whenever the client can get through. Results and
# state are persisted under JOBS_DIR, so jobs survive a server restart too.


def _job_path(job_id: str) -> str:
    return os.path.join(JOBS_DIR, job_id)


def _write_state(job_id: str, **fields) -> None:
    p = os.path.join(_job_path(job_id), "state.json")
    try:
        st = {}
        if os.path.exists(p):
            with open(p, encoding="utf-8") as fh:
                st = json.load(fh)
        st.update(fields)
        st["updatedAt"] = time.time()
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(st, fh)
    except Exception:
        pass


def _load_state(job_id: str) -> dict:
    p = os.path.join(_job_path(job_id), "state.json")
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass
    return {}


def _run_job_worker(job_id: str) -> None:
    """Process every file of a (possibly multi-file) job serially; results are
    stored per stem: state.json -> {results: {<stem>: {md_content, kb_bundle?}}}.
    When the job was submitted with kb=1, each file is also chunked + embedded
    and shipped as a per-doc KB sqlite bundle (kb_bundle = relative path)."""
    try:
        _write_state(job_id, status="processing", startedAt=time.time())
        st = _load_state(job_id)
        files = st.get("files") or []
        want_kb = bool(st.get("kb"))
        slugs = st.get("slugs") or {}
        results = {}
        for i, fi in enumerate(files):
            stem = fi.get("stem") or "doc"
            pdf_path = os.path.join(_job_path(job_id), "input", f"{stem}.pdf")
            if not os.path.exists(pdf_path):
                results[stem] = {"md_content": f"<!-- input missing for {stem} -->"}
                continue
            _write_state(
                job_id, progress=f"file {i + 1}/{len(files)}: {fi.get('name', stem)}"
            )
            try:
                with JOB_LOCK:
                    md = run_marker(
                        pdf_path, os.path.join(_job_path(job_id), "out"), stem
                    )
                entry: dict = {"md_content": md}
                if want_kb:
                    try:
                        sections = markdown_to_sections(md)
                        slug = slugs.get(stem) or stem
                        bundle = build_kb_bundle(
                            job_id, stem, slug, fi.get("name", stem), sections, sections_page_guess(md)
                        )
                        entry["kb_bundle"] = os.path.relpath(bundle, _job_path(job_id)).replace("\\", "/")
                    except Exception as e:  # noqa: BLE001
                        entry["kb_error"] = str(e)
                results[stem] = entry
            except subprocess.TimeoutExpired:
                results[stem] = {
                    "md_content": f"<!-- marker timeout after {OCR_TIMEOUT}s -->"
                }
            except Exception as e:  # noqa: BLE001
                results[stem] = {"md_content": f"<!-- marker failed: {e} -->"}
            _write_state(
                job_id, results=results, progress=f"file {i + 1}/{len(files)} done"
            )
        _write_state(
            job_id,
            status="done",
            results=results,
            progress=f"{len(files)} file(s)",
            finishedAt=time.time(),
        )
    except Exception as e:  # noqa: BLE001
        _write_state(job_id, status="error", error=str(e))
    finally:
        shutil.rmtree(os.path.join(_job_path(job_id), "out"), ignore_errors=True)


# After a server restart, re-run jobs that were queued/processing (their input
# PDFs are persisted; marker is idempotent, so an already-OCR'd file is simply
# re-OCR'd).
def _resume_incomplete_jobs() -> None:
    try:
        for job_id in os.listdir(JOBS_DIR):
            if not re.fullmatch(r"[0-9a-f]{12}", job_id):
                continue
            st = _load_state(job_id)
            if st.get("status") in ("queued", "processing"):
                threading.Thread(
                    target=_run_job_worker, args=(job_id,), daemon=True
                ).start()
    except Exception:
        pass


_resume_incomplete_jobs()


@app.post("/jobs")
async def create_job(
    files: list[UploadFile] = File(...),
    kb: str = Form("0"),
    slugs: str = Form(""),
):
    """Multi-file async job: returns {job_id} immediately; files are OCR'd
    serially in the background (results keyed by filename stem). With kb=1,
    each file is additionally chunked + embedded and shipped as a per-doc KB
    sqlite bundle; slugs (JSON {stem: slug}) sets the KB slug per file."""
    job_id = uuid.uuid4().hex[:12]
    d = _job_path(job_id)
    os.makedirs(os.path.join(d, "input"), exist_ok=True)
    file_list: list[dict] = []
    for f in files:
        data = await f.read()
        name = f.filename or "doc.pdf"
        stem = name.rsplit(".", 1)[0] if "." in name else name
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", stem) or "doc"
        with open(os.path.join(d, "input", f"{safe}.pdf"), "wb") as fh:
            fh.write(data)
        file_list.append({"stem": safe, "name": name})
    slug_map: dict = {}
    try:
        slug_map = json.loads(slugs) if slugs else {}
    except Exception:
        slug_map = {}
    _write_state(
        job_id,
        status="queued",
        files=file_list,
        results={},
        kb=1 if kb in ("1", "true", "yes") else 0,
        slugs=slug_map,
        createdAt=time.time(),
    )
    threading.Thread(target=_run_job_worker, args=(job_id,), daemon=True).start()
    return {"job_id": job_id, "status": "queued", "files": len(file_list), "kb": bool(slug_map or kb in ("1", "true", "yes"))}


@app.get("/jobs")
async def list_jobs(status: str | None = None):
    """List persisted jobs (optionally filtered by status) — used by the client
    to discover finished work after the submitting machine was offline."""
    jobs: list[dict] = []
    try:
        for job_id in os.listdir(JOBS_DIR):
            if not re.fullmatch(r"[0-9a-f]{12}", job_id):
                continue
            st = _load_state(job_id)
            if not st:
                continue
            if status and st.get("status") != status:
                continue
            jobs.append(
                {
                    "job_id": job_id,
                    "status": st.get("status"),
                    "files": st.get("files", []),
                    "progress": st.get("progress"),
                    "error": st.get("error"),
                    "createdAt": st.get("createdAt"),
                    "finishedAt": st.get("finishedAt"),
                }
            )
    except Exception:
        pass
    jobs.sort(key=lambda j: j.get("createdAt") or 0)
    return {"jobs": jobs}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    d = _job_path(job_id)
    if not os.path.isdir(d) or not re.fullmatch(r"[0-9a-f]{12}", job_id):
        return {"status": "not_found"}
    with open(os.path.join(d, "state.json"), encoding="utf-8") as fh:
        st = json.load(fh)
    # keep the response small: md_content only when done; for single-file jobs
    # also keep the legacy top-level md_content so old clients keep working
    md_content = None
    results = st.get("results") or {}
    if st.get("status") == "done":
        keys = list(results.keys())
        if keys:
            md_content = results[keys[0]].get("md_content")
    return {
        "job_id": job_id,
        "status": st.get("status"),
        "label": st.get("label"),
        "files": st.get("files"),
        "results": results if st.get("status") == "done" else None,
        "md_content": md_content,
        "kb": st.get("kb"),
        "progress": st.get("progress"),
        "error": st.get("error"),
        "createdAt": st.get("createdAt"),
        "finishedAt": st.get("finishedAt"),
    }


@app.get("/jobs/{job_id}/kb/{slug}")
async def get_kb_bundle(job_id: str, slug: str):
    """Download a finished per-doc KB bundle (gzipped sqlite)."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", slug)
    path = os.path.join(_job_path(job_id), "kb", f"{safe}.sqlite.gz")
    if not os.path.isfile(path) or not re.fullmatch(r"[0-9a-f]{12}", job_id):
        return {"status": "not_found", "error": f"no KB bundle for {slug}"}
    return FileResponse(path, media_type="application/gzip", filename=f"{safe}.sqlite.gz")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("OCR_HOST", "127.0.0.1"), port=8002)
