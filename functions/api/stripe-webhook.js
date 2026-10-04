// POST /api/stripe-webhook -> Stripe tells the site a payment went through (only used for member referral credits).
// Every request must carry Stripe's signature for STRIPE_WEBHOOK_SECRET; anything else is refused.
import { guard, json } from "../_lib/core.js";
import { verifyStripeSignature, creditReferrer } from "../_lib/referral.js";
export const onRequestPost = guard(async ({ request, env }) => {
  const body = await request.text();
  await verifyStripeSignature(env, request.headers.get("stripe-signature"), body);
  const ev = JSON.parse(body);
  let result = "ignored";
  if (ev.type === "invoice.paid" || ev.type === "invoice.payment_succeeded") result = await creditReferrer(env, ev.data && ev.data.object);
  return json({ received: true, result });
});
