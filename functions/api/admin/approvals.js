// GET /api/admin/approvals -> actions waiting for the other admin.  POST {id, decision:"approve"|"reject"} (admins only).
// The person who asked can't approve their own request.
import { guard, json, HttpError } from "../../_lib/core.js";
import { requireAdmin, audit, listJSON } from "../../_lib/admin.js";
import { perform } from "./action.js";
export const onRequestGet = guard(async ({ request, env }) => {
  await requireAdmin(request, env);
  return json({ approvals: await listJSON(env, "appr:", { limit: 100, newest: false }) });
});
export const onRequestPost = guard(async ({ request, env }) => {
  const user = await requireAdmin(request, env);
  const b = await request.json().catch(() => ({}));
  const id = String(b.id || "");
  if (!/^[a-f0-9]{10}$/.test(id)) throw new HttpError(400, "bad_id", "Unknown request.");
  const a = await env.KV.get(`appr:${id}`, "json");
  if (!a) throw new HttpError(404, "gone", "That request was already handled.");
  if (a.byId === user.userId) throw new HttpError(403, "own_request", "Your partner has to approve your own request.");
  await env.KV.delete(`appr:${id}`);
  if (b.decision !== "approve") { await audit(env, user, "rejected", { request: id, action: a.action, customer: a.customer }); return json({ ok: true, rejected: true }); }
  const res = await perform(env, user, a);
  await audit(env, user, a.action, { customer: a.customer, cents: res.cents || a.cents || 0, note: a.note, approvedRequest: id, requestedBy: a.by });
  return json({ ok: true, ...res });
});
