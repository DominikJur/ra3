#!/usr/bin/env bash
# Fetch the demo corpus: "Finite Difference Computing with PDEs — A Modern Software
# Approach" (Langtangen & Linge, Springer 2017). The book is CC BY 4.0 — free to
# redistribute — and the compiled PDF lives on the author's companion site.
#
# NOTE: do NOT substitute the UDL (Prince) PDF — it is CC BY-NC-ND, not CC BY.
set -euo pipefail

OUT="${1:-books/langtangen_fdm.pdf}"
URL="${FDM_BOOK_URL:-https://hplgit.github.io/fdm-book/doc/pub/book/pdf/fdm-book-4print.pdf}"
# Alternative official OA mirror (OAPEN, CC BY): https://library.oapen.org/handle/20.500.12657/27809
# (may rate-limit scripts; the hplgit URL above is the reliable primary)

mkdir -p "$(dirname "$OUT")"
echo "Downloading demo corpus -> $OUT"
curl -fL --retry 3 -o "$OUT" "$URL"

# sanity: must be a PDF of plausible size (~5.7 MB)
head -c 5 "$OUT" | grep -q "%PDF-" || { echo "ERROR: download is not a PDF" >&2; exit 1; }
sz=$(stat -c %s "$OUT" 2>/dev/null || stat -f %z "$OUT")
[ "$sz" -gt 3000000 ] || { echo "ERROR: suspiciously small PDF ($sz bytes)" >&2; exit 1; }

echo "OK: $(basename "$OUT") ($sz bytes)"
echo "Index it with: document_index({ source: \"$(cygpath -m "$OUT" 2>/dev/null || echo "$OUT")\", name: \"langtangen-fdm\" })"
