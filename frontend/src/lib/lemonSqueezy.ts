// Lemon Squeezy subscriptions (2026-08-31, foundation-hardening Workstream B). SERVER-ONLY — every env var
// read here is unprefixed (no NEXT_PUBLIC_), so this file must only ever be imported from route.ts files,
// same rule as adminAuth.ts. Chosen over Stripe/Paddle specifically for confirmed Pakistan-seller support.
//
// TIER_LEVERS is the single source of truth for what each plan grants, lifted verbatim from
// docs/pricing-tiers.md's already-designed tier table (the $ prices there are explicitly marked
// illustrative/not-final; the lever *values* below are the real, load-bearing part). These map onto the
// same 4 columns the existing manual admin-override system already uses — a subscription webhook and an
// admin's hand-edit both ultimately just set these same automailsend_app_state columns.
import crypto from "crypto";

export type PlanTier = "free" | "pro" | "premium";

export type TierLevers = {
  ai_credits: number;
  max_keywords: number | null;
  min_fetch_interval_override: number | null;
  daily_mail_limit: number;
};

export const TIER_LEVERS: Record<PlanTier, TierLevers> = {
  free: { ai_credits: 10, max_keywords: 10, min_fetch_interval_override: null, daily_mail_limit: 20 },
  pro: { ai_credits: 100, max_keywords: 30, min_fetch_interval_override: 60, daily_mail_limit: 75 },
  premium: { ai_credits: 300, max_keywords: null, min_fetch_interval_override: 15, daily_mail_limit: 150 },
};

// Maps a Lemon Squeezy checkout/subscription's variant_id (one product/price in their dashboard) back to
// our internal tier label. Configured via env, not hardcoded — the operator creates the actual Pro/Premium
// products in the Lemon Squeezy dashboard and supplies the resulting variant ids.
export function variantIdToTier(variantId: string | number | null | undefined): PlanTier | null {
  if (!variantId) return null;
  const id = String(variantId);
  if (id === process.env.LEMONSQUEEZY_VARIANT_ID_PRO) return "pro";
  if (id === process.env.LEMONSQUEEZY_VARIANT_ID_PREMIUM) return "premium";
  return null;
}

export function tierVariantId(tier: "pro" | "premium"): string {
  const id = tier === "pro" ? process.env.LEMONSQUEEZY_VARIANT_ID_PRO : process.env.LEMONSQUEEZY_VARIANT_ID_PREMIUM;
  if (!id) throw new Error(`LEMONSQUEEZY_VARIANT_ID_${tier.toUpperCase()} is not configured.`);
  return id;
}

// Lemon Squeezy signs webhook payloads with HMAC-SHA256 over the raw request body, sent in the
// X-Signature header. Must run against the raw body text, before any JSON.parse — see billing/webhook/route.ts.
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || "";
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signatureHeader, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

async function lsFetch(path: string, init: RequestInit) {
  const apiKey = process.env.LEMONSQUEEZY_API_KEY || "";
  if (!apiKey) throw new Error("LEMONSQUEEZY_API_KEY is not configured.");
  const res = await fetch(`https://api.lemonsqueezy.com/v1${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok) {
    const message = json?.errors?.[0]?.detail || `Lemon Squeezy API error (${res.status})`;
    throw new Error(message);
  }
  return json;
}

// Creates a hosted Checkout session for the given tier, tagged with our internal user_id via
// checkout_data.custom so the webhook can map the resulting subscription back to a Supabase user without
// relying on email matching (a user could check out with a different email than their account's).
export async function createCheckout(userId: string, email: string, tier: "pro" | "premium"): Promise<string> {
  const storeId = process.env.LEMONSQUEEZY_STORE_ID || "";
  if (!storeId) throw new Error("LEMONSQUEEZY_STORE_ID is not configured.");
  const variantId = tierVariantId(tier);

  const json = await lsFetch("/checkouts", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: {
            email,
            custom: { user_id: userId },
          },
        },
        relationships: {
          store: { data: { type: "stores", id: storeId } },
          variant: { data: { type: "variants", id: variantId } },
        },
      },
    }),
  });
  const url = json?.data?.attributes?.url;
  if (!url) throw new Error("Lemon Squeezy did not return a checkout URL.");
  return url;
}

export async function fetchSubscription(subscriptionId: string) {
  const json = await lsFetch(`/subscriptions/${subscriptionId}`, { method: "GET" });
  return json?.data;
}
