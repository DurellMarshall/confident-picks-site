// GET /api/admin/health -> is the picks system running? (admins only)
// From the private bucket: when each data file was last uploaded, the picks' own times, and status.json, which the
// picks computer uploads after every run (last update, last odds pull, Odds API credits left).
import { guard, json } from "../../_lib/core.js";
import { requireAdmin } from "../../_lib/admin.js";
export const onRequestGet = guard(async ({ request, env }) => {
  await requireAdmin(request, env);
  const files = {};
  for (const n of ["picks.json", "form.json", "ladders.json", "status.json"]) {
    const h = env.PRO ? await env.PRO.head(n) : null;
    files[n] = h ? { uploaded: h.uploaded, bytes: h.size } : null;
  }
  let status = null;
  try { const o = env.PRO && await env.PRO.get("status.json"); status = o ? await o.json() : null; } catch { status = null; }
  return json({ now: new Date().toISOString(), files, status });
});
