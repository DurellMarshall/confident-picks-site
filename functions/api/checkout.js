// POST /api/checkout {plan:"month"|"year", promo?, ref?} -> Stripe-hosted Checkout URL (card details never reach this site).
//   promo: a promotion code from a share link (?promo=CODE), applied for the buyer if it is active.
//   ref:   a member's referral code (?ref=CODE): the friend gets REFERRAL_COUPON (10% off the first month) on a first
//          subscription, and the member's id rides along in the subscription's metadata for the $5 credit.
//   Otherwise Stripe's own promo code box is shown.
//   A coupon limited to certain products in Stripe ("Apply to specific products") is only applied to a plan whose price
//   belongs to one of them (owner 2026-10-06: the free month must not give a free year).  The yearly plan is its own
//   product, so Stripe's own code box enforces the same rule for codes people type.
import { guard, json, HttpError, verifySession, ensureCustomer, proStatus, stripe, origin } from "../_lib/core.js";
import { referrerOf } from "../_lib/referral.js";

// true when the coupon applies to this price's product (a coupon with no product list applies to everything)
async function fits(env, couponId, price) {
  if (!couponId) return false;
  try { return await fitsOrThrow(env, couponId, price); } catch (e) { return true; }   // can't check: keep the old behaviour
}
async function fitsOrThrow(env, couponId, price) {
  const c = await stripe(env, "GET", `/v1/coupons/${encodeURIComponent(couponId)}?expand[]=applies_to`);
  const prods = (c.applies_to && c.applies_to.products) || [];
  if (!prods.length) return true;
  const p = await stripe(env, "GET", `/v1/prices/${encodeURIComponent(price)}`);
  return prods.includes(typeof p.product === "string" ? p.product : p.product && p.product.id);
}
const couponOf = (pc) => (pc && ((pc.promotion && pc.promotion.coupon) || (pc.coupon && (pc.coupon.id || pc.coupon)))) || "";
export const onRequestPost = guard(async ({ request, env }) => {
  const user = await verifySession(request, env);
  const body = await request.json().catch(() => ({}));
  const price = body.plan === "year" ? env.PRICE_YEAR : body.plan === "month" ? env.PRICE_MONTH : null;
  if (!price) throw new HttpError(400, "bad_plan", "Pick monthly or yearly.");
  const st = await proStatus(env, user, { fresh: true });
  if (st.pro) throw new HttpError(409, "already_pro", "You already have Pro. Manage it from My account.");
  const customer = await ensureCustomer(env, user);
  const site = origin(request);
  const meta = { clerk_user_id: user.userId };
  let discount = null, note = null;
  const promo = typeof body.promo === "string" && /^[A-Za-z0-9_-]{2,40}$/.test(body.promo) ? body.promo : "";
  if (promo) {
    const pc = await stripe(env, "GET", `/v1/promotion_codes?code=${encodeURIComponent(promo)}&active=true&limit=1`);
    const code = pc.data && pc.data[0];
    if (code && code.id) {
      const cp = couponOf(code);
      if (typeof cp === "string" && cp ? await fits(env, cp, price) : true) discount = { promotion_code: code.id };
      else note = "promo_other_plan";
    }
  }
  const referrer = await referrerOf(env, body.ref);
  if (referrer && referrer !== user.userId) {
    const past = await stripe(env, "GET", `/v1/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=1`);
    if (!(past.data && past.data.length)) {                       // first subscription only
      meta.referred_by = referrer;
      if (!discount && env.REFERRAL_COUPON) {
        if (await fits(env, env.REFERRAL_COUPON, price)) discount = { coupon: env.REFERRAL_COUPON };
        else note = note || "referral_monthly_only";      // the member still earns the credit when the friend pays
      }
    }
  }
  const s = await stripe(env, "POST", "/v1/checkout/sessions", {
    mode: "subscription", customer, client_reference_id: user.userId,
    line_items: { 0: { price, quantity: 1 } },
    ...(discount ? { discounts: { 0: discount } } : { allow_promotion_codes: "true" }),
    subscription_data: { metadata: meta },
    success_url: `${site}/?checkout=done#account`, cancel_url: `${site}/#plans`,
  });
  return json({ url: s.url, discount: discount ? (discount.coupon ? "referral" : "promo") : null, note });
});
