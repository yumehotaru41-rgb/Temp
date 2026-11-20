
// Kino plugin: Jable (jable.tv) — JAV listing, search and HLS playback.
// apiVersion 4: only "streamHosts": "any" is needed (the m3u8 lives on CDNs
// Kino does not declare). Single ES module — QuickJS sandbox rules apply.

const SITE = "https://jable.tv";
const MIRRORS = ["https://jable.tv", "https://fs1.app"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const BASE_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.6",
};
// Home rows: "Sin censura" is required first, then the site's main shelves.
const ROWS = [
  { ref: "/categories/uncensored/", title: "Sin censura" },
  { ref: "/latest-updates/", title: "Últimas novedades" },
  { ref: "/hot/", title: "Populares" },
  { ref: "/categories/chinese-subtitle/", title: "Subtítulos en chino" },
];
const MAX_ROW_ITEMS = 16;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function log(...args) {
  try { kino.log(...args); } catch { /* the log line is lost, the result is not */ }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => { const n = parseInt(d, 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; })
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] !== undefined ? ENTITIES[name] : m);
}
function stripTags(s) { return decodeEntities(String(s).replace(/<[^>]*>/g, " ")); }
function cleanText(s) {
  return stripTags(s).replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
}
function videoUrlOf(href) {
  if (!href) return null;
  const m = /\/videos\/[^"?#]+\/?/.exec(href);
  if (!m) return null;
  return SITE + m[0];
}
// Ads on jable are ordinary uploads marked "[廣告]" (or "廣告") plus banner noise;
// a playable title always links to /videos/<slug>/ — anything else is dropped.
function isAd(title) {
  if (!title) return true;
  return /廣告|^AD[\s:_-]/i.test(title) || /^\[[^\]]*\]\s*$/.test(title);
}

function absolute(base, url) {
  try { return new URL(url, base).href; } catch { return url; }
}

// ---- Listing parsing (jable.tv runs Kernel Video Sharing) ---------------
function parseCard(chunk) {
  const hrefM = /href="([^"]*)"/.exec(chunk);
  const url = videoUrlOf(hrefM ? hrefM[1] : "");
  if (!url) return null;
  const titleM = /<h6[^>]*>([\s\S]*?)<\/h6>/.exec(chunk);
  let title = cleanText(titleM ? titleM[1] : "");
  if (!title) {
    const fallback = /<a[^>]*href="[^"]*\/videos\/[^"]*"[^>]*>([\s\S]{3,400}?)<\/a>/.exec(chunk);
    title = cleanText(fallback ? fallback[1] : "");
  }
  if (!title || isAd(title)) return null;
  const imgM = /(?:data-src|data-poster|src)="([^"]+\.(?:jpg|jpeg|webp|png)[^"]*)"/i.exec(chunk);
  const poster = imgM ? absolute(SITE, stripTags(imgM[1])) : undefined;
  const durM = /(\d{1,3}):(\d{2})(?::\d{2})?/.exec(chunk);
  let runtimeMinutes;
  if (durM) {
    runtimeMinutes = parseInt(durM[1], 10) + Math.round(parseInt(durM[2], 10) / 60);
    if (durM[0].split(":").length === 3) runtimeMinutes = parseInt(durM[1], 10) * 60 + parseInt(durM[2], 10) + Math.round(parseInt((durM[0].split(":"))[2], 10) / 60);
  }
  const slug = /\/videos\/([^"?#]+)\/?/.exec(url)[1];
  return {
    id: slug.replace(/\/$/, ""),
    ref: url,
    title: title.slice(0, 200),
    kind: "movie",
    adult: true,
    poster,
    runtimeMinutes,
  };
}

function parseList(html) {
  const chunks = html.split(/<div class="video-img-box/).slice(1);
  const items = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const item = parseCard(chunk.length > 8000 ? chunk.slice(0, 8000) : chunk);
    if (item && !seen.has(item.id)) { seen.add(item.id); items.push(item); }
  }
  return items;
}

// Next page: KVS "load more" links (?...block_id=list_videos_common_videos_list&from=N).
function nextFrom(html, currentFrom) {
  let next = currentFrom + 1;
  const nums = [];
  const re = /block_id=list_videos_common_videos_list&from=(\d+)/g;
  let m = re.exec(html);
  while (m) { nums.push(parseInt(m[1], 10)); m = re.exec(html); }
  const bigger = nums.filter((n) => n > currentFrom);
  if (bigger.length) next = Math.min.apply(null, bigger);
  return next;
}

async function fetchPage(url) {
  for (const base of MIRRORS) {
    const full = base === MIRRORS[0] ? url : absolute(base, url);
    try {
      const r = await kino.fetch(full, { headers: BASE_HEADERS, timeoutMs: 20000 });
      if (!r.ok) { log("fetch", full, "status", r.status); continue; }
      const text = r.text();
      if (/just a moment|challenge-platform|cf-browser-verification/i.test(text) && base !== MIRRORS[MIRRORS.length - 1]) {
        log("cloudflare challenge on", base);
        continue;
      }
      return text;
    } catch (e) { log("fetch failed", full, e && e.message); }
  }
  return null;
}

function cursorUrl(ref, from) {
  const path = String(ref).charAt(0) === "/" ? String(ref) : "/" + ref;
  return SITE + path + "mode=async&function=get_block&block_id=list_videos_common_videos_list&from=" + from;
}

// ---- Capabilities --------------------------------------------------------

export async function home() {
  const rows = [];
  for (const row of ROWS) {
    try {
      const html = await fetchPage(SITE + row.ref);
      if (!html) continue;
      const items = parseList(html);
      if (items.length) rows.push({ id: row.ref.replace(/\//g, "-").replace(/^-|-$/g, ""), title: row.title, items: items.slice(0, MAX_ROW_ITEMS), ref: row.ref });
    } catch (e) { log("row failed", row.title, e && e.message); }
  }
  return rows;
}

export async function browse(ref, cursor) {
  const currentFrom = cursor ? parseInt(String(cursor), 10) || 1 : 1;
  const url = currentFrom === 1 && !cursor ? SITE + (String(ref).charAt(0) === "/" ? ref : "/" + ref) : cursorUrl(ref, currentFrom);
  const html = await fetchPage(url);
  if (!html) return { items: [], next: undefined };
  const items = parseList(html);
  return { items, next: items.length ? String(nextFrom(html, currentFrom)) : undefined };
}

// Page 1 reads the real search page; later pages read KVS's async block, which
// returns the same list of cards. Every page is the site's full page size.
function searchUrl(q, from) {
  const base = SITE + "/search/" + encodeURIComponent(q.replace(/\s+/g, " ")).replace(/%20/g, "+") + "/";
  return from > 1 ? base + "mode=async&function=get_block&block_id=list_videos_common_videos_list&from=" + from : base;
}

export async function search(query) {
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  const from = (query && query.cursor) ? parseInt(String(query.cursor), 10) || 1 : 1;
  const html = await fetchPage(searchUrl(q, from));
  if (!html) return [];
  return parseList(html);
}

// ---- Resolve -------------------------------------------------------------
const QUALITY_LABEL = { best: "mejor", auto: "auto", "1080": "1080p", 720: "720p", 480: "480p", worst: "baja" };

function variantList(master, masterUrl) {
  const entries = [];
  const re = /#EXT-X-STREAM-INF:([^\n]*)\n([^\n#][^\n]*)/g;
  let m = re.exec(master);
  while (m) {
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(m[1]);
    entries.push({ height: res ? parseInt(res[2], 10) : 0, url: absolute(masterUrl, m[2].trim()) });
    m = re.exec(master);
  }
  entries.sort(function (a, b) { return b.height - a.height; });
  return entries;
}

function pickVariant(masterText, masterUrl, wanted) {
  const entries = variantList(masterText, masterUrl);
  if (!entries.length) return null;
  if (wanted === "auto") return null; // keep the master: adaptive
  if (wanted === "best") return entries[0];
  if (wanted === "worst") return entries[entries.length - 1];
  const h = parseInt(wanted, 10) || 0;
  let chosen = null;
  let bestDelta = Infinity;
  for (const e of entries) {
    const d = Math.abs(e.height - h);
    if (d < bestDelta) { bestDelta = d; chosen = e; }
  }
  return chosen;
}

export async function resolve(ref) {
  const url = String(ref);
  const html = await fetchPage(url);
  if (!html) throw kino.error("not_found", "No se pudo abrir la página del video", { userMessage: "No se pudo abrir la página del video en jable.tv" });

  // Prefer the site's own player variable; the page's other m3u8s (ads/previews, if any) lose.
  let streamUrl = null;
  const hlsM = /var\s+hlsUrl\s*=\s*["']([^"']+)["']/.exec(html);
  if (hlsM && /\.m3u8/.test(hlsM[1])) streamUrl = stripTags(hlsM[1]);
  if (!streamUrl) {
    const generic = /["'](https?:\/\/[^"'\s<]+\.m3u8[^"'\s<]*)["']/.exec(html);
    if (generic) streamUrl = stripTags(generic[1]);
  }
  if (!streamUrl) throw kino.error("not_found", "El video no expuso una transmisión HLS", { userMessage: "No se encontró la transmisión de este video" });
  streamUrl = streamUrl.replace(/\\\//g, "/").replace(/\&amp;/g, "&");

  const streamHeaders = { "User-Agent": UA, "Referer": SITE + "/" };
  const wanted = String(kino.config.get("quality") || "best");
  const alternatives = [];
  let outUrl = streamUrl;

  if (wanted !== "auto") {
    try {
      const r = await kino.fetch(streamUrl, { headers: streamHeaders, timeoutMs: 15000 });
      if (r.ok && /#EXTM3U/.test(r.text())) {
        const master = r.text();
        const chosen = pickVariant(master, streamUrl, wanted);
        if (chosen) {
          outUrl = chosen.url;
          for (const e of variantList(master, streamUrl)) {
            if (e.url !== outUrl) alternatives.push({ url: e.url, label: e.height ? e.height + "p" : "alternativa" });
          }
        }
      }
    } catch (e) { log("playlist fetch failed, master as-is", e && e.message); }
  }

  const titleM = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  const label = titleM ? cleanText(titleM[1]).slice(0, 200) : "";

  return {
    url: outUrl,
    mime: "application/x-mpegURL",
    headers: streamHeaders,
    label: QUALITY_LABEL[wanted] ? "Calidad: " + QUALITY_LABEL[wanted] : undefined,
    alternatives,
  };
}
