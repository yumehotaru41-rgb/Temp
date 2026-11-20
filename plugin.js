// Kino plugin: Hanime1 (hanime1.me) — hentai listing, search and playback.
// apiVersion 4: "streamHosts": "any" covers the video/image CDNs. Single ES
// module — QuickJS sandbox rules apply (URL, atob, TextEncoder ok; no DOM).
//
// Parsing is based on the markup hanime1.me serves (validated against the
// Han1meViewer client parsers), but the selectors do not depend on fragile
// wrapper classes: every playable card is an anchor whose href contains
// /watch?v=<numeric code>, the cover is the first <img> in/around that anchor
// and the title is the .title element or the image alt.

const MIRRORS = ["https://hanime1.me", "https://hanime1.com", "https://hanimeone.me", "https://javchu.com"];
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36";
const BASE_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.6",
};

// Rows shown in Home. Sin censura is required and first; the rest follow
// the site's own genre taxonomy. Every row is a search query, so "ver más"
// paginates the full page size of the site.
const ROWS = [
  { title: "Sin censura", genre: "無修正" },
  { title: "里番 (Hentai anime)", genre: "裏番" },
  { title: "Pao Mian Fan (Cortos)", genre: "泡麵番" },
  { title: "Motion Anime", genre: "動態動畫" },
  { title: "3D", genre: "3D動畫" },
  { title: "2D", genre: "2D動畫" },
  { title: "Generado por IA", genre: "AI生成" },
  { title: "MMD", genre: "MMD" },
  { title: "Cosplay", genre: "Cosplay" },
];
// Simplified + traditional variants tried in order (the site serves zh-TW,
// but some CDNs/proxies return zh-CN markup).
const GENRE_FALLBACK = { "無修正": "无修正", "裏番": "里番", "泡麵番": "泡面番", "動態動畫": "动态动画", "3D動畫": "3D动画", "2D動畫": "2D动画" };
const MAX_ROW_ITEMS = 16;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function log(...args) {
  try { kino.log(...args); } catch { /* lost log lines are fine */ }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => { const n = parseInt(d, 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; })
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] !== undefined ? ENTITIES[name] : m);
}
function stripTags(s) { return decodeEntities(String(s).replace(/<[^>]*>/g, " ")); }
function cleanText(s) { return stripTags(s).replace(/\s+/g, " ").trim(); }
function absolute(base, url) {
  try { return new URL(url, base).href; } catch { return url; }
}
function attr(tag, name) {
  const m = new RegExp(name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')").exec(tag);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : "";
}

// Ads: hanime1.me marks promo banners with 廣告/广告 or AD; drop those titles.
function isAd(title) {
  if (!title) return true;
  return /廣告|广告|^AD[\s:_-]|^\[[^\]]*\]\s*$/.test(title);
}

// ---- fetch across mirrors, with Cloudflare detection -----------------------

function isCloudflare(text) {
  return /just a moment|challenge-platform|attention required|cf-browser-verification|you have been blocked|cf-chl/i.test(text);
}

async function fetchPage(pathOrUrl) {
  for (const base of MIRRORS) {
    const full = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : base + (pathOrUrl.charAt(0) === "/" ? pathOrUrl : "/" + pathOrUrl);
    try {
      const r = await kino.fetch(full, { headers: BASE_HEADERS, timeoutMs: 20000 });
      if (r.status === 403 || r.status === 503) { log("blocked", full, r.status); continue; }
      if (!r.ok) { log("fetch", full, "status", r.status); continue; }
      const text = r.text();
      if (isCloudflare(text)) { log("cloudflare challenge on", base); continue; }
      return text;
    } catch (e) { log("fetch failed", full, e && e.message); }
  }
  return null;
}

// ---- listing parsing -------------------------------------------------------

// Extracts cards from any listing (home rows, search results). Card anatomy:
//   <a ... href="https://watch?v=CODE"> ... <img src="cover"> ...
// Every playable card is an anchor to /watch?v=<numeric code>; the cover is
// the first <img> inside the anchor and the title comes from a class
// containing "title", or the image alt.
function parseList(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="([^"]*(?:\/watch\?v=|%2Fwatch%3Fv%3D)(\d{2,12})[^"]*)"[^>]*>([\s\S]{0,2500}?)<\/a>/g;
  let m = re.exec(html);
  while (m) {
    const code = m[2];
    const inner = m[3];
    m = re.exec(html);
    if (!code || seen.has(code)) continue;
    let cover = "";
    const imgTag = /<img\b[^>]*>/i.exec(inner);
    if (imgTag) {
      cover = attr(imgTag[0], "data-src") || attr(imgTag[0], "src") || attr(imgTag[0], "data-original");
    }
    let title = "";
    const tDiv = /class=(?:"[^"]*title[^"]*"|'[^']*title[^']*')[^>]*>([^<]+)/i.exec(inner);
    if (tDiv) title = cleanText(tDiv[1]);
    if (!title) {
      const alt = imgTag ? attr(imgTag[0], "alt") : "";
      if (alt) title = cleanText(alt);
    }
    if (!title) title = cleanText(inner).slice(0, 200);
    if (!title || isAd(title)) continue;
    seen.add(code);
    out.push({
      id: code,
      ref: MIRRORS[0] + "/watch?v=" + code,
      title: title.slice(0, 200),
      kind: "movie",
      adult: true,
      poster: cover ? absolute(MIRRORS[0], stripTags(cover)) : undefined,
    });
  }
  return out;
}

// Total pages of a listing: the site hides it in the "jump to page" form
// <input id="skip-page-input" oninput="validateNumberInput(this, 1, 232)">.
function parseMaxPage(html) {
  const m = /id="skip-page-input"[^>]*oninput="validateNumberInput\(this,\s*\d+,\s*(\d+)\)"/.exec(html);
  if (m) return parseInt(m[1], 10) || 1;
  const pages = [];
  const re = /[?&]page=(\d+)/g;
  let p = re.exec(html);
  while (p) { pages.push(parseInt(p[1], 10)); p = re.exec(html); }
  return pages.length ? Math.max.apply(null, pages) : 1;
}

function searchUrl(query, genre, page) {
  let url = "/search?query=" + encodeURIComponent(query || "");
  if (genre) url += "&genre=" + encodeURIComponent(genre);
  url += "&page=" + page;
  return url;
}

// A row ref is JSON: {"genre": "...", "q": ""} or {"q": "text"}.
function rowRef(row) {
  return JSON.stringify({ q: row.query || "", genre: row.genre || "" });
}
function parseRef(ref) {
  try { return JSON.parse(String(ref)); } catch { return { q: String(ref) }; }
}

// ---- Home ------------------------------------------------------------------
// Rows come from the site's own genre taxonomy (stable search endpoints), so
// nothing depends on the home page's shifting shelf order. Sin censura first,
// then the main genres.

export async function home() {
  const rows = [];
  for (const row of ROWS) {
    let html = await fetchPage(searchUrl("", row.genre, 1));
    let items = html ? parseList(html) : [];
    if (!items.length && GENRE_FALLBACK[row.genre]) {
      html = await fetchPage(searchUrl("", GENRE_FALLBACK[row.genre], 1));
      items = html ? parseList(html) : [];
    }
    if (items.length) {
      rows.push({
        id: "row-" + row.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        title: row.title,
        items: items.slice(0, MAX_ROW_ITEMS),
        ref: rowRef({ genre: (items.length || !GENRE_FALLBACK[row.genre]) ? row.genre : GENRE_FALLBACK[row.genre] }),
      });
    }
  }
  return rows;
}

// ---- Browse ("ver más") ----------------------------------------------------
// Pages the site's search/genre endpoint; next stays defined until the last
// page reported by the site itself (skip-page-input / pagination links).

export async function browse(ref, cursor) {
  const parsed = parseRef(ref);
  const page = cursor ? parseInt(String(cursor), 10) || 1 : 1;
  const html = await fetchPage(searchUrl(parsed.q, parsed.genre, page));
  if (!html) return { items: [], next: undefined };
  const items = parseList(html);
  const maxPage = parseMaxPage(html);
  return { items, next: items.length && page < maxPage ? String(page + 1) : undefined };
}

// ---- Search ----------------------------------------------------------------
// Returns the full first page (the site's max page size) plus cursor support.

export async function search(query) {
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  const cursor = query && query.cursor ? parseInt(String(query.cursor), 10) || 1 : 1;
  const html = await fetchPage(searchUrl(q, null, cursor));
  if (!html) return [];
  return parseList(html);
}

// ---- Resolve ---------------------------------------------------------------
// Watch pages embed one <video id="player"> with <source size="720" src="...">
// per quality. Every source is collected, sorted by height, one is picked per
// the quality setting and the rest are handed to Kino as alternatives (works
// on phone and TV; the URL only needs a UA header — no cookies).
const QUALITY_LABEL = { best: "mejor", auto: "auto", "1080": "1080p", "720": "720p", "480": "480p", "360": "360p", worst: "baja" };
const MEDIA_CDN = "vdownload.hembed.com";
const MEDIA_CDN_BACKUP = "1497203185.rsc.cdn77.org";

function pickSource(sources, wanted) {
  sources.sort(function (a, b) { return b.height - a.height; });
  if (!sources.length) return null;
  if (!wanted || wanted === "auto") return sources[0];
  if (wanted === "best") return sources[0];
  if (wanted === "worst") return sources[sources.length - 1];
  const h = parseInt(wanted, 10) || 0;
  let chosen = null;
  let bestDelta = Infinity;
  for (const s of sources) {
    const d = Math.abs(s.height - h);
    if (d < bestDelta) { bestDelta = d; chosen = s; }
  }
  return chosen;
}

export async function resolve(ref) {
  const url = String(ref);
  const html = await fetchPage(url);
  if (!html) {
    throw kino.error("not_found", "No se pudo abrir la página del video en hanime1.me (posible bloqueo de Cloudflare, prueba otra red o VPN)", { userMessage: "No se pudo abrir la página del video en hanime1.me" });
  }

  // Sources from <video id="player">: <source size="720" src="...">.
  const sources = [];
  const videoTag = /<video\b[^>]*id="player"[^>]*>([\s\S]*?)<\/video>/i.exec(html);
  const scope = videoTag ? videoTag[1] : html;
  const re = /<source\b[^>]*>/gi;
  let s = re.exec(scope);
  while (s) {
    const src = attr(s[0], "src");
    const size = parseInt(attr(s[0], "size"), 10) || 0;
    const type = attr(s[0], "type");
    if (src && /^https?:|^\/\//.test(src)) {
      sources.push({ height: size, url: absolute(url, decodeEntities(src).replace(/\\\//g, "/")), type: type || "" });
    }
    s = re.exec(scope);
  }
  if (!sources.length) {
    // Fallback: some pages render a single "const source = 'URL'" script.
    const sm = /const\s+source\s*=\s*["']([^"']+)["']/.exec(html) || /["'](https?:\/\/[^"'\s<]+\.(?:m3u8|mp4)[^"'\s<]*)["']/.exec(html);
    if (sm) sources.push({ height: 0, url: stripTags(sm[sm.length - 1]).replace(/\\\//g, "/").replace(/&amp;/g, "&"), type: "" });
  }
  const wanted = String(kino.config.get("quality") || "best");
  const best = pickSource(sources, wanted);
  if (!best) {
    throw kino.error("not_found", "El video no expuso ninguna fuente reproducible", { userMessage: "No se encontró la transmisión de este video" });
  }

  const alternatives = [];
  for (const s of sources) {
    if (s.url !== best.url) alternatives.push({ url: s.url, label: s.height ? s.height + "p" : "alternativa" });
    if (s.url.indexOf(MEDIA_CDN) !== -1) {
      alternatives.push({ url: s.url.replace(MEDIA_CDN, MEDIA_CDN_BACKUP), label: (s.height ? s.height + "p " : "") + "CDN alternativo" });
    }
  }

  const titleM = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html) || /id="shareBtn-title"[^>]*>([\s\S]*?)</.exec(html);
  const label = titleM ? cleanText(titleM[1]).slice(0, 200) : "";

  const streamHeaders = { "User-Agent": UA, "Referer": MIRRORS[0] + "/" };
  const isHls = /\.m3u8/i.test(best.url);
  return {
    url: best.url,
    mime: isHls ? "application/x-mpegURL" : (best.type || "video/mp4"),
    headers: streamHeaders,
    title: label || undefined,
    label: QUALITY_LABEL[wanted] ? "Calidad: " + QUALITY_LABEL[wanted] : undefined,
    alternatives,
  };
}