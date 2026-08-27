# Marker 2 (Surya 2) OCR server — the recommended default OCR backend for RA³.
#
# Drop-in for MinerU's /file_parse contract: POST a PDF, get back markdown with LaTeX math
# ("tex everywhere"). Marker 2's balanced mode (Surya 2, 650M VLM) beats MinerU on olmOCR-bench
# (76.0 vs 72.7) and is ~5-10x faster on a 16 GB GPU.
#
# Contract (same as server/ocr/ and server/ocr-light/):
#   GET  /health            -> {"ok": true, "ocr": "marker/surya-2"}
#   POST /file_parse        multipart: files (PDF) -> {"results": {"<stem>": {"md_content": "..."}}}
#
# Runs marker_single --force_ocr so EVERY page is OCR'd through Surya (exact math, not just the
# PDF text layer). Requires the Surya inference backend: vLLM on NVIDIA GPUs (auto-spawned), or
# llama.cpp on CPU/Apple. See README.md.
import os
import subprocess
import tempfile
from fastapi import FastAPI, File, UploadFile

app = FastAPI()

OCR_TIMEOUT = int(os.environ.get("OCR_TIMEOUT", "3600"))  # seconds per file

@app.get("/health")
def health():
    return {"ok": True, "ocr": "marker/surya-2"}

def run_marker(pdf_path: str, out_dir: str, stem: str) -> str:
    # balanced mode on GPU; --force_ocr re-OCRs every page through the Surya VLM (LaTeX math).
    cmd = [
        "marker_single", pdf_path,
        "--output_dir", out_dir,
        "--output_format", "markdown",
        "--force_ocr",
    ]
    if os.environ.get("MARKER_MODE"):
        cmd += ["--mode", os.environ["MARKER_MODE"]]
    env = {**os.environ, "SURYA_INFERENCE_KEEP_ALIVE": "1"}
    subprocess.run(cmd, env=env, check=True, capture_output=True, timeout=OCR_TIMEOUT)

    # Marker writes <out_dir>/<stem>/<stem>.md (or <out_dir>/<stem>.md depending on version).
    cands = [
        os.path.join(out_dir, stem, f"{stem}.md"),
        os.path.join(out_dir, f"{stem}.md"),
    ]
    for c in cands:
        if os.path.exists(c):
            with open(c, encoding="utf-8") as fh:
                return fh.read()
    # Fallback: any .md in the output tree.
    for root, _dirs, files in os.walk(out_dir):
        for fn in files:
            if fn.endswith(".md"):
                with open(os.path.join(root, fn), encoding="utf-8") as fh:
                    return fh.read()
    return ""

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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("OCR_HOST", "127.0.0.1"), port=8002)
