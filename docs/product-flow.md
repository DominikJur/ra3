# How it works

```mermaid
flowchart TB
    PDFS[("Your PDFs<br/>books, papers, scans")]

    PDFS --> OCR["OCR server<br/>Marker 2 / Surya 2<br/>exact LaTeX math on every page"]
    PDFS -. "fire-and-forget batch:<br/>submit once, server builds<br/>the KB entries while your<br/>PC is off" .-> OCR

    OCR --> PAGES["per-page markdown<br/>with correct page numbers"]
    PAGES --> CHUNK["sentence-aware chunking"]
    CHUNK --> EMBED["BGE-M3 embeddings<br/>dense 1024-d + learned-sparse"]
    EMBED --> KB[("kb.sqlite<br/>one portable file:<br/>docs, chunks, vectors")]

    KB --> SEARCH["hybrid search<br/>dense + BM25 + sparse<br/>RRF fusion + MMR rerank"]
    SEARCH --> CITED[("cited answers<br/>(source, page)<br/>verifiable, exact math")]

    KB --> STATUS["queue + status<br/>document_status / document_pull"]
```

Top to bottom: your PDFs become cited, verifiable answers with exact math. All the heavy
compute (OCR, embeddings) happens on **your own server**; the knowledge base stays one portable
SQLite file on your machine. Indexing is a background queue that survives outages and multiple
sessions, and the fire-and-forget path lets the server build the KB entries while your laptop is
off.
