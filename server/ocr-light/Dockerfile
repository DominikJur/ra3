# Light OCR server — Tesseract (text-only, no GPU).
#
# Small, CPU-only OCR for scanned PDFs. Good with plain printed text; NO math/table/layout
# fidelity (see README). Same /file_parse contract as the heavy MinerU server.
#
# Run:
#   docker build -t ra3-ocr-light .
#   docker run -p 8002:8002 ra3-ocr-light
#
# Add more languages with: apt-get install tesseract-ocr-<lang> (then OCR_LANG=eng+<lang>).
FROM python:3.12-slim

# Tesseract + English language pack (default). Add e.g. tesseract-ocr-fra, -deu, -pol as needed.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ocr-light.py .

# Bind 0.0.0.0 inside the container so `docker run -p 8002:8002` works. No auth — firewall/tunnel.
ENV OCR_HOST=0.0.0.0

EXPOSE 8002
CMD ["python", "ocr-light.py"]
