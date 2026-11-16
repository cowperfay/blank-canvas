// Builds the two small data files the app uses for recommendations:
//   docs/data/catalog.json  – well-known shows that are already out
//   docs/data/upcoming.json – shows premiering soon (or that just premiered)
// Source: the free TVMaze API (no key needed). Run: node scripts/build-data.mjs
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "data");
const API = "https://api.tvmaze.com";
const IMG = "https://static.tvmaze.com/uploads/images/medium_portrait/";
const CATALOG_SIZE = 3500;
const FRESH_DAYS = 75; // "just premiered" window
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage(page) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(`${API}/shows?page=${page}`);
      if (res.status === 404) return null;
      if (res.status === 429) {
        await sleep(3000 + attempt * 2000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 7) throw err;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw new Error(`Gave up on page ${page}`);
}

async function scanAll() {
  const shows = [];
  let next = 0;
  let done = false;
  async function worker() {
    while (!done) {
      const page = next++;
      const data = await getPage(page);
      if (data === null) {
        done = true;
        return;
      }
      shows.push(...data);
      if (page % 25 === 0) console.log(`page ${page} · ${shows.length} shows`);
      await sleep(900);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return shows;
}

const channel = (s) => s.webChannel?.name || s.network?.name || "";
const country = (s) => s.network?.country?.code || s.webChannel?.country?.code || "";
const statusCode = (s) =>
  ({ Running: "R", Ended: "E", "To Be Determined": "T", "In Development": "D" })[s.status] || "E";

function compact(s) {
  return {
    i: s.id,
    n: s.name,
    g: s.genres || [],
    t: s.type || "",
    l: s.language || "",
    s: statusCode(s),
    d: s.premiered || "",
    e: s.ended ? +s.ended.slice(0, 4) : 0,
    r: s.rating?.average || 0,
    w: s.weight || 0,
    c: channel(s),
    k: country(s),
    m: s.averageRuntime || s.runtime || 0,
    p: s.image?.medium?.startsWith(IMG) ? s.image.medium.slice(IMG.length) : "",
  };
}

async function main() {
  let all;
  if (process.env.RAW_IN) {
    all = JSON.parse(await readFile(process.env.RAW_IN, "utf8"));
  } else {
    all = await scanAll();
    if (process.env.RAW_OUT) await writeFile(process.env.RAW_OUT, JSON.stringify(all));
  }
  console.log(`scanned ${all.length} shows`);
  if (all.length < 20000) throw new Error("Scan looks incomplete – keeping the existing data.");

  const today = new Date().toISOString().slice(0, 10);
  const freshFrom = new Date(Date.now() - FRESH_DAYS * 864e5).toISOString().slice(0, 10);
  const SKIP_TYPES = new Set(["News", "Sports", "Award Show", "Panel Show"]);
  const usable = all.filter((s) => s.image?.medium && !SKIP_TYPES.has(s.type));

  // Already out: rank by popularity (weight) with a nudge for strong ratings.
  const out = usable
    .filter((s) => s.premiered && s.premiered <= today)
    .map((s) => ({ s, score: (s.weight || 0) + (s.rating?.average ? (s.rating.average - 6.5) * 4 : -4) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CATALOG_SIZE)
    .map(({ s }) => compact(s));

  // Coming soon (dated), announced without a date, or freshly premiered.
  const upcoming = usable
    .filter((s) => {
      if (s.premiered && s.premiered > today) return true;
      if (s.premiered && s.premiered >= freshFrom) return (s.weight || 0) >= 20;
      return !s.premiered && s.status === "In Development" && (s.weight || 0) >= 40;
    })
    .map((s) => compact(s))
    .sort((a, b) => (a.d || "9999").localeCompare(b.d || "9999"));

  await mkdir(OUT, { recursive: true });
  const stamp = new Date().toISOString();
  await writeFile(join(OUT, "catalog.json"), JSON.stringify({ updated: stamp, shows: out }));
  await writeFile(join(OUT, "upcoming.json"), JSON.stringify({ updated: stamp, shows: upcoming }));
  console.log(`catalog: ${out.length} · upcoming: ${upcoming.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
