// PUT /api/admin/upload?name=picks.json -> the PC sends the data files (one copy per tier) to the private R2 bucket.
// Authorized only by UPLOAD_TOKEN (a long random secret kept in Cloudflare and in the PC's environment, never on disk).
import { guard, json, HttpError, sameSecret } from "../../_lib/core.js";
const ALLOWED = new Set(["picks.json", "picks_free.json", "picks_visitor.json", "form.json", "form_free.json",
  "form_visitor.json", "ladders.json", "ladders_free.json"]);
export const onRequestPut = guard(async ({ request, env }) => {
  const h = request.headers.get("authorization") || "";
  if (!env.UPLOAD_TOKEN || !sameSecret(h.replace(/^Bearer /, ""), env.UPLOAD_TOKEN)) throw new HttpError(401, "no", "Not allowed.");
  const name = new URL(request.url).searchParams.get("name") || "";
  if (!ALLOWED.has(name)) throw new HttpError(400, "bad_file", "Unknown file.");
  const body = await request.arrayBuffer();
  if (body.byteLength > 40e6) throw new HttpError(413, "too_big", "Too big.");
  try { JSON.parse(new TextDecoder().decode(body)); } catch { throw new HttpError(400, "bad_json", "Not JSON."); }
  await env.PRO.put(name, body, { httpMetadata: { contentType: "application/json" } });
  return json({ ok: true, name, bytes: body.byteLength });
});
