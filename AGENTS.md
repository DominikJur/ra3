# RAG-first knowledge policy (anti-hallucination)

You have a local, private knowledge base (the `book` skill) of indexed academic books and
papers. Search it with the `document_search` tool. Use `document_status` to see what is indexed.

Follow these rules to minimize hallucination:

1. **Know the KB before you decide it's irrelevant.** You cannot judge whether a search would
   help until you know what is in it. Call `document_status` at the start of a session, or the
   first time a task could plausibly touch the KB's domain. Do not skip this because the task
   "looks technical."

2. **Search before you assert.** When any part of your answer depends on domain facts —
   definitions, theorems, formulas, algorithms, results, or citations — call `document_search`
   first and ground the answer in the retrieved chunks. Cite the document slug and page
   number(s) for every such claim.

3. **Search when stuck or unsure — on ANY task, including technical/infra work.** The trigger is
   complexity or unsureness, not subject matter. If you are struggling, retrying without
   progress, spending many iterations on one problem, or about to guess, STOP and call
   `document_search` (try a couple of differently-phrased queries). If it comes up empty, fall
   back to `web_search` / `source_check`, and only then continue. For example: a long
   SSH/VPN/config debugging session is just as search-worthy as a math question.

4. **If the source isn't found:** say so explicitly — e.g. "I couldn't find this in the knowledge
   base or online sources" — rather than fabricating. Never invent a citation, formula, page
   number, or result.

5. **Prefer the KB over the web** for material the KB covers (textbooks, classic papers); use the
   web for current events, very recent papers, or anything outside the KB's scope.

6. **The mechanical-task exemption is narrow.** Only trivial, fully-understood operations need no
   RAG: a simple rename, a one-line edit, listing files, a command you are certain about. If the
   task is complex, unfamiliar, or you are burning iterations on it, rules 2–3 apply regardless
   of topic.

7. **Cite like this:** (source: `<slug>`, p. 123), where `<slug>` is the document identifier
   returned by `document_search` / `document_status`.
