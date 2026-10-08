// GET /api/admin/today -> the numbers both partners check first (admins only; cached 5 minutes).
import { guard, json } from "../../_lib/core.js";
import { requireAdmin, planOf, listJSON } from "../../_lib/admin.js";
import { stripe } from "../../_lib/core.js";
const LIVE = new Set(["active", "trialing", "past_due"]);
export const onRequestGet = guard(async ({ request, env }) => {
  await requireAdmin(request, env);
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  if (!fresh) { const c = await env.KV.get("adm:today", "json"); if (c && Date.now() - c.at < 300e3) return json(c); }
  const now = Math.floor(Date.now() / 1000), week = now - 7 * 86400, month = now - 30 * 86400;
  const t = { at: Date.now(), members: 0, monthly: 0, yearly: 0, pastDue: 0, cancelling: 0, newThisWeek: 0,
              cancelledThisWeek: 0, mrrCents: 0, paidLast30Cents: 0, invoicesLast30: 0, unhandledMessages: 0, pendingApprovals: 0 };
  let after = "", pages = 0;
  do {
    const r = await stripe(env, "GET", `/v1/subscriptions?status=all&limit=100${after ? "&starting_after=" + after : ""}`);
    for (const s of r.data || []) {
      const p = planOf(env, s);
      if (LIVE.has(s.status)) {
        t.members++; p.plan === "year" ? t.yearly++ : t.monthly++;
        t.mrrCents += p.plan === "year" ? Math.round(p.amount / 12) : p.amount;
        if (s.status === "past_due") t.pastDue++;
        if (s.cancel_at_period_end) t.cancelling++;
        if ((s.created || 0) >= week) t.newThisWeek++;
      } else if (s.status === "canceled" && (s.canceled_at || 0) >= week) t.cancelledThisWeek++;
    }
    after = r.has_more && r.data && r.data.length ? r.data[r.data.length - 1].id : "";
  } while (after && ++pages < 50);
  after = ""; pages = 0;
  do {
    const r = await stripe(env, "GET", `/v1/invoices?status=paid&created[gte]=${month}&limit=100${after ? "&starting_after=" + after : ""}`);
    for (const i of r.data || []) { t.paidLast30Cents += i.amount_paid || 0; t.invoicesLast30++; }
    after = r.has_more && r.data && r.data.length ? r.data[r.data.length - 1].id : "";
  } while (after && ++pages < 50);
  const msgs = await listJSON(env, "msg:", { limit: 500 });
  const handled = new Set((await env.KV.list({ prefix: "msgh:" })).keys.map((k) => k.name.slice(5)));
  t.unhandledMessages = msgs.filter((m) => !handled.has(m.key)).length;
  t.pendingApprovals = (await env.KV.list({ prefix: "appr:" })).keys.length;
  await env.KV.put("adm:today", JSON.stringify(t), { expirationTtl: 3600 });
  return json(t);
});
