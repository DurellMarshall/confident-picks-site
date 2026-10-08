// GET /api/admin/member?q=<email or cus_ id> -> everything support needs about a member (admins only).
import { guard, json, stripe } from "../../_lib/core.js";
import { requireAdmin, findCustomers, planOf } from "../../_lib/admin.js";
export const onRequestGet = guard(async ({ request, env }) => {
  await requireAdmin(request, env);
  const q = new URL(request.url).searchParams.get("q") || "";
  const found = await findCustomers(env, q);
  const out = [];
  for (const c of found.slice(0, 5)) {
    const subs = await stripe(env, "GET", `/v1/subscriptions?customer=${c.id}&status=all&limit=10`);
    const inv = await stripe(env, "GET", `/v1/invoices?customer=${c.id}&limit=6`);
    const uid = (c.metadata && c.metadata.clerk_user_id) || "";
    const devices = uid ? (await env.KV.get(`dev:${uid}`, "json")) || [] : [];
    const notes = (await env.KV.get(`note:${c.id}`, "json")) || [];
    out.push({
      customer: c.id, email: c.email || "", created: c.created, userId: uid,
      creditCents: c.balance < 0 ? -c.balance : 0, owesCents: c.balance > 0 ? c.balance : 0,
      source: (c.metadata && c.metadata.source) || "",
      subscriptions: (subs.data || []).map((s) => ({ id: s.id, status: s.status, ...planOf(env, s), created: s.created,
        renews: s.current_period_end || null, cancelAtPeriodEnd: !!s.cancel_at_period_end, canceledAt: s.canceled_at || null,
        source: (s.metadata && s.metadata.source) || "", referredBy: (s.metadata && s.metadata.referred_by) ? "yes" : "" })),
      invoices: (inv.data || []).map((i) => ({ date: i.created, status: i.status, paidCents: i.amount_paid || 0,
        dueCents: i.amount_due || 0, number: i.number || "", url: i.hosted_invoice_url || "" })),
      devices: devices.map((d) => ({ last: d.last })), referrals: uid ? parseInt((await env.KV.get(`refn:${uid}`)) || "0", 10) : 0,
      notes,
    });
  }
  return json({ members: out });
});
