# Reference OCR server: MinerU 3.x (pipeline backend).
#
# HEAVY option. Installs torch + downloads PDF-Extract-Kit-1.0 models (~GBs). GPU strongly
# recommended. Good at math, tables, and layout; slow on CPU.
#
# Run:
#   docker build -t ra3-ocr .
#   docker run --gpus all -p 8002:8002 \
#     -v mineru-models:/models \
#     -v mineru-hf-cache:/root/.cache/huggingface \
#     ra3-ocr
#
# The model dir /models is a volume: on first run, download PDF-Extract-Kit-1.0 into it
# (see README) so it persists across restarts.
FROM python:3.12-slim

WORKDIR /app
ENV HOME=/root

# MinerU with all extras (large install; pulls torch).
RUN pip install --no-cache-dir "mineru[all]"

# Config: huggingface model source, pipeline models in /models (mounted volume).
COPY mineru.json /root/mineru.json

# Persist models + HF cache across restarts.
VOLUME ["/models", "/root/.cache/huggingface"]

# Bind 0.0.0.0 so `docker run -p 8002:8002` works. The API has NO auth: expose only behind a
# firewall/private network, or keep it local and tunnel.
EXPOSE 8002
CMD ["mineru-api", "--host", "0.0.0.0", "--port", "8002"]
