// POST /api/admin/action {customer, action, cents?, note?} -> support actions on one member (admins only, audited).
//   free_month     credit worth one month of their plan (coming off the next bill); >10 this month needs approval
//   credit         account credit in cents (max $500); over $50 needs the other admin's approval
//   reset_devices  clears the member's device list (they sign in again on up to 3 devices)
//   note           adds a note to the member (e.g. "asked about refund", "suspected PDF sharing")
import { guard, json, HttpError, stripe } from "../../_lib/core.js";
import { requireAdmin, audit, adminIds, giveCredit, monthValueCents, freeMonthsThisMonth, countFreeMonth,
         CREDIT_APPROVAL_CENTS, CREDIT_MAX_CENTS, FREE_MONTHS_PER_MONTH } from "../../_lib/admin.js";
export async function perform(env, user, a) {
  const by = user.email || user.userId, note = String(a.note || "").slice(0, 300);
  if (a.action === "free_month") {
    const v = await monthValueCents(env, a.customer);
    await giveCredit(env, a.customer, v.cents, `Free month from Confident Picks${note ? ": " + note : ""} (by ${by})`);
    await countFreeMonth(env);
    return { done: "free_month", cents: v.cents, plan: v.plan };
  }
  if (a.action === "credit") {
    await giveCredit(env, a.customer, a.cents, `Account credit from Confident Picks${note ? ": " + note : ""} (by ${by})`);
    return { done: "credit", cents: a.cents };
  }
  if (a.action === "reset_devices") {
    if (!a.userId) throw new HttpError(409, "no_account", "This customer has no linked sign-in account.");
    await env.KV.delete(`dev:${a.userId}`);
    return { done: "reset_devices" };
  }
  if (a.action === "note") {
    const k = `note:${a.customer}`, list = (await env.KV.get(k, "json")) || [];
    list.unshift({ at: new Date().toISOString(), by, text: note });
    await env.KV.put(k, JSON.stringify(list.slice(0, 50)));
    return { done: "note" };
  }
  throw new HttpError(400, "bad_action", "Unknown action.");
}
export const onRequestPost = guard(async ({ request, env }) => {
  const user = await requireAdmin(request, env);
  const b = await request.json().catch(() => ({}));
  const a = { action: String(b.action || ""), customer: String(b.customer || ""), note: String(b.note || "").trim().slice(0, 300) };
  if (!/^cus_[A-Za-z0-9]+$/.test(a.customer)) throw new HttpError(400, "bad_customer", "Pick a member first.");
  if (a.action === "note" && a.note.length < 2) throw new HttpError(400, "empty_note", "Write the note first.");
  if (a.action === "credit") {
    a.cents = Math.round(Number(b.cents));
    if (!(a.cents >= 100 && a.cents <= CREDIT_MAX_CENTS)) throw new HttpError(400, "bad_amount", "Credit must be between $1 and $500.");
  }
  if (a.action === "reset_devices") {
    const c = await stripe(env, "GET", `/v1/customers/${a.customer}`);
    a.userId = (c.metadata && c.metadata.clerk_user_id) || "";
  }
  const two = adminIds(env).length >= 2;
  const needs = two && ((a.action === "credit" && a.cents > CREDIT_APPROVAL_CENTS) ||
                        (a.action === "free_month" && (await freeMonthsThisMonth(env)) >= FREE_MONTHS_PER_MONTH));
  if (needs) {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10), at = new Date().toISOString();
    await env.KV.put(`appr:${id}`, JSON.stringify({ id, at, by: user.email || user.userId, byId: user.userId, ...a }), { expirationTtl: 14 * 86400 });
    await audit(env, user, "requested_approval", { request: id, ...a });
    return json({ pending: true, id, message: "Sent to your partner for approval." }, 202);
  }
  const res = await perform(env, user, a);
  await audit(env, user, a.action, { customer: a.customer, cents: res.cents || a.cents || 0, note: a.note });
  return json({ ok: true, ...res });
});
