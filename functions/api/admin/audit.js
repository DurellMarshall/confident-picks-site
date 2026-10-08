// GET /api/admin/audit -> the latest 200 admin actions, newest first (admins only).
import { guard, json } from "../../_lib/core.js";
import { requireAdmin, listJSON } from "../../_lib/admin.js";
export const onRequestGet = guard(async ({ request, env }) => {
  await requireAdmin(request, env);
  return json({ log: await listJSON(env, "audit:", { limit: 200 }) });
});
