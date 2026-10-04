// Confident Picks accounts and payments (owner 2026-10-03): shared helpers for the Cloudflare Pages Functions.
//
// Design rules (kept on purpose, so it is hard to break):
//   * No passwords or card numbers ever touch this code. Sign-in is Clerk (email code or Google); payment is Stripe's
//     hosted Checkout and Customer Portal.
//   * Stripe is the only record of who paid. We ask Stripe and remember the answer for 10 minutes (Cache API), so
//     there is no database to fall out of sync and no webhook to secure.
//   * All picks live in a private R2 bucket, one copy per tier (visitor, free, Pro); /api/data sends each person only
//     their tier's copy, so Pro picks never reach a browser that has not paid.
//   * Up to 3 devices per account (owner 2026-10-03): a 4th sign-in signs the oldest device out of Pro.
//
// Environment (Cloudflare Pages project settings):
//   CLERK_ISSUER          Clerk Frontend API URL, e.g. https://xxx.clerk.accounts.dev  (public)
//   CLERK_PUBLISHABLE_KEY pk_test_... / pk_live_...                                      (public, used by the page)
//   PRICE_MONTH, PRICE_YEAR  Stripe price IDs                                           (public)
//   STRIPE_SECRET_KEY     Stripe restricted key (secret)
//   UPLOAD_TOKEN          long random string shared with the PC uploader (secret)
//   SITE_ORIGINS          optional, comma list of allowed page origins for the token's azp claim
//   STRIPE_API            optional, only for local tests (default https://api.stripe.com)
// Bindings: PRO (R2 bucket), KV (KV namespace)

export const MAX_DEVICES = 3;
const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);   // past_due: Stripe is still retrying the card
const DEVICE_IDLE_DAYS = 30;

export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

export class HttpError extends Error {
  constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code; }
}

export function guard(fn) {
  return async (ctx) => {
    try { return await fn(ctx); }
    catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
      console.error("unexpected", e && e.stack || e);
      return json({ error: "server_error", message: "Something went wrong. Please try again." }, 500);
    }
  };
}

// ---------------------------------------------------------------- Clerk session token (RS256 JWT) verification
const b64urlToBytes = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlJSON = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

let JWKS_CACHE = { at: 0, keys: null, iss: "" };
async function jwks(issuer) {
  if (JWKS_CACHE.keys && JWKS_CACHE.iss === issuer && Date.now() - JWKS_CACHE.at < 3600e3) return JWKS_CACHE.keys;
  const r = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/jwks.json`);
  if (!r.ok) throw new HttpError(503, "auth_unavailable", "Sign-in check is unavailable. Try again shortly.");
  const { keys } = await r.json();
  JWKS_CACHE = { at: Date.now(), keys, iss: issuer };
  return keys;
}

export async function verifySession(request, env) {
  const h = request.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "signed_out", "Please sign in.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "bad_token", "Please sign in again.");
  let header, claims;
  try { header = b64urlJSON(parts[0]); claims = b64urlJSON(parts[1]); }
  catch { throw new HttpError(401, "bad_token", "Please sign in again."); }
  if (header.alg !== "RS256") throw new HttpError(401, "bad_token", "Please sign in again.");
  const issuer = (env.CLERK_ISSUER || "").replace(/\/$/, "");
  if (!issuer) throw new HttpError(503, "not_configured", "Sign-in is not set up yet.");
  let keys = await jwks(issuer);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { JWKS_CACHE.at = 0; keys = await jwks(issuer); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new HttpError(401, "bad_token", "Please sign in again.");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new HttpError(401, "bad_token", "Please sign in again.");
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now - 5) throw new HttpError(401, "expired", "Please sign in again.");
  if (typeof claims.nbf === "number" && claims.nbf > now + 5) throw new HttpError(401, "bad_token", "Please sign in again.");
  if ((claims.iss || "").replace(/\/$/, "") !== issuer) throw new HttpError(401, "bad_token", "Please sign in again.");
  const origins = (env.SITE_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.length && claims.azp && !origins.includes(claims.azp)) throw new HttpError(401, "bad_token", "Please sign in again.");
  if (!claims.sub || !claims.sid) throw new HttpError(401, "bad_token", "Please sign in again.");
  // The browser's own device id (owner 2026-10-04: signing out and back in on one computer is still one device).
  const dev = request.headers.get("x-cp-device") || "";
  return { userId: claims.sub, sessionId: claims.sid, email: claims.email || "",
           deviceId: /^[A-Za-z0-9_-]{16,64}$/.test(dev) ? dev : claims.sid };
}

// ---------------------------------------------------------------- devices: at most MAX_DEVICES per account
// A device is a browser (its id lives in that browser's storage and comes in the x-cp-device header); signing out and
// back in on it does not count again.  Older pages without the header count each sign-in session instead.
// KV  dev:<userId>            -> [{id, sid, last}]  (rewritten only when the list changes or once a day per device)
//     ev:<userId>:<deviceId>  -> the session that was signed out because a newer device took its place (30 days);
//                                signing in again on that browser (a new session) clears it
//     evc:<userId>            -> how many times this account pushed a device out (for the weekly sharing report)
// Fail-safe (owner 2026-10-04): if KV is down or over its daily limit, members still get their picks; only the device
// count pauses until KV is back.  A paying member is never locked out by our storage.
export async function checkDevice(env, user) {
  if (!env.KV) return { ok: true };
  const id = user.deviceId || user.sessionId, evKey = `ev:${user.userId}:${id}`;
  let evicted = null;
  try { evicted = await env.KV.get(evKey); }
  catch (e) { console.error("kv read failed", e && e.message); return { ok: true, devices: null, kvDown: true }; }
  if (evicted && evicted === user.sessionId) throw new HttpError(409, "device_limit",
    `This account is signed in on more than ${MAX_DEVICES} devices, so this one was signed out. Sign in again to use it here.`);
  try {
    if (evicted) await env.KV.delete(evKey);          // signed in again on this browser: it becomes the newest device
    return await trackDevice(env, user, id);
  } catch (e) { console.error("kv device update failed", e && e.message); return { ok: true, devices: null, kvDown: true }; }
}
async function trackDevice(env, user, id) {
  const key = `dev:${user.userId}`, now = Date.now(), day = 864e5;
  let list = ((await env.KV.get(key, "json")) || []).map((d) => ({ id: d.id || d.sid, sid: d.sid, last: d.last }));
  list = list.filter((d) => now - d.last < DEVICE_IDLE_DAYS * day);
  const mine = list.find((d) => d.id === id);
  if (mine) {
    if (mine.sid !== user.sessionId || now - mine.last > day) {
      mine.sid = user.sessionId; mine.last = now; await env.KV.put(key, JSON.stringify(list));
    }
    return { ok: true, devices: list.length };
  }
  list.push({ id, sid: user.sessionId, last: now });
  list.sort((a, b) => b.last - a.last);
  const out = list.slice(MAX_DEVICES);
  list = list.slice(0, MAX_DEVICES);
  for (const d of out) await env.KV.put(`ev:${user.userId}:${d.id}`, d.sid, { expirationTtl: DEVICE_IDLE_DAYS * 86400 });
  if (out.length) {
    const n = parseInt((await env.KV.get(`evc:${user.userId}`)) || "0", 10) + out.length;
    await env.KV.put(`evc:${user.userId}`, String(n), { expirationTtl: 90 * 86400 });
  }
  await env.KV.put(key, JSON.stringify(list));
  return { ok: true, devices: list.length, pushedOut: out.length };
}

// ---------------------------------------------------------------- Stripe (plain HTTPS, no SDK)
const form = (obj, prefix = "", out = new URLSearchParams()) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out); else out.append(key, String(v));
  }
  return out;
};
export async function stripe(env, method, path, body) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, "not_configured", "Payments are not set up yet.");
  const base = env.STRIPE_API || "https://api.stripe.com";
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded",
               "stripe-version": "2024-06-20" },
    body: body ? form(body).toString() : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("stripe", method, path, r.status, data && data.error && data.error.message);
    throw new HttpError(502, "payments_unavailable", "Payments are unavailable right now. Please try again.");
  }
  return data;
}

// The Stripe customer for this Clerk user (tagged with metadata.clerk_user_id so support can match the two).
// KV is only a shortcut here: if it fails, ask Stripe directly.
const kvGet = async (env, k) => { try { return env.KV ? await env.KV.get(k) : null; } catch { return null; } };
const kvPut = async (env, k, v) => { try { if (env.KV) await env.KV.put(k, v); } catch (e) { console.error("kv put failed", e && e.message); } };
export async function findCustomer(env, user) {
  const cached = await kvGet(env, `cust:${user.userId}`);
  if (cached) return cached;
  const q = encodeURIComponent(`metadata['clerk_user_id']:'${user.userId.replace(/'/g, "")}'`);
  const res = await stripe(env, "GET", `/v1/customers/search?query=${q}&limit=1`);
  const id = res.data && res.data[0] && res.data[0].id;
  if (id) await kvPut(env, `cust:${user.userId}`, id);
  return id || null;
}
export async function ensureCustomer(env, user) {
  const id = await findCustomer(env, user);
  if (id) return id;
  const c = await stripe(env, "POST", "/v1/customers", { email: user.email || undefined,
    metadata: { clerk_user_id: user.userId } });
  await kvPut(env, `cust:${user.userId}`, c.id);
  return c.id;
}

// "Has this person paid?" asked of Stripe, remembered for 10 minutes per user (Cache API: free, no KV writes).
export async function proStatus(env, user, { fresh = false } = {}) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const ck = new Request(`https://pro-status.internal/${encodeURIComponent(user.userId)}`);
  if (cache && !fresh) { const hit = await cache.match(ck); if (hit) return hit.json(); }
  const cust = await findCustomer(env, user);
  let st = { pro: false, plan: null, status: null, renews: null, cancelAtPeriodEnd: false, customer: !!cust };
  if (cust) {
    const subs = await stripe(env, "GET", `/v1/subscriptions?customer=${encodeURIComponent(cust)}&status=all&limit=10`);
    const s = (subs.data || []).find((x) => PRO_STATUSES.has(x.status));
    if (s) {
      const price = s.items && s.items.data && s.items.data[0] && s.items.data[0].price && s.items.data[0].price.id;
      st = { pro: true, plan: price === env.PRICE_YEAR ? "year" : price === env.PRICE_MONTH ? "month" : "other",
             status: s.status, renews: s.current_period_end || null, cancelAtPeriodEnd: !!s.cancel_at_period_end, customer: true };
    }
  }
  if (cache) await cache.put(ck, new Response(JSON.stringify(st), { headers: { "cache-control": "max-age=600" } }));
  return st;
}

export function origin(request) { const u = new URL(request.url); return `${u.protocol}//${u.host}`; }

// constant-time compare for the upload token
export function sameSecret(a, b) {
  const x = new TextEncoder().encode(a || ""), y = new TextEncoder().encode(b || "");
  if (!x.length || x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
