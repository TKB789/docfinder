// ── DocFinder Worker ───────────────────────────────────────────
// A free Cloudflare Worker that sits between your frontend and
// your SearXNG instance. It:
//   1. Rewrites queries into document-only searches (filetype:pdf etc.)
//   2. Fans out one search per file type in parallel and merges them
//   3. Caches results for 15 minutes (repeat searches are instant,
//      and upstream engines don't rate-limit you)
//   4. Adds CORS headers so your GitHub Pages site can call it
//
// Required setting (added in the Cloudflare dashboard, see README):
//   SEARXNG_URL = https://your-searxng-instance.example.com
// Optional setting:
//   SAFE_BROWSING_KEY = your free Google Safe Browsing API key.
//   When set, every result URL is checked against Google's live
//   malware/phishing blocklist and flagged URLs are removed.

const FILE_TYPES = {
  pdf: ["pdf"],
  ppt: ["ppt", "pptx"],
  doc: ["doc", "docx"],
  xls: ["xls", "xlsx"],
};

const CACHE_SECONDS = 900; // 15 minutes

// ── Safety filters ─────────────────────────────────────────────
// Domains you never want in results. Add entries as you spot bad
// actors, e.g. "sketchy-downloads.example". Subdomains are blocked too.
const BLOCKED_DOMAINS = [
  // "example-bad-site.com",
];

function isBlocked(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol !== "https:") return true; // HTTPS-only
    return BLOCKED_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith("." + d)
    );
  } catch {
    return true; // unparseable URL → drop it
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    const url = new URL(request.url);
    if (url.pathname !== "/search") {
      return withCors(json({ error: "Use /search?q=your+query&types=pdf,ppt,doc" }, 404));
    }

    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return withCors(json({ error: "Missing q parameter" }, 400));
    if (!env.SEARXNG_URL) return withCors(json({ error: "SEARXNG_URL is not configured" }, 500));

    // ── 1. Serve from cache when possible ──────────────────────
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = new Response(cached.body, cached);
      hit.headers.set("X-Cache", "HIT");
      return withCors(hit);
    }

    // ── 2. Build one query per requested file type ──────────────
    const requested = (url.searchParams.get("types") || "pdf,ppt,doc")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => FILE_TYPES[t]);
    const types = requested.length ? requested : ["pdf"];

    const base = env.SEARXNG_URL.replace(/\/+$/, "");
    const searches = types.map((t) => {
      // one representative extension per type keeps engines happy;
      // modern engines match .docx when you ask for filetype:doc
      const ext = FILE_TYPES[t][0];
      const target = `${base}/search?q=${encodeURIComponent(`${q} filetype:${ext}`)}&format=json`;
      return fetch(target, { headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((data) => ({ type: t, results: data.results || [] }))
        .catch(() => ({ type: t, results: [] }));
    });

    const batches = await Promise.all(searches);

    // ── 3. Merge, tag, and lightly filter ───────────────────────
    const ALL_EXTS = Object.values(FILE_TYPES).flat();
    const merged = [];
    for (const batch of batches) {
      for (const r of batch.results) {
        if (!r.url || isBlocked(r.url)) continue; // safety filter
        const ext = extOf(r.url);
        merged.push({
          title: r.title,
          url: r.url,
          content: r.content || "",
          engines: r.engines || (r.engine ? [r.engine] : []),
          positions: r.positions,
          publishedDate: r.publishedDate || null,
          filetype: ALL_EXTS.includes(ext) ? ext : batch.type,
          is_direct_file: ALL_EXTS.includes(ext),
        });
      }
    }

    // ── 4. Google Safe Browsing filter (if key is configured) ───
    const flagged = await flaggedBySafeBrowsing(
      merged.map((r) => r.url),
      env.SAFE_BROWSING_KEY
    );
    const safe = flagged.size ? merged.filter((r) => !flagged.has(r.url)) : merged;

    const body = json({
      query: q,
      types,
      count: safe.length,
      removed_by_safe_browsing: flagged.size,
      safe_browsing_active: Boolean(env.SAFE_BROWSING_KEY),
      results: safe,
    });
    body.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
    body.headers.set("X-Cache", "MISS");

    ctx.waitUntil(cache.put(cacheKey, body.clone()));
    return withCors(body);
  },
};

// ── Google Safe Browsing check ─────────────────────────────────
// Sends all result URLs in ONE batch request to Google's Lookup API
// and returns the set of URLs flagged as malware/phishing/unwanted
// software. Fails open: if the API errors, no results are dropped
// (your HTTPS + blocklist filters still apply).
async function flaggedBySafeBrowsing(urls, apiKey) {
  if (!apiKey || urls.length === 0) return new Set();
  try {
    const res = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "docfinder", clientVersion: "1.0" },
          threatInfo: {
            threatTypes: [
              "MALWARE",
              "SOCIAL_ENGINEERING",
              "UNWANTED_SOFTWARE",
              "POTENTIALLY_HARMFUL_APPLICATION",
            ],
            platformTypes: ["ANY_PLATFORM"],
            threatEntryTypes: ["URL"],
            threatEntries: urls.slice(0, 500).map((u) => ({ url: u })),
          },
        }),
      }
    );
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set((data.matches || []).map((m) => m.threat?.url).filter(Boolean));
  } catch {
    return new Set();
  }
}

function extOf(u) {
  try {
    const path = new URL(u).pathname.toLowerCase();
    const m = path.match(/\.([a-z0-9]{2,5})$/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(resp) {
  const r = new Response(resp.body, resp);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return r;
}
