// Tonight — a calm tracker for the shows you watch.
// Everything you track is saved on this device. Show info comes from TVMaze.

const API = "https://api.tvmaze.com";
const IMG = "https://static.tvmaze.com/uploads/images/medium_portrait/";
const STATE_KEY = "tonight.state.v1";
const CACHE_KEY = "tonight.cache.v1";
const DAY = 864e5;
const NEW_WINDOW = 10 * DAY; // an episode counts as "new" for this long

// ───────────────────────── storage ─────────────────────────
const read = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
};
let state = read(STATE_KEY) || { v: 1, name: "Fay", shows: {}, hidden: [] };
let cache = read(CACHE_KEY) || {}; // id → { at, sum, eps: [[id, season, number, name, airstamp]] }
state.shows ||= {};
state.hidden ||= [];
for (const t of Object.values(state.shows))
  if (t.loved) {
    t.feel = "love";
    delete t.loved;
  }

let cacheTimer;
function save() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    toast("Storage is full on this device");
  }
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(saveCache, 500);
}
function saveCache() {
  const keep = {};
  for (const id of Object.keys(state.shows)) if (cache[id]) keep[id] = cache[id];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(keep));
  } catch {
    // Too big: drop episode names for finished shows and retry once.
    for (const id of Object.keys(keep))
      if (state.shows[id].status === "watched")
        keep[id] = { ...keep[id], eps: keep[id].eps.map((e) => [e[0], e[1], e[2], "", e[4]]) };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(keep));
    } catch {}
  }
}

// ───────────────────────── TVMaze ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobs = [];
let running = 0;
let lastStart = 0;
let pumpTimer;
function api(path, urgent = false) {
  return new Promise((resolve, reject) => {
    const job = { path, resolve, reject, tries: 0 };
    urgent ? jobs.unshift(job) : jobs.push(job);
    pump();
  });
}
function pump() {
  if (running >= 2 || !jobs.length) return;
  const wait = lastStart + 520 - Date.now(); // stay under TVMaze's rate limit
  if (wait > 0) {
    clearTimeout(pumpTimer);
    pumpTimer = setTimeout(pump, wait);
    return;
  }
  const job = jobs.shift();
  running++;
  lastStart = Date.now();
  fetch(API + job.path)
    .then(async (res) => {
      if (res.status === 429 && job.tries++ < 4) {
        await sleep(4000);
        jobs.unshift(job);
        return;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      job.resolve(await res.json());
    })
    .catch(job.reject)
    .finally(() => {
      running--;
      pump();
    });
  pump();
}

const known = new Map(); // id → compact show info, for anything we've seen
function fromApi(s) {
  const info = {
    i: s.id,
    n: s.name || "Untitled",
    g: s.genres || [],
    t: s.type || "",
    l: s.language || "",
    s: { Running: "R", Ended: "E", "To Be Determined": "T", "In Development": "D" }[s.status] || "E",
    d: s.premiered || "",
    e: s.ended ? +s.ended.slice(0, 4) : 0,
    r: s.rating?.average || 0,
    w: s.weight || 0,
    c: s.webChannel?.name || s.network?.name || "",
    k: s.network?.country?.code || s.webChannel?.country?.code || "",
    m: s.averageRuntime || s.runtime || 0,
    p: s.image?.medium?.startsWith(IMG) ? s.image.medium.slice(IMG.length) : "",
  };
  known.set(info.i, info);
  return info;
}
const stripHtml = (html) => (html ? new DOMParser().parseFromString(html, "text/html").body.textContent.trim() : "");

const inflight = new Map();
function loadShow(id, urgent = false) {
  if (inflight.has(id)) return inflight.get(id);
  const p = api(`/shows/${id}?embed=episodes`, urgent)
    .then((s) => {
      const info = fromApi(s);
      const eps = (s._embedded?.episodes || [])
        .filter((e) => e.number != null)
        .map((e) => [e.id, e.season, e.number, e.name || "", e.airstamp || ""])
        .sort((a, b) => a[1] - b[1] || a[2] - b[2]);
      cache[id] = { at: Date.now(), sum: stripHtml(s.summary), eps };
      const t = state.shows[id];
      if (t) {
        t.info = info;
        applyPending(id);
        settle(id, true);
        tasteV++;
        save();
      }
      renderSoon();
    })
    .catch(() => {})
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

function refreshAll(force = false) {
  const order = { watching: 0, want: 1, watched: 2 };
  const ids = Object.keys(state.shows).sort((a, b) => order[state.shows[a].status] - order[state.shows[b].status]);
  for (const id of ids) {
    const c = cache[id];
    const ttl = state.shows[id].info.s === "E" ? 7 * DAY : 6 * 36e5;
    if (force || !c || Date.now() - c.at > ttl) loadShow(+id);
  }
}

let catalog = [];
let upcoming = [];
let idf = {};
async function loadData() {
  const get = (f) => fetch(`data/${f}.json`).then((r) => r.json());
  try {
    const [c, u] = await Promise.all([get("catalog"), get("upcoming")]);
    catalog = c.shows;
    upcoming = u.shows;
    const n = {};
    for (const s of catalog) {
      known.set(s.i, s);
      for (const g of s.g) n[g] = (n[g] || 0) + 1;
    }
    for (const s of upcoming) known.set(s.i, s);
    for (const g in n) idf[g] = Math.log(1 + catalog.length / n[g]);
    tasteV++;
    renderSoon();
  } catch {}
}

// ───────────────────────── tracking ─────────────────────────
let memo = new Map();
function derive(id) {
  if (memo.has(id)) return memo.get(id);
  const t = state.shows[id];
  const eps = cache[id]?.eps || [];
  const ended = (t?.info || known.get(id))?.s === "E";
  const seen = new Set(t?.seen || []);
  const now = Date.now();
  const d = { eps, seen, loaded: !!cache[id], aired: 0, seenAired: 0, unseen: 0, nextUp: null, nextAir: null, latestUnseen: 0 };
  for (const e of eps) {
    const at = e[4] ? Date.parse(e[4]) : ended ? 0 : NaN;
    if (at <= now) {
      d.aired++;
      if (seen.has(e[0])) d.seenAired++;
      else {
        d.unseen++;
        d.nextUp ||= e;
        if (at > d.latestUnseen) d.latestUnseen = at;
      }
    } else if (at > now && (!d.nextAir || at < Date.parse(d.nextAir[4]))) d.nextAir = e;
  }
  d.fresh = d.unseen > 0 && now - d.latestUnseen < NEW_WINDOW;
  memo.set(id, d);
  return d;
}
const isAired = (e, ended) => (e[4] ? Date.parse(e[4]) <= Date.now() : ended);

function applyPending(id) {
  const t = state.shows[id];
  if (!t?.all || !cache[id]) return;
  const ended = t.info.s === "E";
  t.seen = cache[id].eps.filter((e) => isAired(e, ended)).map((e) => e[0]);
  delete t.all;
  memo.delete(id);
}
// A finished show with nothing left to watch belongs in Watched.
function settle(id, quiet = false) {
  memo.delete(id);
  const t = state.shows[id];
  if (!t || t.status !== "watching") return;
  const d = derive(id);
  if (d.aired > 0 && d.unseen === 0 && !d.nextAir && t.info.s === "E") {
    t.status = "watched";
    if (!quiet) toast(`Finished ${t.info.n}`);
  }
}

function commit() {
  tasteV++;
  save();
  render();
  renderSheet();
}
const snapshot = (id) => (state.shows[id] ? JSON.stringify(state.shows[id]) : null);
function undoTo(id, snap) {
  return () => {
    if (snap) state.shows[id] = JSON.parse(snap);
    else delete state.shows[id];
    commit();
  };
}

const LABEL = { want: "My list", watching: "Watching", watched: "Watched" };
function setStatus(id, status) {
  const info = state.shows[id]?.info || known.get(id);
  if (!info) return;
  const snap = snapshot(id);
  const t = (state.shows[id] ||= { status, added: Date.now(), seen: [], info });
  t.status = status;
  if (status === "watched") {
    t.all = true;
    applyPending(id);
  } else delete t.all;
  const i = state.hidden.indexOf(id);
  if (i >= 0) state.hidden.splice(i, 1);
  if (!cache[id]) loadShow(id, true);
  navigator.storage?.persist?.();
  commit();
  return snap;
}
function removeShow(id) {
  const snap = snapshot(id);
  const name = state.shows[id]?.info.n;
  delete state.shows[id];
  commit();
  toast(`Removed ${name}`, "Undo", undoTo(id, snap));
}
function markNext(id) {
  const d = derive(id);
  const t = state.shows[id];
  if (!t || !d.nextUp) return;
  const snap = snapshot(id);
  const e = d.nextUp;
  t.seen.push(e[0]);
  t.status = "watching";
  settle(id, true);
  commit();
  const done = t.status === "watched";
  toast(done ? `Finished ${t.info.n} · moved to Watched` : `Watched ${t.info.n} · S${e[1]} E${e[2]}`, "Undo", undoTo(id, snap));
}
function toggleEpisode(id, epId) {
  let t = state.shows[id];
  if (!t) {
    setStatus(id, "watching");
    t = state.shows[id];
  }
  const snap = snapshot(id);
  const at = t.seen.indexOf(epId);
  if (at >= 0) t.seen.splice(at, 1);
  else {
    t.seen.push(epId);
    if (t.status === "want") t.status = "watching";
    const eps = cache[id]?.eps || [];
    const idx = eps.findIndex((e) => e[0] === epId);
    const seen = new Set(t.seen);
    const earlier = eps.slice(0, idx).filter((e) => !seen.has(e[0]));
    if (earlier.length)
      toast(`${earlier.length} earlier ${earlier.length === 1 ? "episode" : "episodes"} unticked`, "Tick them too", () => {
        for (const e of earlier) t.seen.push(e[0]);
        settle(id);
        commit();
      });
  }
  settle(id);
  commit();
  return snap;
}
function toggleSeason(id, season) {
  let t = state.shows[id];
  if (!t) {
    setStatus(id, "watching");
    t = state.shows[id];
  }
  const ended = t.info.s === "E";
  const ids = (cache[id]?.eps || []).filter((e) => e[1] === season && isAired(e, ended)).map((e) => e[0]);
  const seen = new Set(t.seen);
  if (ids.every((x) => seen.has(x))) t.seen = t.seen.filter((x) => !ids.includes(x));
  else {
    for (const x of ids) seen.add(x);
    t.seen = [...seen];
    if (t.status === "want") t.status = "watching";
  }
  settle(id);
  commit();
}

// lists the screens are built from
function lists() {
  const L = { ready: [], caughtUp: [], back: [], listOut: [], listSoon: [], watched: [], dated: [] };
  const today = todayStr();
  for (const key of Object.keys(state.shows)) {
    const id = +key;
    const t = state.shows[id];
    const d = derive(id);
    const item = { id, t, d, info: t.info };
    if (t.status === "watching") (d.unseen ? L.ready : L.caughtUp).push(item);
    else if (t.status === "watched") {
      L.watched.push(item);
      if (d.unseen) L.back.push(item);
    } else {
      const out = d.loaded ? d.aired > 0 : t.info.d && t.info.d <= today;
      (out ? L.listOut : L.listSoon).push(item);
    }
    if (d.nextAir) {
      const e = d.nextAir;
      const label = t.status === "want" && !d.aired ? "Premieres" : e[2] === 1 ? `Season ${e[1]} starts` : `S${e[1]} · E${e[2]}`;
      L.dated.push({ ...item, at: Date.parse(e[4]), label });
    } else if (t.status === "want" && !d.aired && t.info.d > today)
      L.dated.push({ ...item, at: dayTs(t.info.d), label: "Premieres" });
  }
  L.ready.sort((a, b) => b.d.latestUnseen - a.d.latestUnseen);
  L.back.sort((a, b) => b.d.latestUnseen - a.d.latestUnseen);
  const nextAt = (x) => (x.d.nextAir ? Date.parse(x.d.nextAir[4]) : Infinity);
  L.caughtUp.sort((a, b) => nextAt(a) - nextAt(b));
  L.watched.sort((a, b) => b.t.added - a.t.added);
  L.listOut.sort((a, b) => b.t.added - a.t.added);
  L.dated.sort((a, b) => a.at - b.at);
  return L;
}

// ───────────────────────── taste & recommendations ─────────────────────────
let tasteV = 0;
const recMemo = {};
function cached(name, fn) {
  const hit = recMemo[name];
  if (hit && hit.v === tasteV) return hit.value;
  const value = fn();
  recMemo[name] = { v: tasteV, value };
  return value;
}
function taste() {
  return cached("taste", () => {
    const P = { genre: {}, type: {}, lang: {}, chan: {}, total: 0, anchors: [] };
    const W = { want: 0.6, watching: 1.2, watched: 1 };
    for (const t of Object.values(state.shows)) {
      const w = W[t.status] * ({ love: 2.5, ok: 0.35, no: 0 }[t.feel] ?? 1);
      P.total += w;
      for (const g of t.info.g) P.genre[g] = (P.genre[g] || 0) + w;
      P.type[t.info.t] = (P.type[t.info.t] || 0) + w;
      P.lang[t.info.l] = (P.lang[t.info.l] || 0) + w;
      if (t.info.c) P.chan[t.info.c] = (P.chan[t.info.c] || 0) + w;
      if (t.info.g.length && t.feel !== "ok" && t.feel !== "no") P.anchors.push({ info: t.info, w, added: t.added, loved: t.feel === "love" });
    }
    for (const k of ["genre", "type", "lang", "chan"]) for (const g in P[k]) P[k][g] /= P.total || 1;
    P.norm = Math.sqrt(Object.entries(P.genre).reduce((a, [g, v]) => a + (v * (idf[g] || 1)) ** 2, 0)) || 1;
    P.anchors.sort((a, b) => b.w - a.w || b.added - a.added);
    P.anchors = P.anchors.slice(0, 80);
    return P;
  });
}
function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  let both = 0;
  for (const g of a) if (b.includes(g)) both++;
  return both / (a.length + b.length - both);
}
// How well a show fits what Fay watches: 0 (not at all) … ~1 (very much)
function fit(c) {
  const P = taste();
  if (!P.total) return { match: 0, ok: true };
  let dot = 0;
  let norm = 0;
  for (const g of c.g) {
    const w = idf[g] || 1;
    dot += (P.genre[g] || 0) * w * w;
    norm += w * w;
  }
  const cos = norm ? dot / (P.norm * Math.sqrt(norm)) : 0;
  let nn = 0;
  let because = null;
  for (const a of P.anchors) {
    const j = jaccard(c.g, a.info.g) * (a.loved ? 1 : 0.88);
    if (j > nn) {
      nn = j;
      because = a.info;
    }
  }
  const lang = (P.lang[c.l] || 0) >= 0.05 || !c.l;
  const type = (P.type[c.t] || 0) >= 0.05;
  const match = (0.6 * cos + 0.4 * nn + Math.min(P.chan[c.c] || 0, 0.3) * 0.25) * (lang ? 1 : 0.25) * (type ? 1 : 0.5);
  return { match, ok: lang && type, because };
}
const untracked = (s) => !state.shows[s.i] && !state.hidden.includes(s.i);
function recs() {
  return cached("recs", () => {
    const has = taste().total > 0;
    const ranked = catalog
      .filter(untracked)
      .map((s) => {
        const quality = s.r ? (s.r - 6.5) / 3 : -0.1;
        const year = +yearOf(s);
        const recent = year >= 2018 ? 0.08 : year >= 2010 ? 0.04 : 0;
        const f = fit(s);
        return { s, score: has ? f.match + 0.4 * quality + 0.12 * (s.w / 100) + recent : quality + s.w / 100 + recent, f };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 400);
    // keep the top of the list varied: each repeat of the same genre mix is nudged down
    const seen = {};
    for (const x of ranked) {
      const key = x.s.g.slice().sort().join("+");
      x.score -= 0.05 * (seen[key] || 0);
      seen[key] = (seen[key] || 0) + 1;
    }
    return ranked.sort((a, b) => b.score - a.score);
  });
}
function upcomingRecs() {
  return cached("upcoming", () => {
    const has = taste().total > 0;
    const today = todayStr();
    const out = { soon: [], fresh: [], tba: [] };
    for (const s of upcoming) {
      if (!untracked(s)) continue;
      const f = fit(s);
      if (has && (!f.ok || (s.g.length ? f.match < 0.3 : s.w < 95))) continue;
      if (!has && s.l && s.l !== "English") continue;
      const item = { s, score: f.match * 0.6 + (s.w / 100) * 0.4 };
      if (!s.d) out.tba.push(item);
      else if (s.d > today) out.soon.push(item);
      else if (s.w >= 60) out.fresh.push(item);
    }
    const top = (arr, n) => arr.sort((a, b) => b.score - a.score).slice(0, n);
    out.soon = top(out.soon, 36).sort((a, b) => a.s.d.localeCompare(b.s.d));
    out.fresh = top(out.fresh, 24);
    out.tba = top(out.tba, 24);
    return out;
  });
}
function moreLike(anchor, n = 12) {
  return catalog
    .filter((s) => untracked(s) && s.i !== anchor.i)
    .map((s) => ({ s, score: jaccard(s.g, anchor.g) + (s.c && s.c === anchor.c ? 0.08 : 0) + (s.r ? (s.r - 6.5) / 12 : 0) + (s.l === anchor.l ? 0.1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.s);
}

// ───────────────────────── formatting ─────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dayTs = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
};
const midnight = (ts) => new Date(ts).setHours(0, 0, 0, 0);
function rel(ts) {
  const n = Math.round((midnight(ts) - midnight(Date.now())) / DAY);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n > 1 && n <= 20) return `in ${n} days`;
  if (n > 20 && n < 75) return `in ${Math.round(n / 7)} weeks`;
  return "";
}
function dateStr(ts) {
  const d = new Date(ts);
  const opts = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) Object.assign(opts, { year: "numeric", weekday: undefined });
  return d.toLocaleDateString(undefined, opts);
}
const monthStr = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short" });
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const svg = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const IC = {
  home: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  watching: svg('<rect x="3" y="4.5" width="18" height="13" rx="3"/><path d="M10.2 8.8v4.4l3.8-2.2z"/><path d="M8.5 20.5h7"/>'),
  upcoming: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>'),
  discover: svg('<path d="M11 3.5l1.9 5.6 5.6 1.9-5.6 1.9L11 18.5l-1.9-5.6L3.5 11l5.6-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
  watched: svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.4 12.3l2.5 2.5 4.7-5.2"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'),
  heart: svg('<path d="M12 20s-7-4.4-7-9.6A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.4C19 15.6 12 20 12 20z"/>'),
  sliders: svg('<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.4"/><circle cx="8" cy="17" r="2.4"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>'),
  chev: '<svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  dice: svg('<path d="M12 3.5l2 5.3 5.5.4-4.2 3.6 1.3 5.4L12 15.3l-4.6 2.9 1.3-5.4-4.2-3.6 5.5-.4z"/>'),
  bin: svg('<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12h8.4L17 7"/>'),
  hide: svg('<circle cx="12" cy="12" r="8.5"/><path d="M6.2 6.2l11.6 11.6"/>'),
};

const TINTS = ["t-mint", "t-lilac", "t-peach", "t-sky", "t-butter", "t-rose"];
function poster(info) {
  return info.p
    ? `<img class="poster" loading="lazy" decoding="async" src="${IMG}${esc(info.p)}" alt="">`
    : `<div class="poster ph ${TINTS[info.i % TINTS.length]}">${esc(info.n.trim()[0] || "?")}</div>`;
}
const yearOf = (info) => (info.d ? info.d.slice(0, 4) : "");
const shortMeta = (info) => [info.r ? `★ ${info.r.toFixed(1)}` : "", yearOf(info)].filter(Boolean).join(" · ");

function tile(info, { meta = "", badge = "", quick = "" } = {}) {
  const tracked = state.shows[info.i];
  const q =
    quick ||
    (tracked
      ? ""
      : `<button class="quick" data-act="add" data-id="${info.i}" aria-label="Add ${esc(info.n)}">${IC.plus}</button>`);
  const heart = tracked?.feel === "love" ? `<span class="heart-dot">${IC.heart}</span>` : "";
  return `<article class="tile" data-act="open" data-id="${info.i}" tabindex="0" role="button" aria-label="${esc(info.n)}">
    <div class="tile-art">${poster(info)}${badge}${heart}${q}</div>
    <h3>${esc(info.n)}</h3>${meta ? `<p>${meta}</p>` : ""}</article>`;
}
const rail = (key, items) => `<div class="rail" data-rail="${key}">${items.join("")}</div>`;
const section = (title, body, { more = "", count = "" } = {}) =>
  `<section class="sec"><div class="sec-h"><h2>${title}${count !== "" ? `<span class="count">${count}</span>` : ""}</h2>${more}</div>${body}</section>`;
const moreBtn = (tab, label = "See all") => `<button class="more" data-act="tab" data-tab="${tab}">${label}</button>`;
const tickQuick = (id, name) =>
  `<button class="quick" data-act="next" data-id="${id}" aria-label="Mark next episode of ${esc(name)} watched">${IC.check}</button>`;

// ───────────────────────── screens ─────────────────────────
let tab = (location.hash.match(/^#\/(\w+)/) || [])[1] || "home";
const TABS = {
  home: { label: "Tonight", tint: "butter" },
  watching: { label: "Watching", tint: "mint" },
  upcoming: { label: "Upcoming", tint: "lilac" },
  discover: { label: "Discover", tint: "peach" },
  watched: { label: "Watched", tint: "sky" },
};
if (!TABS[tab]) tab = "home";

function setSky() {
  const h = new Date().getHours();
  const [a, b, orb] =
    h >= 5 && h < 11
      ? ["#dcebfb", "#fff1e0", "#fff3cf"]
      : h >= 11 && h < 17
        ? ["#d7ebfa", "#eaf5fd", "#fff6d6"]
        : h >= 17 && h < 21
          ? ["#e3ddfa", "#ffe3d6", "#fff1e4"]
          : ["#dadcf8", "#ece5fa", "#ffffff"];
  const st = document.documentElement.style;
  st.setProperty("--sky-a", a);
  st.setProperty("--sky-b", b);
  st.setProperty("--orb", orb);
}

function readyTile(x) {
  const e = x.d.nextUp;
  const badge = x.t.status === "watched" ? `<span class="badge t-lilac">New season</span>` : x.d.fresh ? `<span class="badge t-butter">New</span>` : "";
  return tile(x.info, { meta: `S${e[1]} · E${e[2]}`, badge, quick: tickQuick(x.id, x.info.n) });
}
function datedRow(x) {
  return `<article class="row dated" data-act="open" data-id="${x.id}" tabindex="0" role="button">
    <div class="leaf t-lilac"><small>${monthStr(x.at)}</small><b>${new Date(x.at).getDate()}</b></div>
    ${poster(x.info)}
    <div class="row-main"><h3>${esc(x.info.n)}</h3><p class="sub">${x.label}</p></div>
    <span class="when">${rel(x.at) || (new Date(x.at).getFullYear() !== new Date().getFullYear() ? new Date(x.at).getFullYear() : new Date(x.at).toLocaleDateString(undefined, { weekday: "short" }))}</span>
  </article>`;
}

function viewHome() {
  const L = lists();
  const count = Object.keys(state.shows).length;
  const ready = [...L.ready, ...L.back].sort((a, b) => b.d.latestUnseen - a.d.latestUnseen);
  const next = L.dated[0];
  const top = recs().slice(0, 12);
  let html = `<header class="sky">
    <button class="icon-btn gear" data-act="settings" aria-label="Settings">${IC.more}</button>
    <p class="hello">Hi ${esc(state.name || "there")},</p>
    <h1 class="ask">what do you want to watch tonight?</h1>
    <div class="sky-actions">
      ${count || top.length ? `<button class="pill" data-act="surprise">${IC.dice}Pick for me</button>` : ""}
      <button class="pill ghost" data-act="find">${IC.search}Find a show</button>
    </div>
  </header>
  <div class="places">
    <button class="place t-mint" data-act="tab" data-tab="watching">${IC.watching}<div><b>Watching</b><span>${ready.length ? `${ready.length} ready` : plural(L.caughtUp.length, "show")}</span></div></button>
    <button class="place t-lilac" data-act="tab" data-tab="upcoming">${IC.upcoming}<div><b>Upcoming</b><span>${next ? dateStr(next.at) : "New for you"}</span></div></button>
    <button class="place t-peach" data-act="tab" data-tab="discover">${IC.discover}<div><b>Discover</b><span>Picked for you</span></div></button>
    <button class="place t-sky" data-act="tab" data-tab="watched">${IC.watched}<div><b>Watched</b><span>${plural(L.watched.length, "show")}</span></div></button>
  </div>`;

  if (!count)
    html += `<div class="empty"><h2>Start with shows you know</h2><p>Add a few you've watched and Tonight will find more like them.</p>
      <button class="act" data-act="find">${IC.search}Find a show</button></div>`;
  if (ready.length) html += section("Ready to watch", rail("ready", ready.map(readyTile)), { more: moreBtn("watching") });
  if (L.listOut.length)
    html += section("On my list", rail("list", L.listOut.map((x) => tile(x.info, { meta: shortMeta(x.info) }))), { more: moreBtn("watching") });
  if (L.dated.length) html += section("Coming up", `<div class="rows">${L.dated.slice(0, 3).map(datedRow).join("")}</div>`, { more: moreBtn("upcoming") });
  if (top.length)
    html += section(count ? "You might like" : "Popular right now", rail("recs", top.map((x) => tile(x.s, { meta: shortMeta(x.s) }))), {
      more: moreBtn("discover", "More"),
    });
  return html;
}

function progress(d) {
  const pct = d.aired ? Math.round((d.seenAired / d.aired) * 100) : 0;
  return `<span class="bar" aria-hidden="true"><i style="width:${pct}%"></i></span>`;
}
function viewWatching() {
  const L = lists();
  const newCount = [...L.ready, ...L.back].filter((x) => x.d.fresh).length;
  let html = `<header class="page-head"><h1>Watching</h1><p>${
    newCount ? plural(newCount, "show") + " with new episodes" : L.ready.length ? plural(L.ready.length, "show") + " to continue" : "All caught up"
  }</p></header>`;

  if (!L.ready.length && !L.caughtUp.length && !L.back.length && !L.listOut.length)
    return (
      html +
      `<div class="empty"><h2>Nothing on yet</h2><p>Pick a show and tap Watching.</p><button class="act" data-act="find">${IC.search}Find a show</button></div>`
    );

  if (L.ready.length)
    html += section(
      "Ready to watch",
      `<div class="rows">${L.ready
        .map((x) => {
          const e = x.d.nextUp;
          const tag = x.d.fresh ? `<span class="tag t-butter">New</span>` : "";
          return `<article class="row" data-act="open" data-id="${x.id}" tabindex="0" role="button">
            ${poster(x.info)}
            <div class="row-main"><h3>${esc(x.info.n)}</h3>
              <p class="sub"><b>S${e[1]} · E${e[2]}</b>${e[3] ? " " + esc(e[3]) : ""}</p>
              <div class="tagline">${tag}${progress(x.d)}<span class="when">${x.d.unseen} left</span></div></div>
            <button class="act" data-act="next" data-id="${x.id}" aria-label="Mark S${e[1]} E${e[2]} watched">${IC.check}Watched</button>
          </article>`;
        })
        .join("")}</div>`,
    );

  if (L.back.length)
    html += section(
      "Back with more",
      `<div class="rows">${L.back
        .map((x) => {
          const e = x.d.nextUp;
          return `<article class="row" data-act="open" data-id="${x.id}" tabindex="0" role="button">
            ${poster(x.info)}
            <div class="row-main"><h3>${esc(x.info.n)}</h3>
              <p class="sub">${e[2] === 1 ? `Season ${e[1]} is out` : plural(x.d.unseen, "new episode")}</p>
              <div class="tagline"><span class="tag t-lilac">${dateStr(x.d.latestUnseen || Date.now())}</span></div></div>
            <button class="act lilac" data-act="start" data-id="${x.id}">Start</button>
          </article>`;
        })
        .join("")}</div>`,
    );

  if (L.caughtUp.length)
    html += section(
      "Caught up",
      `<div class="rows">${L.caughtUp
        .map((x) => {
          const n = x.d.nextAir;
          const sub = !x.d.loaded
            ? "Loading episodes…"
            : n
              ? `Next <b>${dateStr(Date.parse(n[4]))}</b>`
              : x.d.aired
                ? "No new date yet"
                : "Not out yet";
          return `<article class="row" data-act="open" data-id="${x.id}" tabindex="0" role="button">
            ${poster(x.info)}
            <div class="row-main"><h3>${esc(x.info.n)}</h3><p class="sub">${sub}</p></div>
            ${n ? `<span class="when">${rel(Date.parse(n[4]))}</span>` : `<span></span>`}
          </article>`;
        })
        .join("")}</div>`,
    );

  if (L.listOut.length)
    html += section(
      "On my list",
      `<div class="rows">${L.listOut
        .map(
          (x) => `<article class="row" data-act="open" data-id="${x.id}" tabindex="0" role="button">
            ${poster(x.info)}
            <div class="row-main"><h3>${esc(x.info.n)}</h3><p class="sub">${[shortMeta(x.info), esc(x.info.c)].filter(Boolean).join(" · ")}</p></div>
            <button class="act plain" data-act="start" data-id="${x.id}">Start</button>
          </article>`,
        )
        .join("")}</div>`,
    );
  return html;
}

function viewUpcoming() {
  const L = lists();
  const U = upcomingRecs();
  const next = L.dated[0];
  let html = `<header class="page-head"><h1>Upcoming</h1><p>${next ? `Next up ${dateStr(next.at)}` : "New shows and new seasons"}</p></header>`;
  if (L.dated.length) html += section("My shows", `<div class="rows">${L.dated.map(datedRow).join("")}</div>`);
  else if (Object.keys(state.shows).length)
    html += section("My shows", `<p class="quiet">No dates announced for your shows yet. They'll appear here as soon as there are.</p>`);
  const tba = L.listSoon.filter((x) => !L.dated.some((d) => d.id === x.id));
  if (tba.length) html += section("On my list, no date yet", rail("tba-mine", tba.map((x) => tile(x.info, { meta: esc(x.info.c) }))));

  const dated = (s) => {
    const ts = dayTs(s.d);
    return `${new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })}${rel(ts) ? " · " + rel(ts) : ""}`;
  };
  if (U.soon.length) html += section("New shows for you", `<div class="grid">${U.soon.map((x) => tile(x.s, { meta: dated(x.s) })).join("")}</div>`);
  if (U.fresh.length) html += section("Just premiered", rail("fresh", U.fresh.map((x) => tile(x.s, { meta: esc(x.s.c) || shortMeta(x.s) }))));
  if (U.tba.length) html += section("Announced", rail("tba", U.tba.map((x) => tile(x.s, { meta: esc(x.s.c) || "Date to come" }))));
  if (!catalog.length && !L.dated.length) html += `<div class="grid" style="margin-top:26px">${'<div class="poster skeleton"></div>'.repeat(6)}</div>`;
  return html;
}

function viewWatched() {
  const L = lists();
  let html = `<header class="page-head"><h1>Watched</h1><p>${plural(L.watched.length, "show")}</p></header>`;
  if (!L.watched.length)
    return (
      html +
      `<div class="empty"><h2>Your shelf is empty</h2><p>Add shows you've finished. They shape what Tonight suggests.</p><button class="act" data-act="find">${IC.search}Find a show</button></div>`
    );
  html += `<div class="grid" style="margin-top:20px">${L.watched
    .map((x) => tile(x.info, { badge: x.d.unseen ? `<span class="badge t-lilac">New</span>` : "" }))
    .join("")}</div>`;
  return html;
}

// Discover: search + filters
const F = { q: "", genres: new Set(), rating: 0, status: "", len: "", era: "", where: new Set(), type: "", sort: "match" };
let searchResults = null;
let searching = false;
let discoverLimit = 18;
const WHERE = {
  Netflix: ["Netflix"],
  "Prime Video": ["Prime Video"],
  HBO: ["HBO", "HBO Max", "Max"],
  "Apple TV": ["Apple TV", "Apple TV+"],
  "Disney+": ["Disney+"],
  Hulu: ["Hulu"],
  "Paramount+": ["Paramount+"],
  Peacock: ["Peacock"],
  BBC: ["BBC One", "BBC Two", "BBC Three", "BBC iPlayer"],
  FX: ["FX", "FXX"],
};
const GENRES = ["Drama", "Comedy", "Crime", "Thriller", "Mystery", "Science-Fiction", "Fantasy", "Romance", "Action", "Adventure", "Horror", "History", "Family", "Medical", "Legal", "Anime", "Supernatural", "Food", "Nature"];
const filterCount = () => F.genres.size + F.where.size + [F.rating, F.status, F.len, F.era, F.type].filter(Boolean).length;
function matchesFilters(s) {
  for (const g of F.genres) if (!s.g.includes(g)) return false;
  if (F.rating && s.r < F.rating) return false;
  if (F.status === "on" && s.s === "E") return false;
  if (F.status === "done" && s.s !== "E") return false;
  if (F.len === "short" && !(s.m > 0 && s.m <= 35)) return false;
  if (F.len === "long" && !(s.m > 35)) return false;
  if (F.type && s.t !== F.type) return false;
  if (F.era) {
    const y = +yearOf(s);
    const from = +F.era;
    if (from === 1990 ? y >= 2000 : y < from || y >= from + 10) return false;
  }
  if (F.where.size && ![...F.where].some((w) => WHERE[w].includes(s.c))) return false;
  return true;
}
function filtered() {
  const scored = new Map(recs().map((x) => [x.s.i, x.score]));
  const list = catalog.filter((s) => untracked(s) && matchesFilters(s));
  if (F.sort === "rating") list.sort((a, b) => b.r - a.r);
  else if (F.sort === "new") list.sort((a, b) => b.d.localeCompare(a.d));
  else list.sort((a, b) => (scored.get(b.i) ?? fit(b).match) - (scored.get(a.i) ?? fit(a).match));
  return list;
}
function discoverBody() {
  if (F.q.trim()) {
    if (searching && !searchResults) return `<p class="quiet" style="margin-top:14px">Searching…</p>`;
    if (!searchResults?.length) return `<p class="quiet" style="margin-top:14px">No shows called that. Check the spelling?</p>`;
    return `<div class="rows" style="margin-top:8px">${searchResults
      .map((info) => {
        const t = state.shows[info.i];
        const right = t
          ? `<span class="tag t-${TABS[t.status === "want" ? "upcoming" : t.status].tint}">${LABEL[t.status]}</span>`
          : `<button class="act plain" data-act="add" data-id="${info.i}" aria-label="Add ${esc(info.n)}">${IC.plus}Add</button>`;
        return `<article class="row" data-act="open" data-id="${info.i}" tabindex="0" role="button">${poster(info)}
          <div class="row-main"><h3>${esc(info.n)}</h3><p class="sub">${[yearOf(info), esc(info.c)].filter(Boolean).join(" · ")}</p></div>${right}</article>`;
      })
      .join("")}</div>`;
  }
  const n = filterCount();
  let html = `<div class="chips" data-rail="genres">
    <button class="chip" data-act="filters" aria-pressed="${n > 0}">${IC.sliders}Filters${n ? `<span class="n">${n}</span>` : ""}</button>
    ${GENRES.slice(0, 10)
      .map((g) => `<button class="chip" data-act="genre" data-v="${g}" aria-pressed="${F.genres.has(g)}">${g === "Science-Fiction" ? "Sci-fi" : g}</button>`)
      .join("")}</div>`;
  if (!catalog.length) return html + `<div class="grid" style="margin-top:14px">${'<div class="poster skeleton"></div>'.repeat(9)}</div>`;

  if (n) {
    const list = filtered();
    if (!list.length)
      return html + `<div class="empty"><h2>Nothing matches</h2><p>Try fewer filters.</p><button class="act plain" data-act="clear-filters">Clear filters</button></div>`;
    html += section(
      "Matches",
      `<div class="grid">${list.slice(0, discoverLimit).map((s) => tile(s, { meta: shortMeta(s) })).join("")}</div>`,
      { count: list.length, more: `<button class="more" data-act="clear-filters">Clear</button>` },
    );
    if (list.length > discoverLimit) html += `<div class="center"><button class="act plain" data-act="more-results">Show more</button></div>`;
    return html;
  }

  const has = taste().total > 0;
  const top = recs();
  html += section(has ? "For you" : "Popular right now", `<div class="grid">${top.slice(0, discoverLimit).map((x) => tile(x.s, { meta: shortMeta(x.s) })).join("")}</div>`);
  if (top.length > discoverLimit) html += `<div class="center"><button class="act plain" data-act="more-results">Show more</button></div>`;
  const anchors = taste()
    .anchors.slice()
    .sort((a, b) => b.loved - a.loved || b.added - a.added)
    .slice(0, 3);
  for (const a of anchors) {
    const like = moreLike(a.info);
    if (like.length) html += section(`More like ${esc(a.info.n)}`, rail("like" + a.info.i, like.map((s) => tile(s, { meta: shortMeta(s) }))));
  }
  return html;
}
function viewDiscover() {
  return `<header class="page-head"><h1>Discover</h1></header>
    <div class="search"><label class="search-box">${IC.search}
      <input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="Search any show" value="${esc(F.q)}" aria-label="Search any show">
      ${F.q ? `<button class="icon-btn" data-act="clear-q" aria-label="Clear search">${IC.x}</button>` : ""}
    </label></div>
    <div id="dbody">${discoverBody()}</div>`;
}
let searchTimer;
let searchSeq = 0;
function onSearch(value) {
  F.q = value;
  clearTimeout(searchTimer);
  if (!value.trim()) {
    searchResults = null;
    searching = false;
    render();
    return;
  }
  searching = true;
  searchResults = null;
  render();
  const seq = ++searchSeq;
  searchTimer = setTimeout(async () => {
    try {
      const res = await api(`/search/shows?q=${encodeURIComponent(value.trim())}`, true);
      if (seq !== searchSeq) return;
      searchResults = res.map((r) => fromApi(r.show));
    } catch {
      if (seq !== searchSeq) return;
      searchResults = [];
    }
    searching = false;
    render();
  }, 320);
}

const VIEWS = { home: viewHome, watching: viewWatching, upcoming: viewUpcoming, discover: viewDiscover, watched: viewWatched };
const $view = document.getElementById("view");
const $nav = document.getElementById("nav");
let shownTab = null;

function render() {
  memo = new Map();
  setSky();
  const rails = {};
  document.querySelectorAll("#view [data-rail]").forEach((el) => (rails[el.dataset.rail] = el.scrollLeft));
  const dbody = document.getElementById("dbody");
  if (tab === "discover" && shownTab === "discover" && dbody) {
    dbody.innerHTML = discoverBody(); // keep the search field (and keyboard) alive
    const clear = document.querySelector('[data-act="clear-q"]');
    if (!!clear !== !!F.q) {
      const box = document.querySelector(".search-box");
      clear ? clear.remove() : box.insertAdjacentHTML("beforeend", `<button class="icon-btn" data-act="clear-q" aria-label="Clear search">${IC.x}</button>`);
    }
  } else {
    $view.innerHTML = VIEWS[tab]();
    if (shownTab !== tab) {
      $view.classList.remove("fade");
      void $view.offsetWidth;
      $view.classList.add("fade");
      window.scrollTo(0, 0);
    }
  }
  shownTab = tab;
  document.querySelectorAll("#view [data-rail]").forEach((el) => {
    if (rails[el.dataset.rail]) el.scrollLeft = rails[el.dataset.rail];
  });
  renderNav();
}
function renderNav() {
  const hasNew = Object.keys(state.shows).some((id) => state.shows[id].status !== "want" && derive(+id).fresh);
  $nav.innerHTML = `<div class="inner">${Object.entries(TABS)
    .map(
      ([key, t]) => `<button class="tab" data-act="tab" data-tab="${key}" ${key === tab ? 'aria-current="page"' : ""}
        style="--tint:var(--${t.tint});--tint-ink:var(--${t.tint}-ink)">
        <span class="blob">${IC[key]}${key === "watching" && hasNew ? '<i class="dot"></i>' : ""}</span>${t.label}</button>`,
    )
    .join("")}</div>`;
}
let renderTimer;
function renderSoon() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    render();
    renderSheet();
  }, 200);
}
function go(next) {
  tab = next;
  discoverLimit = 18;
  history.replaceState(history.state, "", "#/" + tab);
  render();
}

// ───────────────────────── sheets ─────────────────────────
let sheet = null;
const $sheet = document.getElementById("sheet-root");
function openSheet(next) {
  const wasOpen = !!sheet;
  sheet = next;
  if (!wasOpen) history.pushState({ sheet: 1 }, "");
  renderSheet(true);
}
function closeSheet() {
  if (!sheet) return;
  if (history.state?.sheet) history.back();
  else {
    sheet = null;
    renderSheet();
  }
}
addEventListener("popstate", () => {
  sheet = null;
  renderSheet();
});

function showSheet() {
  const id = sheet.id;
  const t = state.shows[id];
  const info = t?.info || known.get(id);
  const d = derive(id);
  const c = cache[id];
  const ended = info.s === "E";
  const years = info.d ? (ended && info.e && info.e !== +yearOf(info) ? `${yearOf(info)}–${info.e}` : ended ? yearOf(info) : `${yearOf(info)}–`) : "";
  const meta = [info.r ? `<b>★ ${info.r.toFixed(1)}</b>` : "", years, esc(info.c)].filter(Boolean).join(" · ");
  const tint = (s) => TABS[s === "want" ? "upcoming" : s].tint;

  let note = "";
  if (sheet.pick) note = `<div class="d-note t-butter">Tonight's pick</div>`;
  else if (t && d.unseen && t.status !== "want")
    note = `<div class="d-note t-mint">${d.nextUp[2] === 1 && t.status === "watched" ? `Season ${d.nextUp[1]} is out` : `Up next: S${d.nextUp[1]} · E${d.nextUp[2]}`}</div>`;
  else if (d.nextAir) note = `<div class="d-note t-lilac">${d.aired ? "Next episode" : "Premieres"} ${dateStr(Date.parse(d.nextAir[4]))}${rel(Date.parse(d.nextAir[4])) ? " · " + rel(Date.parse(d.nextAir[4])) : ""}</div>`;
  else if (!d.aired && info.d > todayStr()) note = `<div class="d-note t-lilac">Premieres ${dateStr(dayTs(info.d))}</div>`;

  // seasons
  let seasons = "";
  if (!c) seasons = `<div class="season skeleton" style="height:54px;margin-top:22px"></div>`;
  else if (d.eps.length) {
    if (!sheet.open) {
      const focus = d.nextUp || d.nextAir;
      sheet.open = new Set(t && focus ? [focus[1]] : []);
    }
    const bySeason = new Map();
    for (const e of d.eps) (bySeason.get(e[1]) || bySeason.set(e[1], []).get(e[1])).push(e);
    seasons = `<div style="margin-top:22px">${[...bySeason]
      .map(([n, eps]) => {
        const aired = eps.filter((e) => isAired(e, ended));
        const seen = aired.filter((e) => d.seen.has(e[0])).length;
        const stateAttr = aired.length && seen === aired.length ? "true" : seen ? "mixed" : "false";
        const open = sheet.open.has(n);
        return `<div class="season" data-open="${open ? 1 : 0}">
          <div class="season-h" data-act="fold" data-season="${n}" role="button" tabindex="0" aria-expanded="${open}">
            <b>Season ${n}</b><span class="cnt">${aired.length ? `${seen}/${aired.length}` : "Soon"}</span>
            <button class="tick" data-act="season" data-season="${n}" aria-pressed="${stateAttr}" ${aired.length ? "" : "disabled"} aria-label="Mark all of season ${n} watched"><i>${IC.check}</i></button>
          </div>
          ${
            open
              ? `<div class="eps">${eps
                  .map((e) => {
                    const out = isAired(e, ended);
                    const when = e[4] ? dateStr(Date.parse(e[4])) : "";
                    return `<div class="ep ${out ? "" : "future"}"><span class="num">${e[2]}</span>
                      <div style="min-width:0"><div class="nm">${esc(e[3] || `Episode ${e[2]}`)}</div>${when ? `<span class="dt">${when}</span>` : ""}</div>
                      <button class="tick" data-act="ep" data-ep="${e[0]}" aria-pressed="${d.seen.has(e[0])}" ${out ? "" : "disabled"} aria-label="Episode ${e[2]} watched"><i>${IC.check}</i></button></div>`;
                  })
                  .join("")}</div>`
              : ""
          }</div>`;
      })
      .join("")}</div>`;
  }

  return `<div class="d-head">${poster(info)}<div><h2>${esc(info.n)}</h2><p class="d-meta">${meta}</p>
      <p class="d-meta">${info.g.slice(0, 3).map(esc).join(" · ")}</p></div></div>
    <div class="seg">${["want", "watching", "watched"]
      .map(
        (s) => `<button data-act="status" data-status="${s}" aria-pressed="${t?.status === s}" style="--tint:var(--${tint(s)});--tint-ink:var(--${tint(s)}-ink)">${LABEL[s]}</button>`,
      )
      .join("")}</div>
    <div class="d-tools">
      ${
        t && t.status !== "want"
          ? [["love", IC.heart + "Loved it"], ["ok", "It was okay"], ["no", "Didn't like it"]]
              .map(([v, label]) => `<button class="mini" data-act="feel" data-v="${v}" aria-pressed="${t.feel === v}">${label}</button>`)
              .join("")
          : ""
      }
      <button class="mini" data-act="websearch">${IC.search}${searchSeason(id) ? `Search season ${searchSeason(id)}` : "Search"}</button>
      ${t ? `<button class="mini" data-act="remove">${IC.bin}Remove</button>` : `<button class="mini" data-act="hide">${IC.hide}Not for me</button>`}
    </div>
    ${note}
    ${c?.sum ? `<p class="d-sum ${sheet.sumOpen ? "open" : ""}" data-act="sum">${esc(c.sum)}</p>` : ""}
    ${seasons}`;
}
function addSheet() {
  const info = known.get(sheet.id);
  return `<h2 class="s-title">${esc(info.n)}</h2>
    <div class="choice">
      <button class="t-mint" data-act="status" data-status="watching">${IC.watching}I'm watching it</button>
      <button class="t-sky" data-act="status" data-status="watched">${IC.watched}I've watched it</button>
      <button class="t-lilac" data-act="status" data-status="want">${IC.plus}I want to watch it</button>
    </div>`;
}
function filtersSheet() {
  const one = (key, opts) =>
    `<div class="chips wrap">${opts.map(([v, label]) => `<button class="chip" data-act="f-one" data-k="${key}" data-v="${v}" aria-pressed="${String(F[key]) === String(v)}">${label}</button>`).join("")}</div>`;
  const many = (key, opts) =>
    `<div class="chips wrap">${opts.map((v) => `<button class="chip" data-act="f-many" data-k="${key}" data-v="${v}" aria-pressed="${F[key].has(v)}">${v === "Science-Fiction" ? "Sci-fi" : v}</button>`).join("")}</div>`;
  const n = catalog.length ? filtered().length : 0;
  return `<h2 class="s-title">What are you in the mood for?</h2>
    <div class="f-group"><h3>Genre</h3>${many("genres", GENRES)}</div>
    <div class="f-group"><h3>Kind</h3>${one("type", [["Scripted", "Series"], ["Animation", "Animation"], ["Reality", "Reality"], ["Documentary", "Documentary"]])}</div>
    <div class="f-group"><h3>Rating</h3>${one("rating", [[7, "★ 7+"], [8, "★ 8+"], [8.5, "★ 8.5+"]])}</div>
    <div class="f-group"><h3>Episodes</h3>${one("len", [["short", "Short, under 35 min"], ["long", "Longer"]])}</div>
    <div class="f-group"><h3>Status</h3>${one("status", [["done", "Finished"], ["on", "Still going"]])}</div>
    <div class="f-group"><h3>From</h3>${many("where", Object.keys(WHERE))}</div>
    <div class="f-group"><h3>Era</h3>${one("era", [[2020, "2020s"], [2010, "2010s"], [2000, "2000s"], [1990, "Earlier"]])}</div>
    <div class="f-group"><h3>Order</h3>${one("sort", [["match", "Best for me"], ["rating", "Top rated"], ["new", "Newest"]])}</div>
    <div class="sheet-foot"><button class="act plain" data-act="clear-filters">Clear</button>
      <button class="act" data-act="close">Show ${n} ${n === 1 ? "show" : "shows"}</button></div>`;
}
function settingsSheet() {
  return `<h2 class="s-title">Settings</h2>
    <label class="field"><span>Your name</span><input id="name" value="${esc(state.name)}" maxlength="24" autocomplete="off"></label>
    <label class="field"><span>Words added to every search</span><input id="suffix" value="${esc(state.search ?? "watch")}" maxlength="60" autocomplete="off" autocapitalize="off" placeholder="e.g. watch"></label>
    <div class="f-group"><h3>Your shows</h3><div class="chips wrap">
      <button class="chip" data-act="refresh">Check for new episodes</button>
      <button class="chip" data-act="export">Save a backup</button>
      <button class="chip" data-act="import">Restore a backup</button></div></div>
    <p class="credit">Your list lives on this phone. Show info from <a href="https://www.tvmaze.com" target="_blank" rel="noopener">TVMaze</a>.</p>
    <input id="import-file" type="file" accept="application/json,.json" hidden>`;
}
function renderSheet(animate = false) {
  if (!sheet) {
    $sheet.innerHTML = "";
    document.body.style.overflow = "";
    return;
  }
  memo = new Map();
  const keep = $sheet.querySelector(".sheet-body")?.scrollTop || 0;
  const body = { show: showSheet, add: addSheet, filters: filtersSheet, settings: settingsSheet, link: linkSheet }[sheet.kind]();
  $sheet.innerHTML = `<div class="scrim" data-act="close"></div>
    <div class="sheet ${animate ? "" : "still"}" role="dialog" aria-modal="true">
      <div class="grab" data-act="close"></div>
      <button class="icon-btn sheet-x" data-act="close" aria-label="Close">${IC.x}</button>
      <div class="sheet-body">${body}</div></div>`;
  document.body.style.overflow = "hidden";
  if (!animate) $sheet.querySelector(".sheet-body").scrollTop = keep;
}
function openShow(id, extra = {}) {
  if (!known.get(id) && !state.shows[id]) return;
  const c = cache[id];
  if (!c || Date.now() - c.at > 36e5) loadShow(id, true);
  openSheet({ kind: "show", id, ...extra });
}

// The season worth searching for: the one you're on, else the one coming, else the latest.
function searchSeason(id) {
  const d = derive(id);
  const e = d.nextUp || d.nextAir || d.eps[d.eps.length - 1];
  return e ? e[1] : 0;
}

// A link ending in #add=… carries a list of shows to add: [id, status, feeling, [season, episode] watched through]
function readAddLink() {
  const m = location.hash.match(/^#add=([\w-]+)/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + "#/home");
  try {
    const list = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!Array.isArray(list) || !list.length || list.length > 400 || !list.every((x) => Array.isArray(x) && Number.isInteger(x[0]))) throw 0;
    openSheet({ kind: "link", list });
  } catch {
    toast("That link didn't work");
  }
}
function linkSheet() {
  const n = sheet.list.filter((x) => !state.shows[x[0]]).length;
  return `<h2 class="s-title">${n ? `Add ${plural(n, "show")} to Tonight?` : "Those shows are already here"}</h2>
    <div class="sheet-foot">${n ? `<button class="act" data-act="add-link">Add them</button>` : `<button class="act plain" data-act="close">Close</button>`}</div>`;
}
async function importList(list) {
  const todo = list.filter((x) => !state.shows[x[0]]);
  let done = 0;
  let missed = 0;
  for (const [id, code, feel, upto] of todo) {
    toast(`Adding your shows… ${done + 1} of ${todo.length}`);
    await loadShow(id);
    const info = known.get(id);
    const c = cache[id];
    done++;
    if (!info || !c) {
      missed++;
      continue;
    }
    const status = { w: "watched", g: "watching", l: "want" }[code] || "want";
    const ended = info.s === "E";
    const through = upto ? (e) => e[1] < upto[0] || (e[1] === upto[0] && e[2] <= upto[1]) : () => status === "watched";
    const t = { status, added: Date.now() - done * 1000, seen: c.eps.filter((e) => isAired(e, ended) && through(e)).map((e) => e[0]), info };
    if (["love", "ok", "no"].includes(feel)) t.feel = feel;
    state.shows[id] = t;
    tasteV++;
    save();
    renderSoon();
  }
  navigator.storage?.persist?.();
  toast(missed ? `Added ${done - missed} shows · ${missed} couldn't load` : `Added ${plural(done, "show")}`);
}

// ───────────────────────── toast ─────────────────────────
const $toast = document.getElementById("toast-root");
let toastTimer;
let toastAction = null;
function toast(text, actionLabel, action) {
  toastAction = action || null;
  $toast.innerHTML = `<div class="toast"><span>${esc(text)}</span>${actionLabel ? `<button data-act="toast">${esc(actionLabel)}</button>` : `<i style="width:10px"></i>`}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.innerHTML = ""), actionLabel ? 5200 : 2600);
}

// ───────────────────────── actions ─────────────────────────
function surprise() {
  const L = lists();
  const pool = [
    ...L.ready.flatMap((x) => [x.id, x.id, x.id]),
    ...L.back.flatMap((x) => [x.id, x.id]),
    ...L.listOut.flatMap((x) => [x.id, x.id]),
    ...recs()
      .slice(0, 14)
      .map((x) => x.s.i),
  ];
  if (!pool.length) return go("discover");
  openShow(pool[Math.floor(Math.random() * pool.length)], { pick: true });
}
function exportBackup() {
  const blob = new Blob([JSON.stringify(state)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tonight-backup-${todayStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("Backup saved to Downloads");
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.shows !== "object") throw new Error("bad file");
    for (const t of Object.values(data.shows)) if (!t.info?.n || !LABEL[t.status] || !Array.isArray(t.seen)) throw new Error("bad file");
    state = { v: 1, name: data.name || "Fay", shows: data.shows, hidden: data.hidden || [], search: data.search };
    commit();
    refreshAll();
    closeSheet();
    toast(`Restored ${plural(Object.keys(state.shows).length, "show")}`);
  } catch {
    toast("That file isn't a Tonight backup");
  }
}
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const ACTIONS = {
  tab: (el) => go(el.dataset.tab),
  find() {
    go("discover");
    requestAnimationFrame(() => document.getElementById("q")?.focus());
  },
  open: (el) => openShow(+el.dataset.id),
  add: (el) => openSheet({ kind: "add", id: +el.dataset.id }),
  next(el) {
    const id = +el.dataset.id;
    if (el.classList.contains("done")) return;
    el.classList.add("done");
    setTimeout(() => markNext(id), reduced ? 0 : 340);
  },
  start(el) {
    const id = +el.dataset.id;
    const snap = setStatus(id, "watching");
    toast(`${state.shows[id].info.n} moved to Watching`, "Undo", undoTo(id, snap));
  },
  status(el) {
    const id = sheet.id;
    const status = el.dataset.status;
    const wasAdd = sheet.kind === "add";
    if (state.shows[id]?.status === status) return;
    const name = (state.shows[id]?.info || known.get(id)).n;
    const snap = setStatus(id, status);
    if (wasAdd) {
      closeSheet();
      if (status === "watching") toast(`Watching ${name}`, "Set my episode", () => openShow(id));
      else toast(`${name} added to ${LABEL[status]}`, "Undo", undoTo(id, snap));
    } else toast(`${name} is in ${LABEL[status]}`, "Undo", undoTo(id, snap));
  },
  feel(el) {
    const t = state.shows[sheet.id];
    if (t.feel === el.dataset.v) delete t.feel;
    else t.feel = el.dataset.v;
    commit();
  },
  websearch() {
    const id = sheet.id;
    const info = state.shows[id]?.info || known.get(id);
    const season = searchSeason(id);
    const q = [info.n, season ? `season ${season}` : "", state.search ?? "watch"].filter(Boolean).join(" ");
    window.open("https://www.google.com/search?q=" + encodeURIComponent(q), "_blank", "noopener");
  },
  "add-link"() {
    const list = sheet.list;
    closeSheet();
    importList(list);
  },
  remove() {
    const id = sheet.id;
    closeSheet();
    removeShow(id);
  },
  hide() {
    const id = sheet.id;
    state.hidden.push(id);
    closeSheet();
    commit();
    toast("Got it, hidden", "Undo", () => {
      state.hidden = state.hidden.filter((x) => x !== id);
      commit();
    });
  },
  sum() {
    sheet.sumOpen = !sheet.sumOpen;
    renderSheet();
  },
  fold(el) {
    const n = +el.dataset.season;
    sheet.open.has(n) ? sheet.open.delete(n) : sheet.open.add(n);
    renderSheet();
  },
  season: (el) => toggleSeason(sheet.id, +el.dataset.season),
  ep: (el) => toggleEpisode(sheet.id, +el.dataset.ep),
  close: closeSheet,
  toast() {
    const fn = toastAction;
    $toast.innerHTML = "";
    fn?.();
  },
  surprise,
  settings: () => openSheet({ kind: "settings" }),
  filters: () => openSheet({ kind: "filters" }),
  genre(el) {
    const g = el.dataset.v;
    F.genres.has(g) ? F.genres.delete(g) : F.genres.add(g);
    discoverLimit = 18;
    render();
  },
  "f-one"(el) {
    const { k, v } = el.dataset;
    const val = k === "rating" ? +v : v;
    F[k] = String(F[k]) === v ? (k === "rating" ? 0 : k === "sort" ? "match" : "") : val;
    discoverLimit = 18;
    render();
    renderSheet();
  },
  "f-many"(el) {
    const { k, v } = el.dataset;
    F[k].has(v) ? F[k].delete(v) : F[k].add(v);
    discoverLimit = 18;
    render();
    renderSheet();
  },
  "clear-filters"() {
    Object.assign(F, { genres: new Set(), rating: 0, status: "", len: "", era: "", where: new Set(), type: "", sort: "match" });
    render();
    renderSheet();
  },
  "clear-q"() {
    const q = document.getElementById("q");
    q.value = "";
    onSearch("");
    q.focus();
  },
  "more-results"() {
    discoverLimit += 18;
    render();
  },
  refresh() {
    refreshAll(true);
    closeSheet();
    toast("Checking for new episodes…");
  },
  export: exportBackup,
  import: () => document.getElementById("import-file").click(),
};

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el || el.disabled) return;
  ACTIONS[el.dataset.act]?.(el, ev);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && sheet) return closeSheet();
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches('[role="button"][data-act]')) {
    ev.preventDefault();
    ev.target.click();
  }
});
document.addEventListener("input", (ev) => {
  if (ev.target.id === "q") onSearch(ev.target.value);
  if (ev.target.id === "suffix") {
    state.search = ev.target.value.trim();
    save();
  }
  if (ev.target.id === "name") {
    state.name = ev.target.value.trim();
    save();
    render();
  }
});
document.addEventListener("change", (ev) => {
  if (ev.target.id === "import-file" && ev.target.files[0]) importBackup(ev.target.files[0]);
});
document.addEventListener("submit", (ev) => ev.preventDefault());

// ───────────────────────── start ─────────────────────────
for (const t of Object.values(state.shows)) known.set(t.info.i, t.info);
render();
loadData();
refreshAll();
readAddLink();
addEventListener("hashchange", readAddLink);
let lastCheck = Date.now();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (Date.now() - lastCheck > 30 * 6e4) {
    lastCheck = Date.now();
    refreshAll();
    loadData();
  }
  render(); // episodes may have aired while the app was in the background
});
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => {});
