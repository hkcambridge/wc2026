// World Cup 2026 data proxy.
// Combines ESPN's public scoreboard (scores + fixtures) with ITV Sport's YouTube
// uploads (highlight links) and returns a single JSON payload with CORS enabled,
// so a static page can render everything with one fetch and no API key.

const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const ITV_VIDEOS_URL = "https://www.youtube.com/@ITVSport/videos";
const TABLE_URL = "https://www.bbc.co.uk/sport/football/world-cup/table";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ITV_MAX_TRIES = 3; // YouTube occasionally serves a lighter page with no grid

const YT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en",
  Cookie: "CONSENT=YES+; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LqsBg",
};

// Team displayName (lowercased) -> flag emoji. Public football data.
const FLAGS = {
  "canada": "🇨🇦", "mexico": "🇲🇽", "united states": "🇺🇸", "usa": "🇺🇸",
  "argentina": "🇦🇷", "brazil": "🇧🇷", "colombia": "🇨🇴", "ecuador": "🇪🇨",
  "paraguay": "🇵🇾", "uruguay": "🇺🇾", "bolivia": "🇧🇴", "chile": "🇨🇱", "peru": "🇵🇪",
  "australia": "🇦🇺", "iran": "🇮🇷", "japan": "🇯🇵", "jordan": "🇯🇴",
  "south korea": "🇰🇷", "korea republic": "🇰🇷", "qatar": "🇶🇦",
  "saudi arabia": "🇸🇦", "uzbekistan": "🇺🇿", "iraq": "🇮🇶",
  "algeria": "🇩🇿", "cape verde": "🇨🇻", "egypt": "🇪🇬", "ghana": "🇬🇭",
  "ivory coast": "🇨🇮", "côte d'ivoire": "🇨🇮", "morocco": "🇲🇦",
  "senegal": "🇸🇳", "south africa": "🇿🇦", "tunisia": "🇹🇳",
  "nigeria": "🇳🇬", "cameroon": "🇨🇲", "dr congo": "🇨🇩", "congo dr": "🇨🇩",
  "curacao": "🇨🇼", "curaçao": "🇨🇼", "haiti": "🇭🇹", "panama": "🇵🇦",
  "costa rica": "🇨🇷", "honduras": "🇭🇳", "jamaica": "🇯🇲",
  "new zealand": "🇳🇿", "new caledonia": "🇳🇨",
  "austria": "🇦🇹", "belgium": "🇧🇪", "croatia": "🇭🇷",
  "england": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "france": "🇫🇷", "germany": "🇩🇪",
  "netherlands": "🇳🇱", "norway": "🇳🇴", "portugal": "🇵🇹",
  "scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "wales": "🏴󠁧󠁢󠁷󠁬󠁳󠁿", "spain": "🇪🇸", "switzerland": "🇨🇭",
  "czechia": "🇨🇿", "czech republic": "🇨🇿", "bosnia-herzegovina": "🇧🇦",
  "bosnia and herzegovina": "🇧🇦", "italy": "🇮🇹", "denmark": "🇩🇰",
  "sweden": "🇸🇪", "turkey": "🇹🇷", "türkiye": "🇹🇷", "ukraine": "🇺🇦",
  "poland": "🇵🇱", "slovakia": "🇸🇰", "slovenia": "🇸🇮", "serbia": "🇷🇸",
  "hungary": "🇭🇺", "romania": "🇷🇴", "kosovo": "🇽🇰", "albania": "🇦🇱",
  "north macedonia": "🇲🇰", "ireland": "🇮🇪", "republic of ireland": "🇮🇪",
};

// ESPN displayName (lowercased) -> aliases ITV may use in highlight titles.
const ALIASES = {
  "czechia": ["czechia", "czech republic"],
  "united states": ["united states", "usa"],
  "bosnia-herzegovina": ["bosnia-herzegovina", "bosnia and herzegovina", "bosnia"],
  "ivory coast": ["ivory coast", "cote d'ivoire", "côte d'ivoire"],
  "iran": ["iran", "ir iran"],
  "south korea": ["south korea", "korea republic"],
  "türkiye": ["türkiye", "turkey", "turkiye"],
  "curaçao": ["curaçao", "curacao"],
  "cape verde": ["cape verde", "cabo verde"],
  "congo dr": ["congo dr", "dr congo", "democratic republic of congo", "congo"],
};

const flag = (name) => FLAGS[name.toLowerCase()] || "";
const aliasesFor = (name) => {
  const n = name.toLowerCase();
  return ALIASES[n] || [n];
};

// ── YouTube parsing ───────────────────────────────────────────────────────

function extractYtInitialData(html) {
  const marker = "var ytInitialData = ";
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = idx + marker.length;
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function extractHighlights(data) {
  const out = [];
  const walk = (o) => {
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    if (o && typeof o === "object") {
      const lv = o.lockupViewModel;
      if (lv && lv.contentId) {
        let title = "";
        const firstContent = (x) => {
          if (title) return;
          if (Array.isArray(x)) { for (const v of x) firstContent(v); }
          else if (x && typeof x === "object") {
            if (typeof x.content === "string" && x.content) { title = x.content; return; }
            for (const v of Object.values(x)) firstContent(v);
          }
        };
        firstContent(lv.metadata || {});
        if (title.toUpperCase().startsWith("HIGHLIGHTS")) {
          out.push({ title, videoId: lv.contentId });
        }
      }
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(data);
  return out;
}

// Fetch ITV highlights, retrying past the occasional empty/light page variant.
async function fetchHighlights() {
  for (let attempt = 0; attempt < ITV_MAX_TRIES; attempt++) {
    try {
      const resp = await fetch(ITV_VIDEOS_URL, { headers: YT_HEADERS });
      const html = await resp.text();
      const data = extractYtInitialData(html);
      const hl = data ? extractHighlights(data) : [];
      if (hl.length > 0) return hl;
    } catch (_) { /* retry */ }
  }
  return [];
}

function matchHighlight(home, away, highlights) {
  for (const hl of highlights) {
    const t = hl.title.toLowerCase();
    const has = (team) => aliasesFor(team).some((a) => t.includes(a));
    if (has(home) && has(away)) return `https://www.youtube.com/watch?v=${hl.videoId}`;
  }
  return null;
}

// ── ESPN parsing ──────────────────────────────────────────────────────────

const yyyymmdd = (d) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

// ESPN dates look like "2026-06-17T18:00Z" (no seconds); normalise for Date().
function parseEspnDate(s) {
  const t = Date.parse(s.replace(/T(\d\d:\d\d)Z$/, "T$1:00Z"));
  return Number.isNaN(t) ? null : t;
}

async function buildPayload() {
  const now = Date.now();
  const range = `${yyyymmdd(new Date(now - 864e5))}-${yyyymmdd(new Date(now + 1728e5))}`;
  const recent = [];
  const upcoming = [];
  let error = null;

  try {
    const resp = await fetch(`${ESPN_SCOREBOARD}?dates=${range}`);
    const events = (await resp.json()).events || [];
    const games = [];
    for (const e of events) {
      const comp = (e.competitions || [{}])[0];
      const sides = {};
      for (const c of comp.competitors || []) sides[c.homeAway] = c;
      const home = sides.home, away = sides.away;
      if (!home || !away) continue;
      const startMs = parseEspnDate(e.date || "");
      if (startMs === null) continue;
      games.push({
        id: e.id, date: e.date, startMs,
        state: comp.status?.type?.state || "",
        home: home.team?.displayName || "", away: away.team?.displayName || "",
        homeScore: home.score, awayScore: away.score,
      });
    }

    const recentGames = games.filter(
      (g) => g.state === "post" && now - g.startMs >= 0 && now - g.startMs <= 26 * 36e5
    );
    const upcomingGames = games.filter(
      (g) => g.state === "in" || (g.state === "pre" && g.startMs - now >= 0 && g.startMs - now <= 24 * 36e5)
    );

    const highlights = recentGames.length ? await fetchHighlights() : [];

    recentGames.sort((a, b) => b.startMs - a.startMs);
    for (const g of recentGames) {
      recent.push({
        id: g.id, date: g.date, home: g.home, away: g.away,
        homeFlag: flag(g.home), awayFlag: flag(g.away),
        homeScore: g.homeScore, awayScore: g.awayScore,
        highlightUrl: matchHighlight(g.home, g.away, highlights),
      });
    }
    upcomingGames.sort((a, b) => a.startMs - b.startMs);
    for (const g of upcomingGames) {
      upcoming.push({
        id: g.id, date: g.date, home: g.home, away: g.away,
        homeFlag: flag(g.home), awayFlag: flag(g.away),
        live: g.state === "in",
      });
    }
  } catch (ex) {
    error = `${ex}`;
  }

  return { recent, upcoming, tableUrl: TABLE_URL, fetchedAt: new Date(now).toISOString(), error };
}

// ── Cache + handler ─────────────────────────────────────────────────────────

let _cache = null; // { at: number, body: string }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (!_cache || Date.now() - _cache.at > CACHE_TTL_MS) {
      const payload = await buildPayload();
      // Only cache a clean result; keep last-good on transient ESPN errors.
      if (!payload.error || !_cache) {
        _cache = { at: Date.now(), body: JSON.stringify(payload) };
      }
    }
    return new Response(_cache.body, {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=600", ...CORS },
    });
  },
};
