// GET /api/me -> who is signed in and whether they have Pro (also enforces the 3-device limit).
import { guard, json, verifySession, checkDevice, proStatus } from "../_lib/core.js";
import { isAdmin } from "../_lib/admin.js";
export const onRequestGet = guard(async ({ request, env }) => {
  const user = await verifySession(request, env);
  const dev = await checkDevice(env, user);
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";   // right after checkout
  const st = await proStatus(env, user, { fresh });
  return json({ signedIn: true, email: user.email, devices: dev.devices || null, ...st, ...(isAdmin(env, user.userId) ? { admin: true } : {}) });
});
