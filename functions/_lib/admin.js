// Admin area (owner 2026-10-07): one private page for both partners, same access for each.
//
// Protection (the page being hidden is NOT the protection):
//   * Every admin request is checked here: a valid Clerk session token whose user id is in ADMIN_USER_IDS
//     (Cloudflare setting, comma list).  Anyone else gets 404 "not found", as if the page did not exist.
//   * The page itself holds no data or keys; everything comes from these endpoints after the check.
//   * Refunds, price changes and security settings are NOT here; they stay in Stripe / Clerk / Cloudflare.
//   * Big actions need the OTHER admin's approval (two-person rule) when two admins are configured.
//   * Every action is written to the audit log (audit:<time>:<id>, kept 2 years).
// KV keys used here: audit:*, appr:<id> (pending approvals), note:<customer>, msgh:<message key> (handled),
//                    fm:<YYYY-MM> (free months given this month), adm:today (cached numbers, 5 minutes)
import { HttpError, verifySession, stripe } from "./core.js";

export const CREDIT_APPROVAL_CENTS = 5000;      // a single credit over $50 needs the other admin's OK
export const CREDIT_MAX_CENTS = 50000;          // hard ceiling for one credit: $500
export const FREE_MONTHS_PER_MONTH = 10;        // more than this in a calendar month needs the other admin's OK

export const adminIds = (env) => (env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
export const isAdmin = (env, userId) => adminIds(env).includes(userId);

export async function requireAdmin(request, env) {
  const user = await verifySession(request, env);
  if (!isAdmin(env, user.userId)) throw new HttpError(404, "not_found", "Not found.");
  if (!env.KV) throw new HttpError(503, "not_configured", "Admin storage is not set up yet.");
  return user;
}

const stamp = () => new Date().toISOString();
const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

export async function audit(env, user, action, details = {}) {
  const at = stamp(), id = rid();
  await env.KV.put(`audit:${at}:${id}`, JSON.stringify({ ...details, at, id, by: user.email || user.userId, byId: user.userId, action }),
    { expirationTtl: 730 * 86400 });
  return id;
}

export async function listJSON(env, prefix, { limit = 100, newest = true } = {}) {
  const names = []; let cursor;
  do {
    const page = await env.KV.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) names.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && names.length < 5000);
  names.sort(); if (newest) names.reverse();
  const out = [];
  for (const name of names.slice(0, limit)) { const v = await env.KV.get(name, "json"); if (v) out.push({ key: name, ...v }); }
  return out;
}

// ---------------------------------------------------------------- Stripe helpers for the admin pages
export function planOf(env, sub) {
  const it = sub && sub.items && sub.items.data && sub.items.data[0];
  const pr = it && it.price;
  const id = pr && pr.id;
  const interval = pr && pr.recurring && pr.recurring.interval;
  return { plan: id === env.PRICE_YEAR || interval === "year" ? "year" : "month", amount: (pr && pr.unit_amount) || 0, priceId: id || "" };
}

export async function findCustomers(env, q) {
  q = String(q || "").trim();
  if (/^cus_[A-Za-z0-9]+$/.test(q)) { const c = await stripe(env, "GET", `/v1/customers/${q}`); return c && c.id && !c.deleted ? [c] : []; }
  if (!/^[^\s@'"]+@[^\s@'"]+$/.test(q)) throw new HttpError(400, "bad_query", "Type the member's email (or a cus_ id).");
  const seen = new Map();
  for (const e of new Set([q, q.toLowerCase()])) {
    const r = await stripe(env, "GET", `/v1/customers?email=${encodeURIComponent(e)}&limit=10`);
    for (const c of r.data || []) seen.set(c.id, c);
  }
  return [...seen.values()];
}

// One month free = account credit worth one month of the member's plan (comes off the next bill automatically).
export async function giveCredit(env, customer, cents, description) {
  return stripe(env, "POST", `/v1/customers/${encodeURIComponent(customer)}/balance_transactions`,
    { amount: -Math.abs(cents), currency: "usd", description: description.slice(0, 350) });
}

export async function monthValueCents(env, customer) {
  const subs = await stripe(env, "GET", `/v1/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=10`);
  const s = (subs.data || []).find((x) => ["active", "trialing", "past_due"].includes(x.status));
  if (!s) throw new HttpError(409, "no_subscription", "This member has no active Pro subscription.");
  const p = planOf(env, s);
  return { cents: p.plan === "year" ? Math.round(p.amount / 12) : p.amount, plan: p.plan };
}

export const monthKey = () => `fm:${stamp().slice(0, 7)}`;
export async function freeMonthsThisMonth(env) { return parseInt((await env.KV.get(monthKey())) || "0", 10); }
export async function countFreeMonth(env) {
  await env.KV.put(monthKey(), String((await freeMonthsThisMonth(env)) + 1), { expirationTtl: 62 * 86400 });
}
