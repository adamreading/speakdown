/**
 * Speakdown — time-limited invite links for a hosted instance.
 *
 * `node server/index.js` on your own machine needs none of this: with a key in
 * .env, everyone who can reach the port gets live dictation. But a hosted copy
 * is a different matter — every utterance spends your AssemblyAI credit, so an
 * open instance is an open wallet. Set SPEAKDOWN_INVITE_ONLY=1 and live
 * dictation is unlocked only for browsers that arrived through an invite link:
 *
 *   node server/invite.js create --hours 72 --label "hackathon judges"
 *   → https://your-host/speakdown/?invite=<token>
 *
 * Opening that URL once sets a cookie for the remaining lifetime of the
 * invite. Anyone else still gets the full editor in Demo Mode. When an invite
 * expires it is pruned from the file on the next check, so there is nothing to
 * clean up by hand.
 *
 * Storage is a small JSON file next to .env (`invites.json`, git-ignored).
 * Tokens are 32 random bytes, base64url, compared in constant time. No
 * dependencies, like the rest of the project.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export const COOKIE_NAME = "sd_invite";
export const DEFAULT_HOURS = 72;
const TOKEN_BYTES = 32;

/** Manage the invite file. Construct one per process; every call re-reads the file. */
export class InviteStore {
  constructor(file = path.join(ROOT, "invites.json")) {
    this.file = file;
  }

  /** Load, drop anything expired, and write back if that changed something. */
  load(now = Date.now()) {
    let invites = {};
    try {
      invites = JSON.parse(fs.readFileSync(this.file, "utf8")) || {};
    } catch {
      return {};
    }
    const live = {};
    let pruned = 0;
    for (const [token, invite] of Object.entries(invites)) {
      if (invite && Number(invite.expiresAt) > now) live[token] = invite;
      else pruned++;
    }
    if (pruned) this.save(live);
    return live;
  }

  save(invites) {
    fs.writeFileSync(this.file, JSON.stringify(invites, null, 2) + "\n", { mode: 0o600 });
  }

  create({ hours = DEFAULT_HOURS, label = "", now = Date.now() } = {}) {
    if (!(hours > 0)) throw new Error("hours must be a positive number");
    const invites = this.load(now);
    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const invite = {
      label: String(label || ""),
      createdAt: now,
      expiresAt: now + Math.round(hours * 3_600_000),
      uses: 0,
    };
    invites[token] = invite;
    this.save(invites);
    return { token, ...invite };
  }

  /** The invite for a token, or null. Expired invites are never returned. */
  lookup(token, now = Date.now()) {
    if (!token || typeof token !== "string" || token.length > 128) return null;
    const invites = this.load(now);
    // Constant-time compare against every stored token; there are only ever a handful.
    let found = null;
    const probe = Buffer.from(token);
    for (const [stored, invite] of Object.entries(invites)) {
      const candidate = Buffer.from(stored);
      if (candidate.length === probe.length && crypto.timingSafeEqual(candidate, probe)) {
        found = { token: stored, ...invite };
      }
    }
    return found;
  }

  /** Count one live request against an invite. Best effort; a missing invite is ignored. */
  touch(token, now = Date.now()) {
    const invites = this.load(now);
    if (!invites[token]) return;
    invites[token].uses = (invites[token].uses || 0) + 1;
    invites[token].lastUsedAt = now;
    this.save(invites);
  }

  /** Push an invite's expiry to `hours` from now, keeping the same link. */
  extend(token, hours, now = Date.now()) {
    if (!(hours > 0)) throw new Error("hours must be a positive number");
    const invites = this.load(now);
    if (!invites[token]) return null;
    invites[token].expiresAt = now + Math.round(hours * 3_600_000);
    this.save(invites);
    return { token, ...invites[token] };
  }

  revoke(token) {
    const invites = this.load();
    if (!invites[token]) return false;
    delete invites[token];
    this.save(invites);
    return true;
  }

  /** Remove every invite, expired or not. */
  clear() {
    this.save({});
  }

  list(now = Date.now()) {
    return Object.entries(this.load(now)).map(([token, invite]) => ({ token, ...invite }));
  }
}

/** Pull the invite token out of a request: `?invite=` first, then the cookie. */
export function tokenFromRequest(req, url) {
  const fromQuery = url.searchParams.get("invite");
  if (fromQuery) return { token: fromQuery, source: "query" };
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME]) return { token: cookies[COOKIE_NAME], source: "cookie" };
  return { token: null, source: null };
}

/** Set-Cookie value that lasts exactly as long as the invite does. */
export function inviteCookie(invite, req, now = Date.now()) {
  const maxAge = Math.max(0, Math.floor((invite.expiresAt - now) / 1000));
  const secure = isHttps(req) ? "; Secure" : "";
  return `${COOKIE_NAME}=${invite.token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export function clearInviteCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = part.slice(eq + 1).trim();
  }
  return out;
}

function isHttps(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return proto === "https" || Boolean(req.socket?.encrypted);
}

export function formatRemaining(ms) {
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) cli(process.argv.slice(2));

function cli(argv) {
  loadEnvFile(path.join(ROOT, ".env"));
  const store = new InviteStore();
  const [command = "list", ...rest] = argv;
  const flags = parseFlags(rest);
  const base = (process.env.SPEAKDOWN_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}/`)
    .replace(/\/?$/, "/");

  switch (command) {
    case "create": {
      const invite = store.create({
        hours: flags.hours ? Number(flags.hours) : DEFAULT_HOURS,
        label: flags.label || "",
      });
      console.log("");
      console.log(`  ${base}?invite=${invite.token}`);
      console.log("");
      console.log(`  label:    ${invite.label || "(none)"}`);
      console.log(`  expires:  ${new Date(invite.expiresAt).toISOString()} (${formatRemaining(invite.expiresAt - Date.now())})`);
      if (!process.env.SPEAKDOWN_INVITE_ONLY) {
        console.log("");
        console.log("  Note: SPEAKDOWN_INVITE_ONLY is not set, so the server is not gating");
        console.log("  live dictation yet. Add SPEAKDOWN_INVITE_ONLY=1 to .env and restart.");
      }
      console.log("");
      return;
    }
    case "list": {
      const invites = store.list();
      if (!invites.length) {
        console.log("  No active invites.");
        return;
      }
      for (const invite of invites) {
        console.log(
          `  ${invite.token}  ${formatRemaining(invite.expiresAt - Date.now()).padEnd(8)}` +
            `  uses ${String(invite.uses || 0).padStart(3)}  ${invite.label}`,
        );
      }
      return;
    }
    case "extend": {
      const token = rest.find((arg) => !arg.startsWith("--"));
      if (!token || !flags.hours) return usage(1);
      const invite = store.extend(token, Number(flags.hours));
      if (!invite) return console.log("  No such invite.");
      console.log(`  ${base}?invite=${invite.token}`);
      console.log(`  expires:  ${new Date(invite.expiresAt).toISOString()} (${formatRemaining(invite.expiresAt - Date.now())})`);
      return;
    }
    case "revoke": {
      const token = rest.find((arg) => !arg.startsWith("--"));
      if (!token) return usage(1);
      console.log(store.revoke(token) ? "  Revoked." : "  No such invite.");
      return;
    }
    case "clear":
      store.clear();
      console.log("  All invites removed.");
      return;
    case "prune":
      store.load();
      console.log(`  ${store.list().length} active invite(s) remain.`);
      return;
    default:
      return usage(command === "help" || command === "--help" ? 0 : 1);
  }
}

function usage(code) {
  console.log(`
  Usage: node server/invite.js <command>

    create [--hours N] [--label TEXT]   Mint an invite link (default ${DEFAULT_HOURS} h)
    list                                Show active invites
    extend <token> --hours N            Move an invite's expiry to N hours from now
    revoke <token>                      Remove one invite now
    clear                               Remove every invite
    prune                               Drop expired invites (also happens automatically)

  The printed URL uses SPEAKDOWN_PUBLIC_URL from .env when set.
`);
  process.exit(code);
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
