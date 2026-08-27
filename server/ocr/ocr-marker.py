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
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from html import unescape
from fastapi import FastAPI, File, UploadFile

app = FastAPI()

# marker_single lives in the same venv as this server; resolve it explicitly so
# PATH doesn't matter.
MARKER_BIN = os.environ.get("MARKER_BIN") or os.path.join(
    os.path.dirname(sys.executable), "marker_single"
)
JOBS_DIR = os.environ.get("OCR_JOBS_DIR", os.path.expanduser("~/.ocr-jobs"))
os.makedirs(JOBS_DIR, exist_ok=True)
JOB_LOCK = threading.Lock()  # serialize marker runs: one GPU job at a time

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


def _run_job_worker(job_id: str, pdf_path: str, stem: str) -> None:
    try:
        _write_state(job_id, status="processing", startedAt=time.time())
        with JOB_LOCK:
            md = run_marker(pdf_path, os.path.join(_job_path(job_id), "out"), stem)
        _write_state(job_id, status="done", md_content=md, finishedAt=time.time())
    except subprocess.TimeoutExpired:
        _write_state(
            job_id, status="error", error=f"marker timeout after {OCR_TIMEOUT}s"
        )
    except Exception as e:  # noqa: BLE001
        _write_state(job_id, status="error", error=str(e))
    finally:
        # keep input.pdf for debugging; drop the marker output tree
        shutil.rmtree(os.path.join(_job_path(job_id), "out"), ignore_errors=True)


@app.post("/jobs")
async def create_job(files: list[UploadFile] = File(...)):
    job_id = uuid.uuid4().hex[:12]
    d = _job_path(job_id)
    os.makedirs(d, exist_ok=True)
    f = files[0]
    data = await f.read()
    name = f.filename or "doc.pdf"
    stem = name.rsplit(".", 1)[0] if "." in name else name
    pdf_path = os.path.join(d, "input.pdf")
    with open(pdf_path, "wb") as fh:
        fh.write(data)
    _write_state(job_id, status="queued", label=name, stem=stem, createdAt=time.time())
    threading.Thread(
        target=_run_job_worker, args=(job_id, pdf_path, stem), daemon=True
    ).start()
    return {"job_id": job_id, "status": "queued"}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    d = _job_path(job_id)
    if not os.path.isdir(d) or not re.fullmatch(r"[0-9a-f]{12}", job_id):
        return {"status": "not_found"}
    with open(os.path.join(d, "state.json"), encoding="utf-8") as fh:
        st = json.load(fh)
    # keep the response small: md_content only when done
    return {
        "job_id": job_id,
        "status": st.get("status"),
        "label": st.get("label"),
        "md_content": st.get("md_content"),
        "error": st.get("error"),
        "createdAt": st.get("createdAt"),
        "finishedAt": st.get("finishedAt"),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("OCR_HOST", "127.0.0.1"), port=8002)
