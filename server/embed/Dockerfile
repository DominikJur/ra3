# Reference embedding server (FlagEmbedding BGE-M3).
# CPU image by default. For a GPU box, build with:
#   docker build --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu121 -t ra3-embed .
FROM python:3.12-slim

# torch index: CPU by default; override for CUDA (see README).
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

WORKDIR /app

# Install torch first from the chosen index (the rest of requirements then reuses it).
RUN pip install --no-cache-dir torch --index-url ${TORCH_INDEX}

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY embed-server.py .

# Bind 0.0.0.0 inside the container so `docker run -p 8001:8001` works.
ENV EMBED_HOST=0.0.0.0

EXPOSE 8001
CMD ["python", "embed-server.py"]
