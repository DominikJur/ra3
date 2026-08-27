# Marker 2 / Surya 2 OCR server (recommended default OCR for RA³).
#
# GPU (vLLM, NVIDIA) is recommended; CPU (llama.cpp) works but is slower.
# Requires the NVIDIA Container Toolkit for `--gpus all`.
#
#   docker build -t ra3-ocr-marker .
#   docker run --gpus all -p 8002:8002 -v surya-cache:/root/.cache \
#     -e SURYA_INFERENCE_BACKEND=vllm -e SURYA_INFERENCE_KEEP_ALIVE=1 ra3-ocr-marker
#
# CPU: replace `vllm` below with a llama.cpp build (see README) and drop --gpus all.
FROM python:3.12-slim

WORKDIR /app

# PyTorch (CPU wheel by default; GPU users should use a CUDA torch build).
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# vLLM GPU backend for the Surya inference server (auto-spawned by marker).
RUN pip install --no-cache-dir vllm

COPY ocr-marker.py .

ENV SURYA_INFERENCE_BACKEND=vllm
ENV SURYA_INFERENCE_KEEP_ALIVE=1
ENV OCR_HOST=0.0.0.0

EXPOSE 8002
CMD ["python", "ocr-marker.py"]
