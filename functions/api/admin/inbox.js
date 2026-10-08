// GET /api/admin/inbox -> Contact-form messages, newest first, with who handled them.
// POST {key, handled:true|false} marks one handled (admins only, audited).
import { guard, json, HttpError } from "../../_lib/core.js";
import { requireAdmin, audit, listJSON } from "../../_lib/admin.js";
export const onRequestGet = guard(async ({ request, env }) => {
  await requireAdmin(request, env);
  const msgs = await listJSON(env, "msg:", { limit: 200 });
  for (const m of msgs) m.handled = await env.KV.get(`msgh:${m.key}`, "json");
  return json({ messages: msgs });
});
export const onRequestPost = guard(async ({ request, env }) => {
  const user = await requireAdmin(request, env);
  const b = await request.json().catch(() => ({}));
  const key = String(b.key || "");
  if (!key.startsWith("msg:") || !(await env.KV.get(key))) throw new HttpError(404, "gone", "Message not found.");
  if (b.handled === false) await env.KV.delete(`msgh:${key}`);
  else await env.KV.put(`msgh:${key}`, JSON.stringify({ at: new Date().toISOString(), by: user.email || user.userId }), { expirationTtl: 180 * 86400 });
  await audit(env, user, b.handled === false ? "message_reopened" : "message_handled", { message: key });
  return json({ ok: true });
});
