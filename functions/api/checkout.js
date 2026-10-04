// POST /api/checkout {plan:"month"|"year"} -> Stripe-hosted Checkout URL (card details never reach this site).
import { guard, json, HttpError, verifySession, ensureCustomer, proStatus, stripe, origin } from "../_lib/core.js";
export const onRequestPost = guard(async ({ request, env }) => {
  const user = await verifySession(request, env);
  const body = await request.json().catch(() => ({}));
  const price = body.plan === "year" ? env.PRICE_YEAR : body.plan === "month" ? env.PRICE_MONTH : null;
  if (!price) throw new HttpError(400, "bad_plan", "Pick monthly or yearly.");
  const st = await proStatus(env, user, { fresh: true });
  if (st.pro) throw new HttpError(409, "already_pro", "You already have Pro. Manage it from My account.");
  const customer = await ensureCustomer(env, user);
  const site = origin(request);
  const s = await stripe(env, "POST", "/v1/checkout/sessions", {
    mode: "subscription", customer, client_reference_id: user.userId,
    line_items: { 0: { price, quantity: 1 } },
    allow_promotion_codes: "true",                       // coupon box (codes are made in the Stripe dashboard)
    subscription_data: { metadata: { clerk_user_id: user.userId } },
    success_url: `${site}/?checkout=done#account`, cancel_url: `${site}/#plans`,
  });
  return json({ url: s.url });
});
