/*
Instagram outreach: find businesses that have no website and DM them.

Usage:
    node outreach.mjs ui                    local dashboard at http://localhost:3210
    node outreach.mjs login                 log in to Instagram in the opened browser
    node outreach.mjs find                  search every niche x location from config.json
    node outreach.mjs find --niche cafe --location Islamabad
    node outreach.mjs list                  show leads waiting for a DM
    node outreach.mjs send --dry-run        preview messages, send nothing
    node outreach.mjs send --review         approve each message before it is sent
    node outreach.mjs send                  send up to the daily limit with human-like pacing
    node outreach.mjs send --limit 5
    node outreach.mjs export                write leads.csv
*/
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const ROOT = import.meta.dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
// Agency niches (marketing / web design companies) get an outsourcing pitch instead of the
// "you have no website" one, and are kept even though they have a website.
CONFIG.agency_niches ??= ["marketing agency", "web design agency"];
CONFIG.agency_templates ??= [
  "{Hi|Hey|Hello} [name]!\n\n{I'm [me], a web designer and developer|My name is [me], I'm a web designer and developer}. {I've already built websites for quite a few businesses|I have built websites for a good number of businesses in different industries}.\n\n{If you ever have more work than your team can handle|Whenever your team is overloaded or a deadline is tight}, {you can outsource the work to me|I can take website projects off your plate}. {I do WordPress sites as well as fast custom vibe-coded websites|WordPress or custom vibe-coded builds, whichever fits the project}, {all white-label so the client stays yours|and everything is white-label}.\n\n{Happy to share my portfolio if you're open to it.|Can I send you a few of my recent projects?|Want to see some of my recent work?} {🙂|😊|}\n\n- [me]",
  "{Hi|Hey} [name], {hope you're doing well|hope things are going great}!\n\n{I'm a freelance web designer and developer|I'm [me], a freelance web designer and developer} and {I've built websites for many businesses already|I've delivered websites for a lot of small businesses}.\n\n{I know agencies sometimes get more projects than they have time for|Agencies often need an extra pair of hands when work piles up}. {If you have any overflow work, you can outsource it to me|If that happens, I'd be glad to handle website projects for you}, {delivered on time under your brand|delivered under your name at a fair fixed price}.\n\n{I can also do vibe-coded websites when a client needs something quick and custom|For quick turnarounds I also build vibe-coded websites, so small projects can be done in days}.\n\n{Would you be open to a quick chat?|Should I send over some samples?|Open to seeing a few samples?} {🙂|😊|}\n\n- [me]",
  "{Hi|Hey|Hello} [name]!\n\n{Quick question|Just a quick one}: {do you ever outsource website work?|does your team ever outsource web design or development?}\n\n{I'm [me], a web designer and developer|I'm a web designer and developer}, and {I've built websites for a lot of businesses|I've already done websites for many businesses}. {I work with WordPress and also build vibe-coded websites|I do both WordPress and vibe-coded websites}, {so I can fit whatever your client needs|depending on the budget and deadline}.\n\n{If you have extra projects or tight deadlines, I can help under your brand.|If you ever need extra hands, I'd be happy to help white-label.}\n\n{Can I send you some of my work?|Want to see a few samples?} {🙂|😊|}\n\n- [me]",
];
const isAgency = (niche) => CONFIG.agency_niches.some((n) => n.toLowerCase() === String(niche).toLowerCase());
const DB_PATH = path.join(ROOT, "leads.db");
const PROFILE_DIR = path.join(ROOT, "browser_profile");
const SESSION_PATH = path.join(ROOT, "session.json");
const IG = "https://www.instagram.com";
const IG_APP_ID = "936619743392459";
const PROFILE_QUERY = "PolarisProfilePageContentQuery";

// Links that are not a real website: socials, chat links, link-in-bio pages, maps, booking and delivery platforms.
const NON_SITE_DOMAINS = [
  "wa.me", "whatsapp.com", "wa.link", "linktr.ee", "facebook.com", "fb.com", "fb.me", "m.me",
  "instagram.com", "threads.net", "threads.com", "tiktok.com", "youtube.com", "youtu.be", "t.me",
  "snapchat.com", "twitter.com", "x.com", "pinterest.com", "beacons.ai", "linkin.bio",
  "taplink.cc", "taplink.ws", "taplink.at", "lnk.bio", "campsite.bio", "bio.link", "msha.ke",
  "goo.gl", "g.page", "g.co", "google.com", "forms.gle",
  "fresha.com", "booksy.com", "calendly.com", "talabat.com", "zomato.com", "foodpanda.pk",
  "foodpanda.com", "daraz.pk", "etsy.com", "amazon.com", "amzn.to", "apple.com", "spotify.com",
];
const BIO_DOMAIN_RE =
  /\b(?:https?:\/\/|www\.)?[\w-]+(?:\.[\w-]+)*\.(?:com|pk|net|org|co|io|shop|store|ae|uk|in|biz|info)\b(?:\/\S*)?/gi;
const EMAIL_RE = /\S+@\S+/g;

// ---------- helpers ----------

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (items) => items[Math.floor(Math.random() * items.length)];
const pause = (lo, hi) => sleep(rand(lo, hi) * 1000);
const now = () => new Date().toLocaleString("sv-SE").replace(" ", "T"); // local YYYY-MM-DDTHH:MM:SS
const firstLine = (err) => String(err?.message ?? err).split("\n")[0].slice(0, 200);

// Set by the dashboard's Stop button; every wait checks it so a running job ends quickly.
let aborted = false;
async function sleep(ms) {
  const end = Date.now() + ms;
  do {
    if (aborted) throw new Error("Stopped");
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(500, end - Date.now()))));
  } while (Date.now() < end);
}

// ---------- storage ----------

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS leads (
    username TEXT PRIMARY KEY,
    full_name TEXT, category TEXT, followers INTEGER, bio TEXT,
    links TEXT, email TEXT, phone TEXT,
    niche TEXT, location TEXT,
    status TEXT,          -- new | sent | skipped | failed | rejected
    note TEXT, message TEXT,
    found_at TEXT, sent_at TEXT
  )`);
  // kind: business (no-website pitch) | agency (outsourcing pitch)
  if (!db.prepare("PRAGMA table_info(leads)").all().some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE leads ADD COLUMN kind TEXT DEFAULT 'business'");
  }
  return db;
}

function sentToday(db) {
  const today = now().slice(0, 10);
  return db.prepare("SELECT COUNT(*) AS n FROM leads WHERE status='sent' AND sent_at LIKE ?").get(`${today}%`).n;
}

// ---------- browser ----------

// When the dashboard is running it owns one browser window; jobs open a new tab in it.
let sharedCtx = null;
let jobPage = null;

const hasSession = (cookies) => cookies.some((c) => c.name === "sessionid");

// The login lives in browser_profile/; session.json is a backup so a lost profile never forces a new login.
async function saveSession(ctx) {
  const cookies = await ctx.cookies(IG);
  if (hasSession(cookies)) writeFileSync(SESSION_PATH, JSON.stringify(cookies));
}

async function launchContext(viewport) {
  const { chromium } = await import("playwright");
  const opts = { headless: false, viewport };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, { channel: "chrome", ...opts });
  } catch {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
  if (!hasSession(await ctx.cookies(IG)) && existsSync(SESSION_PATH)) {
    await ctx.addCookies(JSON.parse(readFileSync(SESSION_PATH, "utf8"))).catch(() => {});
  }
  return ctx;
}

async function withBrowser(fn) {
  if (sharedCtx) {
    jobPage = await sharedCtx.newPage();
    try {
      return await fn(jobPage);
    } finally {
      await saveSession(sharedCtx).catch(() => {});
      await jobPage.close().catch(() => {});
      jobPage = null;
    }
  }
  const ctx = await launchContext({ width: 1280, height: 850 });
  try {
    return await fn(ctx.pages()[0] ?? (await ctx.newPage()));
  } finally {
    await saveSession(ctx).catch(() => {});
    await ctx.close();
  }
}

async function loggedIn(page) {
  return hasSession(await page.context().cookies(IG));
}

// Opens Instagram; if there is no session it shows the login page and waits for the user to log in.
async function openInstagram(page) {
  await page.goto(IG + "/", { waitUntil: "domcontentloaded" });
  if (!(await loggedIn(page))) {
    console.log("Not logged in to Instagram. Log in in the tab that just opened (waiting up to 5 minutes)...");
    await page.goto(IG + "/accounts/login/", { waitUntil: "domcontentloaded" });
    for (let i = 0; i < 150 && !(await loggedIn(page)); i++) await sleep(2000);
    if (!(await loggedIn(page))) {
      console.log("Login not detected.");
      return false;
    }
    await pause(4, 6);
    console.log("Logged in. You will not need to log in again.");
    await page.goto(IG + "/", { waitUntil: "domcontentloaded" });
  }
  await saveSession(page.context());
  await pause(1.5, 3);
  return true;
}

// Call an Instagram web endpoint from inside the logged-in page.
function apiGet(page, url) {
  return page.evaluate(
    async ([url, appId]) => {
      const r = await fetch(url, { headers: { "x-ig-app-id": appId }, credentials: "include" });
      if (!r.ok) return { __status: r.status };
      try {
        return await r.json();
      } catch {
        return { __status: "not-json" };
      }
    },
    [url, IG_APP_ID],
  );
}

async function blocked(page) {
  if (page.url().includes("/challenge/") || page.url().includes("/accounts/suspended")) return true;
  return (await page.getByText("Try Again Later").count()) > 0;
}

// ---------- finding leads ----------

function hostOf(url) {
  try {
    return new URL(url.includes("://") ? url : "http://" + url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const profileLinks = (user) => [user.external_url, ...(user.bio_links ?? []).map((l) => l.url)].filter(Boolean);

// Return the links on a profile that look like an actual website.
export function realWebsites(user) {
  const bio = (user.biography ?? "").replace(EMAIL_RE, " ");
  return [...profileLinks(user), ...(bio.match(BIO_DOMAIN_RE) ?? [])].filter((url) => {
    const host = hostOf(url);
    return host && !NON_SITE_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  });
}

export function rejectReason(user, kind = "business") {
  const f = CONFIG.filters;
  const followers = user.follower_count ?? 0;
  const posts = user.media_count ?? 0;
  // account_type 1 is a personal account; 2 and 3 are business and creator
  const isBusiness = user.is_business || user.is_professional_account || user.account_type > 1 || user.category;
  if (user.is_private) return "private";
  if (f.business_only && !isBusiness) return "not a business account";
  if (followers < f.min_followers || followers > f.max_followers) return `followers ${followers}`;
  if (posts < f.min_posts) return `only ${posts} posts`;
  const sites = kind === "agency" ? [] : realWebsites(user);
  if (sites.length) return `has website ${hostOf(sites[0])}`;
  return null;
}

// Collect every {username, pk} pair anywhere in a search response.
function collectUsers(node, into) {
  if (!node || typeof node !== "object") return;
  if (typeof node.username === "string" && (node.pk || node.id) && !node.is_private) {
    into.set(node.username, String(node.pk ?? node.id));
  }
  for (const value of Object.values(node)) collectUsers(value, into);
}

// Accounts for a search phrase: owners of the posts in keyword search, plus the account search.
async function discover(page, niche, location) {
  const found = new Map();
  const phrases = [
    `${niche} ${location}`, `${location} ${niche}`, `${niche} in ${location}`, `best ${niche} ${location}`,
    `#${(niche + location).replace(/\s+/g, "")}`,
  ];
  keyword: for (const phrase of phrases) {
    const query = encodeURIComponent(phrase);
    let next = "";
    for (let i = 0; i < CONFIG.find.search_pages; i++) {
      const data = await apiGet(page, `/api/v1/fbsearch/web/top_serp/?enable_metadata=true&query=${query}${next}`);
      if ("__status" in data) {
        console.log(`  keyword search stopped (status ${data.__status})`);
        break keyword;
      }
      collectUsers(data, found);
      const grid = data.media_grid ?? {};
      if (!grid.has_more || !grid.next_max_id) break;
      next = `&next_max_id=${grid.next_max_id}&rank_token=${data.rank_token ?? ""}`;
      await pause(0.8, 1.6);
    }
    console.log(`  "${phrase}": ${found.size} accounts so far`);
  }
  // account search returns only a handful per query, so a letter is appended to reach different accounts
  const suffixes = ["", ...(CONFIG.find.deep_account_search ? "abcdefghijklmnopqrstuvwxyz" : "")];
  for (const suffix of suffixes) {
    const phrase = `${niche} ${location} ${suffix}`.trim();
    const data = await apiGet(page, `/api/v1/web/search/topsearch/?context=user&query=${encodeURIComponent(phrase)}`);
    if ("__status" in data) break;
    collectUsers(data.users, found);
    await pause(0.4, 0.9);
  }
  console.log(`  account search done: ${found.size} accounts in total`);
  return found;
}

// Open one profile the normal way and keep the data request the site itself makes, so lookups
// replay exactly what Instagram's own page sends (its other profile endpoints answer 429).
async function learnProfileQuery(page, username) {
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.headers()["x-fb-friendly-name"] === PROFILE_QUERY, { timeout: 30000 }),
    page.goto(`${IG}/${username}/`, { waitUntil: "domcontentloaded" }),
  ]);
  await pause(1.5, 3);
  const headers = request.headers();
  return { url: request.url(), body: request.postData(), csrf: headers["x-csrftoken"], lsd: headers["x-fb-lsd"] };
}

async function fetchProfile(page, query, id) {
  const params = new URLSearchParams(query.body);
  params.set("variables", JSON.stringify({ ...JSON.parse(params.get("variables")), id }));
  return page.evaluate(
    async ([url, body, lsd, csrf, appId, name]) => {
      const r = await fetch(url, {
        method: "POST",
        credentials: "include",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": name,
          "x-fb-lsd": lsd,
          "x-csrftoken": csrf,
          "x-ig-app-id": appId,
        },
      });
      if (!r.ok) return { status: r.status };
      try {
        return { status: 200, user: (await r.json()).data?.user ?? null };
      } catch {
        return { status: "not-json" };
      }
    },
    [query.url, params.toString(), query.lsd, query.csrf, IG_APP_ID, PROFILE_QUERY],
  );
}

// A location is {country, city}; plain strings from older configs count as a city.
const asLocation = (loc) =>
  typeof loc === "string"
    ? { country: "", city: loc.trim() }
    : { country: String(loc?.country ?? "").trim(), city: String(loc?.city ?? "").trim() };

async function cmdFind(args) {
  const niches = args.niche ? [args.niche] : [...CONFIG.niches, ...CONFIG.agency_niches];
  const locations = args.location ? [{ country: "", city: args.location }] : CONFIG.locations.map(asLocation);
  const limit = CONFIG.find.max_profiles_per_run;
  const db = openDb();
  const known = db.prepare("SELECT 1 FROM leads WHERE username=?");
  const insert = db.prepare(
    `INSERT OR IGNORE INTO leads (username, full_name, category, followers, bio, links, niche, location, status, note, found_at, kind)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let checked = 0;
  let found = 0;

  await withBrowser(async (page) => {
    if (!(await openInstagram(page))) return;
    let query = null;
    for (const niche of niches) {
      for (const { city, country } of locations) {
        // search by the city or area; the country alone is used only when no city was picked
        const location = [city, country].filter(Boolean).join(", ");
        console.log(`\n== ${niche} / ${location} ==`);
        const candidates = [...(await discover(page, niche, city || country))].filter(([username]) => !known.get(username));
        console.log(`  ${candidates.length} new accounts to check`);
        for (const [username, id] of candidates) {
          if (checked >= limit) {
            console.log(`\nReached ${limit} profiles for this run.`);
            return;
          }
          query ??= await learnProfileQuery(page, username);
          let result = await fetchProfile(page, query, id);
          if (result.status !== 200) {
            // tokens may have expired: pick them up again once before giving up
            await pause(20, 30);
            query = await learnProfileQuery(page, username);
            result = await fetchProfile(page, query, id);
          }
          if (result.status !== 200) {
            console.log(`\nInstagram refused the profile lookup (status ${result.status}). Try again in an hour or two.`);
            return;
          }
          checked++;
          const user = result.user;
          const kind = isAgency(niche) ? "agency" : "business";
          const reason = user ? rejectReason(user, kind) : "profile unavailable";
          insert.run(
            username, user?.full_name ?? null, user?.category || null, user?.follower_count ?? 0,
            user?.biography ?? null, user ? profileLinks(user).join(" ") : "", niche, location,
            reason ? "rejected" : "new", reason, now(), kind,
          );
          if (reason) {
            console.log(`  skip  @${username}: ${reason}`);
          } else {
            found++;
            console.log(`  LEAD  @${username} (${user.full_name})`);
          }
          await pause(...CONFIG.find.profile_delay_seconds);
        }
      }
    }
  });
  console.log(`\nChecked ${checked} profiles, found ${found} new leads.`);
}

// ---------- messages ----------

// 'Sweet Tooth Bakery | Custom Cakes 🎂' -> 'Sweet Tooth Bakery'; falls back to 'there'.
export function displayName(fullName) {
  // NFKC turns the fancy unicode letters people use in names back into plain ones
  let name = (fullName ?? "").normalize("NFKC").split(/[|•·:,(\[\/]| - | – /)[0];
  name = name.replace(/[^\w\s&'.-]/g, "").replace(/\s+/g, " ").replace(/^[\s._-]+|[\s._-]+$/g, "");
  if (!name || name.length > 30 || !/[A-Za-z]/.test(name)) return "there";
  if (name === name.toUpperCase() || name === name.toLowerCase()) {
    name = name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return name;
}

export function renderMessage(lead) {
  let text = pick(lead.kind === "agency" ? CONFIG.agency_templates : CONFIG.templates);
  for (;;) {
    const spun = text.replace(/\{([^{}]*)\}/g, (_, options) => pick(options.split("|")));
    if (spun === text) break;
    text = spun;
  }
  return text
    .replaceAll("[name]", displayName(lead.full_name))
    .replaceAll("[niche]", lead.niche ?? "")
    .replaceAll("[me]", CONFIG.sender_name)
    .replace(/ {2,}/g, " ")
    .replace(/ +([\n.,!?])/g, "$1")
    .trim();
}

// ---------- sending ----------

async function humanType(page, text) {
  const [lo, hi] = CONFIG.send.typing_delay_ms;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i) await page.keyboard.press("Shift+Enter");
    for (const ch of lines[i]) {
      await page.keyboard.type(ch);
      await sleep(rand(lo, hi));
      if (".!?,".includes(ch) && Math.random() < 0.4) await pause(0.4, 1.2);
    }
  }
}

async function sendDm(page, username, text) {
  await page.goto(`${IG}/${username}/`, { waitUntil: "domcontentloaded" });
  await pause(3, 6);
  // look at the profile for a moment like a person would
  await page.mouse.wheel(0, rand(400, 1200));
  await pause(2, 5);
  await page.mouse.wheel(0, -1500);
  await pause(1, 3);

  await page.getByRole("button", { name: "Message", exact: true }).first().click({ timeout: 15000 });
  await pause(3, 6);
  const notNow = page.getByRole("button", { name: "Not Now" });
  if (await notNow.count()) {
    await notNow.first().click();
    await pause(1, 2);
  }

  const box = page.getByRole("textbox").first();
  await box.waitFor({ timeout: 20000 });
  await box.click();
  await pause(1, 3);
  await humanType(page, text);
  await pause(1, 3);
  await page.keyboard.press("Enter");
  await pause(3, 5);
  if ((await box.innerText()).trim()) throw new Error("message still in the box after pressing Enter");
}

async function cmdSend(args) {
  const db = openDb();
  const cap = CONFIG.send.daily_limit;
  let remaining = Math.max(cap - sentToday(db), 0);
  if (args.limit) remaining = Math.min(remaining, Number(args.limit));
  const leads = db.prepare("SELECT * FROM leads WHERE status='new' ORDER BY found_at").all();

  if (args["dry-run"]) {
    for (const lead of leads.slice(0, remaining)) console.log(`\n--- @${lead.username} ---\n${renderMessage(lead)}`);
    console.log(`\n${leads.length} leads waiting, ${remaining} sends left today (limit ${cap}).`);
    return;
  }
  if (remaining <= 0) return console.log(`Daily limit of ${cap} reached. Come back tomorrow.`);
  if (!leads.length) return console.log("No leads waiting. Find leads first.");

  const setStatus = db.prepare("UPDATE leads SET status=?, note=? WHERE username=?");
  const markSent = db.prepare("UPDATE leads SET status='sent', message=?, sent_at=? WHERE username=?");
  const rl = args.review ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let sent = 0;

  await withBrowser(async (page) => {
    if (!(await openInstagram(page))) return;
    for (const lead of leads) {
      if (sent >= remaining) break;
      const text = renderMessage(lead);
      if (rl) {
        console.log(`\n--- @${lead.username} (${lead.full_name}) ---\n${text}`);
        const answer = (await rl.question("Send? [y = send / n = skip / q = quit] ")).trim().toLowerCase();
        if (answer === "q") break;
        if (answer !== "y") {
          setStatus.run("skipped", null, lead.username);
          continue;
        }
      }
      try {
        await sendDm(page, lead.username, text);
      } catch (err) {
        if (aborted) throw err;
        if (await blocked(page)) {
          console.log("\nInstagram is showing a block/challenge. Stopping. Wait 24-48h before sending again.");
          break;
        }
        setStatus.run("failed", firstLine(err), lead.username);
        console.log(`  failed @${lead.username}: ${firstLine(err)}`);
        await pause(20, 40);
        continue;
      }
      markSent.run(text, now(), lead.username);
      sent++;
      console.log(`  sent ${sent}/${remaining} -> @${lead.username}`);
      if (sent < remaining) {
        const wait = rand(...CONFIG.send.delay_between_dms_seconds);
        console.log(`  waiting ${(wait / 60).toFixed(1)} min`);
        await sleep(wait * 1000);
      }
    }
  });
  rl?.close();
  console.log(`\nSent ${sent} messages this run, ${sentToday(db)}/${cap} today.`);
}

// ---------- other commands ----------

async function cmdLogin() {
  await withBrowser(async (page) => {
    if (await openInstagram(page)) console.log("Instagram is connected.");
  });
}

function cmdList() {
  const db = openDb();
  for (const lead of db.prepare("SELECT * FROM leads WHERE status='new' ORDER BY found_at").all()) {
    console.log(`@${lead.username.padEnd(30)} ${String(lead.followers).padStart(7)}  ` +
      `${lead.niche}/${lead.location}  ${lead.full_name}`);
  }
  const counts = db.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all();
  console.log("\n" + (counts.map((c) => `${c.status}: ${c.n}`).join(", ") || "no leads yet"));
}

function cmdExport() {
  const db = openDb();
  const rows = db.prepare("SELECT * FROM leads WHERE status NOT IN ('rejected', 'deleted') ORDER BY found_at").all();
  const cell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = rows.length ? [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.values(r).map(cell).join(","))] : [];
  const out = path.join(ROOT, "leads.csv");
  writeFileSync(out, "﻿" + lines.join("\r\n"), "utf8");
  console.log(`Wrote ${rows.length} leads to ${out}`);
}

// ---------- local dashboard ----------

// Validate what the settings form sent and persist it to config.json.
function applyConfig(next) {
  const strings = (list) => [...new Set((Array.isArray(list) ? list : []).map((s) => String(s).trim()).filter(Boolean))];
  const number = (value, fallback, min = 0) => (Number.isFinite(Number(value)) ? Math.max(min, Math.floor(Number(value))) : fallback);
  const templates = strings(next.templates);
  const f = CONFIG.filters;
  const gap = CONFIG.send.delay_between_dms_seconds;
  const gapLo = number(next.send?.delay_between_dms_seconds?.[0], gap[0], 20);
  Object.assign(CONFIG, {
    niches: strings(next.niches),
    locations: [...new Map((Array.isArray(next.locations) ? next.locations : []).map(asLocation)
      .filter((l) => l.city || l.country).map((l) => [`${l.city}|${l.country}`.toLowerCase(), l])).values()],
    sender_name: String(next.sender_name ?? "").trim() || CONFIG.sender_name,
    filters: {
      business_only: Boolean(next.filters?.business_only),
      min_followers: number(next.filters?.min_followers, f.min_followers),
      max_followers: number(next.filters?.max_followers, f.max_followers),
      min_posts: number(next.filters?.min_posts, f.min_posts),
    },
    send: {
      ...CONFIG.send,
      daily_limit: number(next.send?.daily_limit, CONFIG.send.daily_limit, 1),
      delay_between_dms_seconds: [gapLo, Math.max(gapLo, number(next.send?.delay_between_dms_seconds?.[1], gap[1], 20))],
    },
    autopilot: {
      enabled: Boolean(next.autopilot?.enabled),
      hour: Math.min(23, number(next.autopilot?.hour, CONFIG.autopilot?.hour ?? 10)),
      last_run: CONFIG.autopilot?.last_run ?? "",
    },
    templates: templates.length ? templates : CONFIG.templates,
    agency_niches: strings(next.agency_niches),
    agency_templates: strings(next.agency_templates).length ? strings(next.agency_templates) : CONFIG.agency_templates,
  });
  writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2) + "\n");
}

async function cmdUi(args) {
  const { createServer } = await import("node:http");
  const port = Number(args.port ?? 3210);
  const url = `http://localhost:${port}`;
  const db = openDb();
  const job = { name: "", running: false, log: "" };
  const handlers = { find: cmdFind, send: cmdSend, login: cmdLogin, auto: autopilot };

  // One unattended round: top up the lead list if it is short, then send today's messages.
  async function autopilot() {
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE status='new'").get().n;
    const remaining = CONFIG.send.daily_limit - sentToday(db);
    if (remaining <= 0) return console.log("Daily limit already reached.");
    if (waiting < remaining) await cmdFind({});
    await cmdSend({});
  }

  // jobs run in this process, so mirror their console output into the dashboard log
  const print = console.log;
  console.log = (...parts) => {
    print(...parts);
    if (job.running) job.log = (job.log + parts.join(" ") + "\n").slice(-20000);
  };

  // Open the tool's browser with the dashboard in the first tab (reopens it if it was closed).
  async function ensureBrowser() {
    if (sharedCtx) return;
    const ctx = await launchContext(null);
    ctx.on("close", () => (sharedCtx = null));
    sharedCtx = ctx;
    await (ctx.pages()[0] ?? (await ctx.newPage())).goto(url);
  }

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return JSON.parse(raw || "{}");
  };

  function run(body) {
    if (job.running) return "A job is already running";
    const handler = handlers[body.command];
    if (!handler) return "Unknown command";
    const jobArgs = {};
    if (body.command === "send" && Number(body.limit) > 0) jobArgs.limit = Math.floor(body.limit);
    Object.assign(job, { name: body.command, running: true, log: "" });
    aborted = false;
    ensureBrowser()
      .then(() => handler(jobArgs))
      .catch((err) => console.log(aborted ? "\nStopped." : `\nError: ${firstLine(err)}`))
      .finally(() => (job.running = false));
    return null;
  }

  function stop() {
    if (!job.running) return;
    aborted = true;
    // closing the job's tab interrupts whatever it is waiting on
    jobPage?.close().catch(() => {});
  }

  async function state() {
    const counts = Object.fromEntries(
      db.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all().map((r) => [r.status, r.n]),
    );
    const leads = db
      .prepare("SELECT username, full_name, category, followers, links, niche, location, kind, status, note, message, sent_at" +
        " FROM leads WHERE status NOT IN ('rejected', 'deleted') ORDER BY COALESCE(sent_at, found_at) DESC LIMIT 1000")
      .all();
    const connected = sharedCtx ? hasSession(await sharedCtx.cookies(IG)) : existsSync(SESSION_PATH);
    const { name, running, log } = job;
    return { counts, leads, connected, sentToday: sentToday(db), config: CONFIG, job: { name, running, log } };
  }

  // Optional lock: if a .ui-password file exists, anything that did not come straight from this
  // PC's own browser (i.e. through the tunnel) must send that password. No file = open to anyone.
  const { timingSafeEqual } = await import("node:crypto");
  const passwordPath = path.join(ROOT, ".ui-password");
  function allowed(req) {
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? "") &&
      !req.headers["cf-connecting-ip"] && !req.headers["x-forwarded-for"];
    if (local) return true;
    if (!existsSync(passwordPath)) return true;
    const expected = Buffer.from(readFileSync(passwordPath, "utf8").trim());
    const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
    const decoded = scheme === "Basic" ? Buffer.from(encoded ?? "", "base64").toString() : "";
    const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
    return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
  }

  const server = createServer(async (req, res) => {
    try {
      if (!allowed(req)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="Instagram Outreach"', "content-type": "text/plain" });
        return res.end("Password required");
      }
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(path.join(ROOT, "ui.html")));
      }
      if (req.method === "GET" && req.url === "/api/state") return json(res, 200, await state());
      if (req.method === "POST" && req.headers["content-type"] === "application/json") {
        const body = await readBody(req);
        if (req.url === "/api/run") {
          const error = run(body);
          return json(res, error ? 409 : 200, { error });
        }
        if (req.url === "/api/stop") {
          stop();
          return json(res, 200, {});
        }
        if (req.url === "/api/config") {
          applyConfig(body);
          return json(res, 200, {});
        }
        if (req.url === "/api/preview") {
          const lead = db.prepare("SELECT * FROM leads WHERE username=?").get(String(body.username ?? "")) ??
            { full_name: "Sweet Tooth Bakery", niche: CONFIG.niches[0] };
          return json(res, 200, { text: renderMessage(lead) });
        }
        if (req.url === "/api/leads" && Array.isArray(body.usernames)) {
          // deleted leads stay in the table (hidden) so a later search does not bring them back
          const sql = {
            skip: "UPDATE leads SET status='skipped', note=NULL WHERE username=? AND status!='sent'",
            requeue: "UPDATE leads SET status='new', note=NULL WHERE username=? AND status!='sent'",
            delete: "UPDATE leads SET status='deleted' WHERE username=?",
          }[body.action];
          if (!sql) return json(res, 400, { error: "Unknown action" });
          const update = db.prepare(sql);
          for (const username of body.usernames) update.run(String(username));
          return json(res, 200, {});
        }
        if (req.url === "/api/lead" && ["new", "skipped"].includes(body.status)) {
          db.prepare("UPDATE leads SET status=?, note=NULL WHERE username=? AND status!='sent'").run(body.status, String(body.username));
          return json(res, 200, {});
        }
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: firstLine(err) });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Dashboard: ${url}`);
    ensureBrowser().catch((err) => console.log(`Could not open the browser: ${firstLine(err)}`));
  });
  // autopilot: once a day, from the chosen hour, as long as this dashboard is running
  setInterval(() => {
    const auto = CONFIG.autopilot;
    const today = now().slice(0, 10);
    if (!auto?.enabled || job.running || auto.last_run === today || new Date().getHours() < auto.hour) return;
    auto.last_run = today;
    writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2) + "\n");
    run({ command: "auto" });
  }, 60000);
  // close the browser cleanly on Ctrl+C so it writes its session to disk
  process.on("SIGINT", async () => {
    await sharedCtx?.close().catch(() => {});
    process.exit(0);
  });
  await new Promise(() => {});
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      niche: { type: "string" },
      location: { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean" },
      review: { type: "boolean" },
      port: { type: "string" },
    },
  });
  const commands = { login: cmdLogin, find: cmdFind, list: cmdList, send: cmdSend, export: cmdExport, ui: cmdUi };
  const command = commands[positionals[0]];
  if (!command) {
    console.log("Usage: node outreach.mjs <ui|login|find|list|send|export> [--niche x] [--location y] [--limit n] [--dry-run] [--review] [--port n]");
    process.exit(1);
  }
  await command(values);
}

if (path.resolve(process.argv[1] ?? "").toLowerCase() === import.meta.filename.toLowerCase()) {
  await main();
}
