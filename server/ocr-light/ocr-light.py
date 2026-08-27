# Light OCR server: Tesseract (text-only, no VLM, no GPU).
#
# A CPU-friendly drop-in for the heavy GPU OCR server (Marker 2 / Surya 2). It implements the SAME contract
# (POST /file_parse -> {"results": {<stem>: {"md_content": ...}}}) that lib/ocr.ts expects, so
# the client is agnostic: point OCR_BASE_URL at this server instead of the GPU one.
#
# VULNERABILITIES (on purpose: this trades fidelity for lightness; see ocr-light/README.md):
#   - NO math/formula recognition: equations, symbols, sub/superscripts come out as garbage.
#   - NO table structure: tables are flattened into running text.
#   - NO reading-order guarantee: multi-column layouts may be read column-by-column or
#     interleaved, scrambling the text.
#   - English only by default: other languages need a tesseract-ocr-<lang> pack + OCR_LANG.
#   - Quality falls off on low-DPI scans, handwriting, and stylized fonts.
#
# Good for: plain printed-text scans where math/layout fidelity does not matter.
import io
import os

import pymupdf
import pytesseract
from PIL import Image
from fastapi import FastAPI, File, UploadFile

app = FastAPI()

OCR_DPI = int(os.environ.get("OCR_DPI", "300"))
OCR_PSM = os.environ.get("OCR_PSM", "3")  # 3 = fully automatic page segmentation
OCR_LANG = os.environ.get(
    "OCR_LANG", "eng"
)  # tesseract language pack (must be installed)


@app.get("/health")
def health():
    return {
        "ok": True,
        "ocr": "tesseract",
        "lang": OCR_LANG,
        "note": "text-only OCR; no math/table/layout fidelity",
    }


def rasterize_ocr(pdf_bytes: bytes) -> str:
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    parts: list[str] = []
    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=OCR_DPI)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        text = pytesseract.image_to_string(
            img, config=f"--oem 3 --psm {OCR_PSM} -l {OCR_LANG}"
        ).strip()
        # Page marker matches the format lib/ocr.ts splits on (<!-- page N -->).
        parts.append(f"<!-- page {i + 1} -->\n\n{text}")
    doc.close()
    return "\n\n".join(parts)


@app.post("/file_parse")
async def file_parse(files: list[UploadFile] = File(...)):
    # lib/ocr.ts also sends backend/parse_method/return_md/... form fields; we ignore them.
    out: dict[str, dict[str, str]] = {}
    for f in files:
        data = await f.read()
        name = f.filename or "doc"
        stem = name.rsplit(".", 1)[0] if "." in name else name
        out[stem] = {"md_content": rasterize_ocr(data)}
    return {"results": out}


if __name__ == "__main__":
    import uvicorn

    # 127.0.0.1 by default (safe, tunnel to reach it); OCR_HOST=0.0.0.0 to expose on a box.
    uvicorn.run(app, host=os.environ.get("OCR_HOST", "127.0.0.1"), port=8002)
