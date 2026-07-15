import { useState } from "react";

// ── DocFinder ──────────────────────────────────────────────────
// Document-only metasearch: PDFs, slide decks, Word docs.
// Talks to your Cloudflare Worker (see worker/worker.js), which
// handles the SearXNG queries, caching, and CORS.
// Ranking = Reciprocal Rank Fusion + a boost for direct file links.

const FONT_LINK = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap";
const K = 60;
const DIRECT_FILE_BOOST = 1.4; // direct .pdf/.pptx/.docx links rank higher

const TYPE_CHIPS = [
  { key: "pdf", label: "PDF" },
  { key: "ppt", label: "Slides" },
  { key: "doc", label: "Word" },
  { key: "xls", label: "Excel" },
];

const TYPE_COLORS = {
  pdf: "#C0332B", ppt: "#D4700E", pptx: "#D4700E",
  doc: "#2743F0", docx: "#2743F0", xls: "#0E8A6D", xlsx: "#0E8A6D",
};

// Build a browser-based preview link so users can read a document
// without downloading it to their device.
// Office files → Microsoft's Office Online viewer; PDFs and
// everything else → Google Docs viewer.
const OFFICE_EXTS = ["ppt", "pptx", "doc", "docx", "xls", "xlsx"];
function previewUrl(fileUrl, filetype) {
  const enc = encodeURIComponent(fileUrl);
  if (OFFICE_EXTS.includes(filetype)) {
    return `https://view.officeapps.live.com/op/view.aspx?src=${enc}`;
  }
  return `https://docs.google.com/viewer?url=${enc}&embedded=false`;
}

const DEMO_RESULTS = [
  { title: "Attention Is All You Need (research paper)", url: "https://arxiv.org/pdf/1706.03762.pdf", content: "The paper that introduced the transformer architecture.", engines: ["google", "bing", "duckduckgo"], positions: [1, 1, 2], filetype: "pdf", is_direct_file: true },
  { title: "Intro to Machine Learning — lecture slides", url: "https://example.edu/ml-course/lecture1.pptx", content: "University lecture deck covering supervised learning basics.", engines: ["google", "duckduckgo"], positions: [3, 2], filetype: "pptx", is_direct_file: true },
  { title: "Machine learning overview page", url: "https://example.com/ml-guide", content: "A web page about machine learning that links to several PDFs.", engines: ["bing"], positions: [2], filetype: "pdf", is_direct_file: false },
  { title: "ML project report template", url: "https://example.org/templates/report.docx", content: "A downloadable Word template for writing project reports.", engines: ["duckduckgo", "qwant"], positions: [4, 1], filetype: "docx", is_direct_file: true },
];

function fuseResults(rawResults) {
  const byUrl = new Map();
  rawResults.forEach((r, listIndex) => {
    if (!byUrl.has(r.url)) byUrl.set(r.url, { ...r, engineRanks: [], score: 0 });
    const entry = byUrl.get(r.url);
    const engines = r.engines?.length ? r.engines : ["unknown"];
    const positions = Array.isArray(r.positions) && r.positions.length === engines.length
      ? r.positions
      : engines.map(() => listIndex + 1);
    engines.forEach((eng, i) => {
      const rank = positions[i] ?? listIndex + 1;
      entry.engineRanks.push({ engine: eng, rank });
      entry.score += 1 / (K + rank);
    });
  });
  for (const entry of byUrl.values()) {
    if (entry.is_direct_file) entry.score *= DIRECT_FILE_BOOST;
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score);
}

export default function DocFinder() {
  const [workerUrl, setWorkerUrl] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState(["pdf", "ppt", "doc"]);
  const [status, setStatus] = useState("idle");
  const [results, setResults] = useState([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const toggleType = (key) => {
    setTypes((prev) =>
      prev.includes(key)
        ? prev.length > 1 ? prev.filter((t) => t !== key) : prev
        : [...prev, key]
    );
  };

  const runDemo = () => {
    setResults(fuseResults(DEMO_RESULTS));
    setNote("Demo data — add your Worker URL above to search live.");
    setStatus("done");
    setError("");
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q) {
      setError("Type what you're looking for in the search box first.");
      setStatus("error");
      return;
    }
    if (!workerUrl.trim()) {
      runDemo();
      setNote("No Worker URL set — showing demo data. Tap Settings below to connect your Worker for live results.");
      return;
    }

    setStatus("searching");
    setError("");
    setNote("");
    setResults([]);

    try {
      const base = workerUrl.trim().replace(/\/+$/, "");
      const res = await fetch(
        `${base}/search?q=${encodeURIComponent(q)}&types=${types.join(",")}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const raw = data.results || [];
      if (!raw.length) {
        setNote("No documents found — try broader terms or more file types.");
        setStatus("done");
        return;
      }
      const fused = fuseResults(raw);
      setResults(fused);
      setNote(`${fused.length} documents, fused from ${raw.length} raw results.`);
      setStatus("done");
    } catch (err) {
      console.error(err);
      setError("Couldn't reach the Worker. Check the URL (it should look like https://docfinder.yourname.workers.dev) and that SEARXNG_URL is set in the Worker's settings.");
      setStatus("error");
    }
  };

  const hostname = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return url; }
  };

  const maxScore = results.length ? results[0].score : 1;

  return (
    <div style={styles.page}>
      <link rel="stylesheet" href={FONT_LINK} />

      <header style={styles.header}>
        <div style={styles.mark}>▤</div>
        <h1 style={styles.title}>DocFinder</h1>
        <p style={styles.tagline}>search the web's documents, not its pages</p>
      </header>

      <div style={styles.searchRow}>
        <input
          style={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          placeholder="Search for reports, papers, decks…"
          aria-label="Search query"
          autoFocus
        />
        <button
          style={{ ...styles.button, opacity: status === "searching" ? 0.6 : 1 }}
          onClick={runSearch}
          disabled={status === "searching"}
        >
          {status === "searching" ? "Searching…" : "Search"}
        </button>
      </div>

      <div style={styles.chipRow}>
        {TYPE_CHIPS.map((c) => {
          const on = types.includes(c.key);
          return (
            <button
              key={c.key}
              onClick={() => toggleType(c.key)}
              style={{
                ...styles.chip,
                background: on ? "#14161C" : "#FFF",
                color: on ? "#FFF" : "#62687A",
                borderColor: on ? "#14161C" : "#D8DAE0",
              }}
              aria-pressed={on}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <button style={styles.settingsToggle} onClick={() => setShowSettings(!showSettings)}>
        {showSettings ? "Hide settings" : workerUrl ? "Settings · Worker connected" : "Settings · connect your Worker"}
      </button>
      {showSettings && (
        <div style={styles.settingsBox}>
          <label style={styles.settingsLabel} htmlFor="worker-url">
            Cloudflare Worker URL — where this site gets live results.
            Leave blank to use demo data.
          </label>
          <input
            id="worker-url"
            style={{ ...styles.input, fontSize: 14 }}
            value={workerUrl}
            onChange={(e) => setWorkerUrl(e.target.value)}
            placeholder="https://docfinder.yourname.workers.dev"
            aria-label="Cloudflare Worker URL"
          />
        </div>
      )}

      {status === "error" && (
        <div style={styles.errorBox}>
          <p style={{ margin: 0 }}>{error}</p>
          <button style={styles.demoButton} onClick={runDemo}>Preview with demo data</button>
        </div>
      )}

      {note && status === "done" && <p style={styles.note}>{note}</p>}

      {status === "done" && results.length > 0 && (
        <main style={{ marginTop: 16 }}>
          {results.map((r, i) => (
            <div key={r.url} style={styles.resultCard}>
              <div style={styles.scoreCol}>
                <div style={styles.rankNum}>{i + 1}</div>
                <div style={styles.scoreBarTrack}>
                  <div style={{ ...styles.scoreBarFill, height: `${(r.score / maxScore) * 100}%` }} />
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.resultTopRow}>
                  <span
                    style={{
                      ...styles.typeBadge,
                      background: TYPE_COLORS[r.filetype] || "#62687A",
                    }}
                  >
                    {(r.filetype || "file").toUpperCase()}
                  </span>
                  <span style={styles.resultHost}>{hostname(r.url)}</span>
                  {r.is_direct_file && <span style={styles.directTag}>direct file</span>}
                </div>
                <a
                  href={r.is_direct_file ? previewUrl(r.url, r.filetype) : r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.resultTitle}
                >
                  {r.title}
                </a>
                <div style={styles.resultSnippet}>{r.content}</div>
                {r.is_direct_file && (
                  <div style={styles.actionRow}>
                    <a
                      href={previewUrl(r.url, r.filetype)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={styles.previewLink}
                    >
                      Preview in browser
                    </a>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={styles.downloadLink}
                    >
                      Download file
                    </a>
                  </div>
                )}
                <div style={styles.badgeRow}>
                  {r.engineRanks.map((er, j) => (
                    <span key={j} style={styles.engineBadge} title={`${er.engine} ranked this #${er.rank}`}>
                      {er.engine} #{er.rank}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
          <p style={styles.disclaimer}>
            Files are hosted by third-party sites, not DocFinder. Preview in
            browser when possible, and be careful with downloaded files —
            especially ones asking you to enable macros.
          </p>
        </main>
      )}

      {status === "idle" && (
        <div style={styles.hint}>
          <p style={{ margin: "0 0 10px" }}>
            <strong>Why documents?</strong> Reports, research papers, and lecture decks
            carry denser, better-sourced information than SEO'd web pages — but general
            search buries them. DocFinder searches only files, ranks by engine consensus,
            and boosts direct downloads.
          </p>
          <button style={styles.demoButton} onClick={runDemo}>Try it with demo data</button>
        </div>
      )}

      <style>{`
        input::placeholder { color: #9AA0AE; }
        a:focus-visible, button:focus-visible { outline: 3px solid #2743F0; outline-offset: 2px; }
      `}</style>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh", background: "#F7F7F3", color: "#14161C",
    fontFamily: "'Space Grotesk', system-ui, sans-serif",
    padding: "44px 20px 80px", maxWidth: 760, margin: "0 auto",
  },
  header: { textAlign: "center", marginBottom: 28 },
  mark: { fontSize: 32, color: "#2743F0", lineHeight: 1 },
  title: { fontSize: 38, fontWeight: 700, letterSpacing: "-0.02em", margin: "8px 0 4px" },
  tagline: { color: "#62687A", fontSize: 15, margin: 0 },
  searchRow: { display: "flex", gap: 10 },
  input: {
    flex: 1, width: "100%", boxSizing: "border-box", fontSize: 17,
    fontFamily: "inherit", padding: "13px 16px",
    border: "2px solid #14161C", borderRadius: 12, background: "#FFF", outline: "none",
  },
  button: {
    fontSize: 16, fontFamily: "inherit", fontWeight: 500, padding: "0 22px",
    border: "none", borderRadius: 12, background: "#2743F0", color: "#FFF", cursor: "pointer",
  },
  chipRow: { display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" },
  settingsToggle: {
    marginTop: 14, fontSize: 13, fontFamily: "inherit", fontWeight: 500,
    background: "none", border: "none", color: "#62687A",
    textDecoration: "underline", cursor: "pointer", padding: 0,
  },
  settingsBox: {
    marginTop: 10, background: "#FFF", border: "1px solid #E4E5E9",
    borderRadius: 12, padding: "14px 16px",
  },
  settingsLabel: {
    display: "block", fontSize: 13, color: "#62687A",
    lineHeight: 1.5, marginBottom: 8,
  },
  chip: {
    fontSize: 14, fontFamily: "inherit", fontWeight: 500,
    padding: "7px 16px", border: "2px solid", borderRadius: 999, cursor: "pointer",
  },
  errorBox: {
    marginTop: 18, background: "#FFF", border: "1px solid #E8B4B0",
    borderLeft: "4px solid #C0332B", borderRadius: 12, padding: "14px 16px",
    fontSize: 14, lineHeight: 1.55, color: "#3C4150",
  },
  note: { marginTop: 14, fontSize: 13, color: "#62687A" },
  resultCard: {
    display: "flex", gap: 14, background: "#FFF", border: "1px solid #E4E5E9",
    borderRadius: 12, padding: "14px 16px", marginBottom: 10,
  },
  scoreCol: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6 },
  rankNum: { fontSize: 15, fontWeight: 700 },
  scoreBarTrack: {
    width: 6, flex: 1, minHeight: 40, background: "#EDEEF0",
    borderRadius: 3, display: "flex", alignItems: "flex-end", overflow: "hidden",
  },
  scoreBarFill: { width: "100%", background: "#2743F0", borderRadius: 3 },
  resultTopRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" },
  typeBadge: {
    fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
    color: "#FFF", padding: "2px 7px", borderRadius: 5,
  },
  resultHost: { fontSize: 12, color: "#62687A" },
  directTag: { fontSize: 11, color: "#0E8A6D", fontWeight: 500 },
  resultTitle: {
    fontSize: 16, fontWeight: 500, color: "#2743F0", textDecoration: "none",
    display: "block", marginBottom: 4, wordBreak: "break-word",
  },
  resultSnippet: { fontSize: 14, color: "#3C4150", lineHeight: 1.5, marginBottom: 8 },
  badgeRow: { display: "flex", gap: 6, flexWrap: "wrap" },
  actionRow: { display: "flex", gap: 14, marginBottom: 8, flexWrap: "wrap" },
  previewLink: {
    fontSize: 13, fontWeight: 500, color: "#FFF", background: "#0E8A6D",
    padding: "5px 12px", borderRadius: 8, textDecoration: "none",
  },
  downloadLink: {
    fontSize: 13, fontWeight: 500, color: "#62687A",
    padding: "5px 4px", textDecoration: "underline",
  },
  disclaimer: {
    fontSize: 12, color: "#9AA0AE", lineHeight: 1.5,
    marginTop: 14, textAlign: "center",
  },
  engineBadge: {
    fontSize: 11, fontWeight: 500, padding: "2px 8px",
    border: "1.5px solid #D8DAE0", borderRadius: 999, color: "#62687A", background: "#FFF",
  },
  hint: {
    marginTop: 26, background: "#FFF", border: "1px solid #E4E5E9",
    borderRadius: 12, padding: "16px 18px", fontSize: 14, color: "#3C4150", lineHeight: 1.6,
  },
  demoButton: {
    marginTop: 10, fontSize: 14, fontFamily: "inherit", fontWeight: 500,
    padding: "8px 16px", border: "2px solid #14161C", borderRadius: 10,
    background: "#F7F7F3", color: "#14161C", cursor: "pointer",
  },
};
