// Shared helpers for the deep-research extension.
export const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
export const S2_API_KEY = process.env.S2_API_KEY ?? "";
export const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL ?? "pi-deep-research@users.noreply.github.com";
export const S2_FIELDS = "title,abstract,year,authors,citationCount,externalIds,openAccessPdf,url,tldr,publicationVenue";

export type Json = any;

export function s2Headers(): Record<string, string> {
  return S2_API_KEY ? { "x-api-key": S2_API_KEY } : {};
}

export async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  attempts = 4,
): Promise<Json> {
  let lastErr: unknown = new Error("fetch failed");
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal, redirect: "follow" });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if ((e as any)?.name === "AbortError") throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function fetchBuffer(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// Semantic Scholar allows 1 request/second cumulative across all endpoints.
// Serialize every S2 call and space starts by ≥1050 ms so we never trip a 429.
let s2LastCall = 0;
let s2Chain: Promise<unknown> = Promise.resolve();

export function s2FetchJson(url: string, signal?: AbortSignal, attempts = 2): Promise<Json> {
  const run = async (): Promise<Json> => {
    const wait = s2LastCall + 1050 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    s2LastCall = Date.now();
    return fetchJson(url, s2Headers(), signal, attempts);
  };
  const result = s2Chain.then(run, run);
  s2Chain = result.then(
    () => {},
    () => {},
  );
  return result;
}

export function compactPaper(p: Json): Json {
  const ext = p.externalIds ?? {};
  return {
    paperId: p.paperId ?? null,
    title: p.title ?? null,
    year: p.year ?? null,
    venue: p.publicationVenue ?? p.venue ?? null,
    authors: (p.authors ?? []).slice(0, 12).map((a: Json) => a.name),
    citationCount: p.citationCount ?? null,
    doi: ext.DOI ?? null,
    arxiv: ext.ArXiv ?? null,
    openAccessPdf: p.openAccessPdf?.url ?? null,
    url: p.url ?? null,
    abstract: (p.abstract ?? "").slice(0, 2500) || null,
    tldr: p.tldr?.text ?? null,
  };
}

export function stripXml(s: string): string {
  return (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function crossrefPaper(w: Json): Json {
  const issued = w.issued?.["date-parts"]?.[0];
  return {
    paperId: null,
    title: w.title?.[0] ?? null,
    year: issued?.[0] ?? null,
    venue: w["container-title"]?.[0] ?? null,
    authors: (w.author ?? []).map((a: Json) => [a.given, a.family].filter(Boolean).join(" ")),
    citationCount: w["is-referenced-by-count"] ?? null,
    doi: w.DOI ?? null,
    arxiv: null,
    openAccessPdf: null,
    url: w.DOI ? `https://doi.org/${w.DOI}` : (w.URL ?? null),
    abstract: stripXml(w.abstract ?? "").slice(0, 2500) || null,
    tldr: null,
  };
}

// Normalize a paper identifier to a bare DOI (or arXiv→DOI mapping) for Crossref lookups.
export function toDoi(id: string): string | null {
  let s = (id || "").trim().replace(/^DOI:\s*/i, "").replace(/^https?:\/\/doi\.org\//i, "");
  if (/^10\.\d{4,9}\/\S+$/.test(s)) return s;
  const arx = s.match(/^arXiv:\s*(\d{4}\.\d{4,5}(v\d+)?)$/i);
  if (arx) return `10.48550/arXiv.${arx[1]}`;
  return null;
}

export function crossrefRefPaper(r: Json): Json {
  const doi = r.DOI ?? null;
  const authors = typeof r.author === "string"
    ? [r.author]
    : (r.author ?? []).map((a: Json) => (typeof a === "string" ? a : a.name ?? a.family ?? ""));
  return {
    paperId: null,
    title: r["article-title"] ?? (typeof r.unstructured === "string" ? r.unstructured.slice(0, 200) : null),
    year: r.year ?? null,
    venue: r["volume-title"] ?? r["journal-title"] ?? null,
    authors,
    citationCount: null,
    doi,
    arxiv: null,
    openAccessPdf: null,
    url: doi ? `https://doi.org/${doi}` : null,
    abstract: null,
    tldr: null,
    citationText: r.unstructured ?? null,
  };
}

export async function resolvePdfUrl(doi: string): Promise<string | null> {
  const d = doi.trim().replace(/^https?:\/\/doi\.org\//i, "");
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(d)) return `https://arxiv.org/pdf/${d}`;
  try {
    const u = await fetchJson(
      `https://api.unpaywall.org/v2/${encodeURIComponent(d)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`,
    );
    const pdf = u.best_oa_location?.url_for_pdf || u.best_oa_location?.url;
    if (pdf) return pdf;
  } catch {
    /* continue */
  }
  try {
    const s = await s2FetchJson(
      `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(d)}?fields=openAccessPdf,externalIds,title`,
      undefined,
      1,
    );
    if (s.openAccessPdf?.url) return s.openAccessPdf.url;
    if (s.externalIds?.ArXiv) return `https://arxiv.org/pdf/${s.externalIds.ArXiv}`;
  } catch {
    /* continue */
  }
  return null;
}

function looksLikePdf(buf: Buffer): boolean {
  return buf.length >= 1024 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

export async function fetchPdfByDoi(doi: string, signal?: AbortSignal): Promise<Buffer> {
  const d = doi.trim().replace(/^https?:\/\/doi\.org\//i, "").replace(/^arXiv:/i, "");
  const candidates: string[] = [];
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(d)) candidates.push(`https://arxiv.org/pdf/${d}`);

  try {
    const u = await fetchJson(
      `https://api.unpaywall.org/v2/${encodeURIComponent(d)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`,
      {},
      signal,
      2,
    );
    const best = u?.best_oa_location?.url_for_pdf ?? u?.best_oa_location?.url;
    if (best) candidates.unshift(best);
    for (const loc of u?.oa_locations ?? []) {
      const l = loc?.url_for_pdf ?? loc?.url;
      if (l && l !== best) candidates.push(l);
    }
  } catch {
    /* continue */
  }

  try {
    const s = await s2FetchJson(
      `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(d)}?fields=openAccessPdf,externalIds`,
      undefined,
      1,
    );
    if (s?.openAccessPdf?.url) candidates.push(s.openAccessPdf.url);
    if (s?.externalIds?.ArXiv) candidates.push(`https://arxiv.org/pdf/${s.externalIds.ArXiv}`);
  } catch {
    /* continue */
  }

  try {
    const ep = await fetchJson(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22${encodeURIComponent(d)}%22&resultType=core&format=json`,
      {},
      signal,
      2,
    );
    const pmcid = ep?.resultList?.result?.[0]?.pmcid;
    if (pmcid) {
      candidates.push(`https://europepmc.org/articles/${pmcid}?pdf=render`);
      candidates.push(`https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/pdf/`);
    }
  } catch {
    /* continue */
  }

  const seen = new Set<string>();
  let lastErr = "";
  for (const url of candidates) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    try {
      const buf = await fetchBuffer(url, signal);
      if (looksLikePdf(buf)) return buf;
    } catch (e) {
      lastErr = (e as Error).message ?? String(e);
    }
  }
  throw new Error(`Could not fetch a PDF for DOI ${doi} (tried ${seen.size} source(s)); last error: ${lastErr}`);
}

export function slugify(s: string): string {
  return (s || "paper").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "paper";
}

export function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
