// POST /api/portal -> Stripe Customer Portal URL (cancel, change plan, card, invoices).
import { guard, json, HttpError, verifySession, findCustomer, stripe, origin } from "../_lib/core.js";
export const onRequestPost = guard(async ({ request, env }) => {
  const user = await verifySession(request, env);
  const customer = await findCustomer(env, user);
  if (!customer) throw new HttpError(404, "no_billing", "No billing history yet.");
  const s = await stripe(env, "POST", "/v1/billing_portal/sessions", { customer, return_url: `${origin(request)}/#account` });
  return json({ url: s.url });
});
