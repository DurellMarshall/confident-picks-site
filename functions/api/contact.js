// POST /api/contact {topic, message} -> a signed-in member's message to support (owner 2026-10-04).
// Kept in KV (msg:<time>:<id>, 180 days); the PC collects new ones every 10 minutes (/api/admin/messages) into
// _staging/messages/inbox.md, and email forwarding to the owner's inbox can be added once the domain is on Cloudflare.
// Signed-in only (no spam bots), at most 5 messages a day per account.
import { guard, json, HttpError, verifySession, kvGet } from "../_lib/core.js";
const TOPICS = ["Account or sign-in", "Billing", "Picks or data", "Report sharing or abuse", "Feedback", "Other"];
export const onRequestPost = guard(async ({ request, env }) => {
  const user = await verifySession(request, env);
  const body = await request.json().catch(() => ({}));
  const topic = TOPICS.includes(body.topic) ? body.topic : "Other";
  const message = String(body.message || "").replace(/\r/g, "").trim();
  if (message.length < 5) throw new HttpError(400, "too_short", "Please write a little more.");
  if (message.length > 4000) throw new HttpError(400, "too_long", "Please keep it under 4,000 characters.");
  if (!env.KV) throw new HttpError(503, "not_configured", "Messages are not set up yet.");
  const day = new Date().toISOString().slice(0, 10), rk = `rl:contact:${user.userId}:${day}`;
  const n = parseInt((await kvGet(env, rk)) || "0", 10);
  if (n >= 5) throw new HttpError(429, "too_many", "You've sent 5 messages today. We'll get back to you; please write again tomorrow if needed.");
  const id = crypto.randomUUID().slice(0, 8), at = new Date().toISOString();
  await env.KV.put(`msg:${at}:${id}`, JSON.stringify({ at, id, userId: user.userId, email: user.email, topic, message }),
    { expirationTtl: 180 * 86400 });
  await env.KV.put(rk, String(n + 1), { expirationTtl: 2 * 86400 });
  return json({ ok: true, id });
});
