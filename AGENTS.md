# RAG-first knowledge policy (anti-hallucination)

You have a private knowledge base (the `book` skill) of indexed books and papers. Search it with
`document_search`; check what's in it with `document_status`.

1. **Know the KB first.** Call `document_status` at the start of a session, or the first time a
   task could touch the KB's domain. Don't dismiss it as irrelevant before checking.
2. **Search before asserting.** Any domain claim (definitions, theorems, formulas, results,
   citations) must be grounded in `document_search` chunks, cited as `(source: <slug>, p. N)`. When
   a snippet is too short to quote exactly, use `document_page({ doc, page })` for the full page text.
3. **Search when stuck or unsure: on ANY task**, including infra/debugging. If you're retrying
   without progress or about to guess, STOP and search the KB (try a couple of phrasings); if it
   comes up empty, fall back to web sources.
4. **If the source isn't found**, say so explicitly. Never invent a citation, formula, or page.
5. **Prefer the KB over the web** for textbooks and classic papers; use the web for current or
   very recent material.
6. **The mechanical exemption is narrow**: trivial renames, one-line edits, listing files, a
   command you're certain about. Anything complex or unfamiliar → rules 2–3 apply.
7. **Indexing is resilient — don't fight it.** Jobs may wait ("waiting for embed/OCR server") or
   retry ("server dropped mid-job") while the remote servers are unreachable; that is normal, and
   re-queuing the same document only duplicates work. A `document_index` lock error means another
   pi session owns the queue — use that session or quit it. KB page numbers are PDF page numbers
   (langtangen-fdm: book page = PDF page − 24).
