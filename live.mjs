/*
Put the dashboard online at https://instagram-outreach.pages.dev for as long as this is running.

Usage:
    node live.mjs

Starts the dashboard, opens a Cloudflare tunnel to it, and pushes the tunnel's address to GitHub
so the pages.dev site forwards to it (Cloudflare takes about a minute to pick that up).
The address changes on every start, which is why it is pushed each time.
*/
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const PORT = 3210;
const SITE = "https://instagram-outreach.pages.dev";
const PASSWORD_PATH = path.join(ROOT, ".ui-password");
const TUNNEL_PATH = path.join(ROOT, "tunnel.json");
const INSTALLED = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
const CLOUDFLARED = existsSync(INSTALLED) ? INSTALLED : "cloudflared";

if (!existsSync(PASSWORD_PATH)) writeFileSync(PASSWORD_PATH, randomBytes(15).toString("base64url") + "\n");
const password = readFileSync(PASSWORD_PATH, "utf8").trim();

const git = (...args) => execFileSync("git", args, { cwd: ROOT, stdio: "pipe" }).toString();

function publish(url) {
  writeFileSync(TUNNEL_PATH, JSON.stringify({ url }) + "\n");
  git("add", "tunnel.json");
  if (!git("status", "--porcelain", "tunnel.json").trim()) return;
  git("commit", "-m", "Update tunnel address", "--", "tunnel.json");
  git("push");
}

const dashboard = spawn(process.execPath, [path.join(ROOT, "outreach.mjs"), "ui", "--port", String(PORT)], { stdio: "inherit" });
const tunnel = spawn(CLOUDFLARED, ["tunnel", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "ignore", "pipe"] });

let published = false;
tunnel.stderr.on("data", (chunk) => {
  const url = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (!url || published) return;
  published = true;
  try {
    publish(url);
    console.log(`\nLive in about a minute: ${SITE}\nUsername: anything    Password: ${password}\n`);
  } catch (err) {
    console.log(`\nCould not push the tunnel address to GitHub: ${String(err.stderr || err.message).trim()}`);
  }
});
tunnel.on("error", () => console.log("Could not start cloudflared. Install it with: winget install Cloudflare.cloudflared"));

const shutdown = () => {
  tunnel.kill();
  dashboard.kill("SIGINT");
};
process.on("SIGINT", shutdown);
dashboard.on("exit", () => {
  tunnel.kill();
  process.exit(0);
});
tunnel.on("exit", () => console.log("The tunnel stopped; the pages.dev address is offline until you run this again."));
