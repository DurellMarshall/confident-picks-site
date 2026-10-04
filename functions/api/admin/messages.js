// GET /api/admin/messages?after=<key> -> support messages newer than <key> (the PC collects them every 10 minutes).
// Authorized only by UPLOAD_TOKEN, like the data upload.
import { guard, json, HttpError, sameSecret } from "../../_lib/core.js";
export const onRequestGet = guard(async ({ request, env }) => {
  const h = request.headers.get("authorization") || "";
  if (!env.UPLOAD_TOKEN || !sameSecret(h.replace(/^Bearer /, ""), env.UPLOAD_TOKEN)) throw new HttpError(401, "no", "Not allowed.");
  if (!env.KV) return json({ messages: [] });
  const after = new URL(request.url).searchParams.get("after") || "";
  const out = []; let cursor;
  do {
    const page = await env.KV.list({ prefix: "msg:", cursor, limit: 1000 });
    for (const k of page.keys) if (k.name > after) out.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort();
  const messages = [];
  for (const name of out.slice(0, 200)) { const v = await env.KV.get(name, "json"); if (v) messages.push({ key: name, ...v }); }
  return json({ messages });
});
