// GET /api/referral          -> a Pro member's referral link and credits earned
// GET /api/referral?check=X  -> {valid} for a referral code (public; says nothing about who owns it)
import { guard, json, HttpError, verifySession, proStatus, kvGet, origin } from "../_lib/core.js";
import { codeFor, referrerOf, validCode, CREDIT_CENTS } from "../_lib/referral.js";
export const onRequestGet = guard(async ({ request, env }) => {
  const u = new URL(request.url);
  const check = u.searchParams.get("check");
  if (check !== null) return json({ valid: validCode(check) && !!(await referrerOf(env, check)) }, 200, { "cache-control": "max-age=300" });
  const user = await verifySession(request, env);
  const st = await proStatus(env, user);
  if (!st.pro) throw new HttpError(402, "not_pro", "Referral links are part of Pro.");
  const code = await codeFor(env, user.userId);
  const n = parseInt((await kvGet(env, `refn:${user.userId}`)) || "0", 10);
  return json({ code, link: `${origin(request)}/?ref=${code}`, credits: n, creditEach: CREDIT_CENTS / 100,
                ready: !!env.REFERRAL_COUPON });
});
