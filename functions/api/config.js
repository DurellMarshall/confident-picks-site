// GET /api/config -> the public settings the page needs (Clerk publishable key; nothing secret).
import { json } from "../_lib/core.js";
export const onRequestGet = ({ env }) => json({ clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || "",
  plans: { month: !!env.PRICE_MONTH, year: !!env.PRICE_YEAR } }, 200, { "cache-control": "max-age=300" });
