// GET /api/data?f=picks|form|ladders -> the data file for whoever is asking (owner 2026-10-04: the picks are no longer
// a public file).  The PC uploads one copy per tier; this picks the copy, so a visitor's browser never receives a Pro pick.
//   visitor (not signed in)      picks_visitor.json, form_visitor.json        (no Builder)
//   free account                 picks_free.json,    form_free.json,  ladders_free.json
//   Pro                          picks.json,         form.json,       ladders.json
// A device pushed out by the 3-device limit gets the visitor copy plus a notice, so the page can ask it to sign in again.
import { guard, HttpError, verifySession, checkDevice, proStatus } from "../_lib/core.js";

const FILES = {
  picks:   { visitor: "picks_visitor.json", free: "picks_free.json", pro: "picks.json" },
  form:    { visitor: "form_visitor.json",  free: "form_free.json",  pro: "form.json" },
  ladders: { visitor: null,                 free: "ladders_free.json", pro: "ladders.json" },
};

export const onRequestGet = guard(async ({ request, env }) => {
  const f = new URL(request.url).searchParams.get("f") || "picks";
  const files = FILES[f];
  if (!files) throw new HttpError(400, "bad_file", "Unknown file.");
  let tier = "visitor", notice = "";
  if (request.headers.get("authorization")) {
    const user = await verifySession(request, env);           // a bad or expired token is a 401: the page refreshes it
    try {
      await checkDevice(env, user);
      tier = (await proStatus(env, user)).pro ? "pro" : "free";
    } catch (e) {
      if (!(e instanceof HttpError) || e.code !== "device_limit") throw e;
      notice = "device_limit";
    }
  }
  const name = files[tier];
  if (!name) throw new HttpError(401, "signed_out", "Sign in to use the Builder.");
  if (!env.PRO) throw new HttpError(503, "not_configured", "Picks storage is not set up yet.");
  const obj = await env.PRO.get(name);
  if (!obj) throw new HttpError(404, "not_ready", "Picks are being updated. Try again in a minute.");
  return new Response(obj.body, { headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": tier === "visitor" ? "public, max-age=60" : "private, no-store",
    "vary": "authorization", "x-content-type-options": "nosniff",
    "x-cp-tier": tier, ...(notice ? { "x-cp-notice": notice } : {}),
    "access-control-expose-headers": "x-cp-tier, x-cp-notice",
  } });
});
