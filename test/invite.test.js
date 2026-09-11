import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  InviteStore,
  COOKIE_NAME,
  tokenFromRequest,
  inviteCookie,
  clearInviteCookie,
  parseCookies,
  formatRemaining,
} from "../server/invite.js";
import { server, CONFIG } from "../server/index.js";

const HOUR = 3_600_000;

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speakdown-invite-"));
  return new InviteStore(path.join(dir, "invites.json"));
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test("a new invite is found by its token and expires exactly when promised", () => {
  const store = tempStore();
  const t0 = 1_000_000_000_000;
  const invite = store.create({ hours: 72, label: "judges", now: t0 });

  assert.ok(invite.token.length >= 40, "token is long enough to be unguessable");
  assert.equal(invite.expiresAt, t0 + 72 * HOUR);
  assert.equal(store.lookup(invite.token, t0 + 71 * HOUR)?.label, "judges");
  assert.equal(store.lookup(invite.token, t0 + 72 * HOUR), null, "gone at the boundary");
});

test("expired invites are pruned from the file on the next read", () => {
  const store = tempStore();
  const t0 = 1_000_000_000_000;
  const short = store.create({ hours: 1, now: t0 });
  const long = store.create({ hours: 100, now: t0 });

  assert.equal(store.list(t0).length, 2);
  store.load(t0 + 2 * HOUR);
  const remaining = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.deepEqual(Object.keys(remaining), [long.token]);
  assert.equal(store.lookup(short.token, t0 + 2 * HOUR), null);
});

test("revoke and clear remove invites immediately", () => {
  const store = tempStore();
  const a = store.create({ hours: 5 });
  const b = store.create({ hours: 5 });
  assert.equal(store.revoke(a.token), true);
  assert.equal(store.revoke(a.token), false, "second revoke is a no-op");
  assert.equal(store.lookup(a.token), null);
  assert.ok(store.lookup(b.token));
  store.clear();
  assert.equal(store.list().length, 0);
});

test("lookup rejects junk without touching the file", () => {
  const store = tempStore();
  const real = store.create({ hours: 5 });
  assert.equal(store.lookup(null), null);
  assert.equal(store.lookup(""), null);
  assert.equal(store.lookup(real.token.slice(0, -1)), null, "near miss");
  assert.equal(store.lookup("x".repeat(500)), null, "oversized");
  assert.equal(store.lookup(real.token)?.token, real.token);
});

test("touch counts uses on the invite that was presented", () => {
  const store = tempStore();
  const invite = store.create({ hours: 5 });
  store.touch(invite.token);
  store.touch(invite.token);
  store.touch("not-a-token");
  assert.equal(store.lookup(invite.token).uses, 2);
});

test("a missing or corrupt invite file means no invites, not a crash", () => {
  const store = tempStore();
  assert.deepEqual(store.list(), []);
  fs.writeFileSync(store.file, "{ not json");
  assert.deepEqual(store.list(), []);
});

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

test("the token comes from the query string first, then the cookie", () => {
  const url = new URL("http://x/?invite=abc");
  assert.deepEqual(tokenFromRequest({ headers: {} }, url), { token: "abc", source: "query" });
  assert.deepEqual(
    tokenFromRequest({ headers: { cookie: `theme=dark; ${COOKIE_NAME}=def` } }, new URL("http://x/")),
    { token: "def", source: "cookie" },
  );
  assert.deepEqual(tokenFromRequest({ headers: {} }, new URL("http://x/")), { token: null, source: null });
});

test("the cookie lasts as long as the invite and is Secure only behind HTTPS", () => {
  const now = 1_000_000_000_000;
  const invite = { token: "tok", expiresAt: now + 2 * HOUR };
  const plain = inviteCookie(invite, { headers: {}, socket: {} }, now);
  assert.match(plain, new RegExp(`^${COOKIE_NAME}=tok; Path=/; Max-Age=7200; HttpOnly; SameSite=Lax$`));
  const proxied = inviteCookie(invite, { headers: { "x-forwarded-proto": "https" }, socket: {} }, now);
  assert.match(proxied, /; Secure$/);
  assert.match(clearInviteCookie(), /Max-Age=0/);
});

test("cookie parsing copes with spacing and empty segments", () => {
  assert.deepEqual(parseCookies("a=1;  b=2 ; ;c="), { a: "1", b: "2", c: "" });
  assert.deepEqual(parseCookies(undefined), {});
});

test("remaining time reads naturally", () => {
  assert.equal(formatRemaining(-1), "expired");
  assert.equal(formatRemaining(30 * 60_000), "30m");
  assert.equal(formatRemaining(5 * HOUR + 4 * 60_000), "5h 4m");
  assert.equal(formatRemaining(72 * HOUR), "3d 0h");
});

// ---------------------------------------------------------------------------
// The server, switched to invite-only
// ---------------------------------------------------------------------------

test("invite-only gating on the live server", async (t) => {
  const base = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const saved = { ...CONFIG };
  const store = tempStore();
  Object.assign(CONFIG, { apiKey: "test-key", inviteOnly: true, inviteStore: store });
  t.after(() => {
    Object.assign(CONFIG, saved);
    server.close();
  });

  await t.test("no token: the page is public but the mode is demo", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("set-cookie"), null);
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.mode, "demo");
    assert.equal(config.access, "invite_required");
  });

  await t.test("no token: dictation routes refuse with a fatal 403", async () => {
    for (const route of ["/api/dictate/start", "/api/transcribe"]) {
      const response = await fetch(`${base}${route}`, { method: "POST", body: "x" });
      assert.equal(response.status, 403, route);
      const body = await response.json();
      assert.equal(body.error, "invite_required");
      assert.equal(body.fatal, true);
    }
  });

  await t.test("a valid link sets a cookie and the cookie unlocks live mode", async () => {
    const invite = store.create({ hours: 72, label: "judges" });
    const page = await fetch(`${base}/?invite=${invite.token}`, { redirect: "manual" });
    assert.equal(page.status, 200);
    const cookie = page.headers.get("set-cookie");
    assert.match(cookie, new RegExp(`^${COOKIE_NAME}=${invite.token}; `));
    assert.match(cookie, /HttpOnly/);

    const config = await (
      await fetch(`${base}/api/config`, { headers: { cookie: `${COOKIE_NAME}=${invite.token}` } })
    ).json();
    assert.equal(config.mode, "live");
    assert.equal(config.access, "invited");
    assert.equal(config.inviteExpiresAt, invite.expiresAt);

    // Extending the invite must reach browsers that already hold the cookie.
    store.extend(invite.token, 200);
    const again = await fetch(`${base}/`, { headers: { cookie: `${COOKIE_NAME}=${invite.token}` } });
    assert.match(again.headers.get("set-cookie"), /Max-Age=7199\d\d;/, "cookie re-issued with ~200 h left");
  });

  await t.test("a revoked or unknown token reports expired and clears the cookie", async () => {
    const invite = store.create({ hours: 72 });
    store.revoke(invite.token);
    const page = await fetch(`${base}/?invite=${invite.token}`);
    assert.match(page.headers.get("set-cookie"), /Max-Age=0/);
    const config = await (
      await fetch(`${base}/api/config`, { headers: { cookie: `${COOKIE_NAME}=${invite.token}` } })
    ).json();
    assert.equal(config.mode, "demo");
    assert.equal(config.access, "expired");
  });

  await t.test("switching invite-only off restores open access", async () => {
    CONFIG.inviteOnly = false;
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.mode, "live");
    assert.equal(config.access, "open");
  });
});
