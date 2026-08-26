# OCR server: Tesseract (light, text-only)

A small, CPU-only OCR server for **scanned/image PDFs**, intended for users without a GPU who
only need the *text* of a scan. It is a drop-in for the heavy MinerU server: same
`POST /file_parse` contract, so `lib/ocr.ts` works against either: just set `OCR_BASE_URL` to
whichever you run.

> **Choose this when**: no GPU, and you care about the words but not the math/layout.
> **Choose `../ocr/` (MinerU) when**, you need math, formulas, tables, and reading order.

## Vulnerabilities (documented on purpose)

This server trades fidelity for lightness. It **will** mangle the following:

| input | behavior |
|---|---|
| **Math / formulas / equations** | ❌ garbage: symbols, Greek letters, sub/superscripts, fractions, integrals come out as nonsense or are dropped |
| **Tables** | ❌ flattened: cells are run together into prose; structure is lost |
| **Multi-column layout** | ⚠️ reading order may scramble: a two-column page can be read column-by-column or interleaved, mixing paragraphs |
| **Handwriting** | ❌ essentially unreadable |
| **Low-DPI scans / stylized fonts** | ⚠️ accuracy degrades sharply below ~200 dpi |

What it handles well: **plain printed text on clean scans** (books, articles, letters).

Because the extracted text is then *embedded and searched*, a math-heavy paper OCR'd by this
server will index its prose fine but lose its equations: those won't be retrievable, and any
question depending on a formula will miss. If math matters, use MinerU (`../ocr/`).

## Run

**Docker** (recommended):

```bash
docker build -t ra3-ocr-light .
docker run -p 8002:8002 ra3-ocr-light
```

**Local**:

```bash
apt-get install tesseract-ocr          # or your OS package manager
pip install -r requirements.txt
python ocr-light.py
```

Then:

```bash
export OCR_BASE_URL=http://localhost:8002
```

### Tuning

| env | default | meaning |
|---|---|---|
| `OCR_DPI` | `300` | rasterization resolution: lower for speed, higher for small text |
| `OCR_PSM` | `3` | Tesseract page-segmentation mode (3 = automatic; try 1 or 6 for dense text) |
| `OCR_LANG` | `eng` | language pack: add packs (`tesseract-ocr-<lang>`) and set e.g. `eng+pol` |

## Contract (same as `../ocr/`)

| endpoint | request | response |
|---|---|---|
| `GET /health` |: | `{"ok": true, "ocr": "tesseract", "lang": "eng"}` |
| `POST /file_parse` | multipart: `files` (PDF) + MinerU-style form fields (ignored) | `{"results": {"<stem>": {"md_content": "…"}}}` |

Output is markdown with `<!-- page N -->` markers, which `lib/ocr.ts` already knows how to split.
