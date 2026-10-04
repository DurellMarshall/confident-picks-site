// Member referrals (owner 2026-10-04): a Pro member shares a link; the friend gets 10% off the first month
// (REFERRAL_COUPON) and, once the friend's first payment goes through, the member gets $5 of account credit on
// their next bill (a Stripe customer balance credit: never cash, never transferable).
// KV  ref:<userId>         -> the member's referral code
//     refcode:<code>       -> the member's userId
//     refn:<userId>        -> how many credits the member has earned
//     refpaid:<customer>   -> set once the friend's first payment has paid out a credit (never twice)
import { HttpError, kvGet, kvPut, findCustomer, stripe } from "./core.js";

export const CREDIT_CENTS = 500;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";       // no 0/O, 1/I/L
export const validCode = (c) => typeof c === "string" && /^[A-Z2-9]{6,12}$/.test(c);

export async function codeFor(env, userId) {
  const have = await kvGet(env, `ref:${userId}`);
  if (have) return have;
  if (!env.KV) throw new HttpError(503, "not_configured", "Referrals are not set up yet.");
  for (let i = 0; i < 5; i++) {
    const b = new Uint8Array(8); crypto.getRandomValues(b);
    const code = Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join("");
    if (await kvGet(env, `refcode:${code}`)) continue;
    await env.KV.put(`refcode:${code}`, userId);
    await env.KV.put(`ref:${userId}`, code);
    return code;
  }
  throw new HttpError(503, "busy", "Please try again.");
}

export async function referrerOf(env, code) {
  if (!validCode(code)) return null;
  return await kvGet(env, `refcode:${code}`);
}

// Stripe webhook signature (Stripe-Signature: t=...,v1=...): HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret.
export async function verifyStripeSignature(env, header, body) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "not_configured", "Webhook is not set up.");
  const parts = Object.create(null); const v1 = [];
  for (const kv of String(header || "").split(",")) {
    const i = kv.indexOf("="); if (i < 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (k === "v1") v1.push(v); else parts[k] = v;
  }
  const t = parseInt(parts.t || "", 10);
  if (!t || !v1.length) throw new HttpError(400, "bad_signature", "Bad signature.");
  if (Math.abs(Date.now() / 1000 - t) > 300) throw new HttpError(400, "stale", "Too old.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  const hex = Array.from(mac, (x) => x.toString(16).padStart(2, "0")).join("");
  const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
  if (!v1.some((s) => same(s, hex))) throw new HttpError(400, "bad_signature", "Bad signature.");
}

// The friend's first paid invoice: credit the member who referred them, once.
export async function creditReferrer(env, invoice) {
  if (!invoice || !(invoice.amount_paid > 0) || invoice.billing_reason !== "subscription_create") return "ignored";
  const friend = invoice.customer;
  if (!friend || await kvGet(env, `refpaid:${friend}`)) return "already";
  let meta = (invoice.subscription_details && invoice.subscription_details.metadata)
    || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.metadata) || null;
  if (!meta || !meta.referred_by) {
    const subId = invoice.subscription || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
    if (subId) meta = (await stripe(env, "GET", `/v1/subscriptions/${encodeURIComponent(subId)}`)).metadata || {};
  }
  const referrer = meta && meta.referred_by;
  if (!referrer || referrer === (meta && meta.clerk_user_id)) return "no_referrer";
  const cust = await findCustomer(env, { userId: referrer });
  if (!cust || cust === friend) return "no_referrer_customer";
  await stripe(env, "POST", `/v1/customers/${encodeURIComponent(cust)}/balance_transactions`, {
    amount: -CREDIT_CENTS, currency: invoice.currency || "usd",
    description: "Referral credit: a friend you invited joined Pro",
    metadata: { friend_customer: friend, invoice: invoice.id || "" } });
  await kvPut(env, `refpaid:${friend}`, referrer);
  const n = parseInt((await kvGet(env, `refn:${referrer}`)) || "0", 10) + 1;
  await kvPut(env, `refn:${referrer}`, String(n));
  return "credited";
}
