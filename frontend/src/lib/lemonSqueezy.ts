// Lemon Squeezy subscriptions (2026-08-31, foundation-hardening Workstream B). SERVER-ONLY — every env var
// read here is unprefixed (no NEXT_PUBLIC_), so this file must only ever be imported from route.ts files,
// same rule as adminAuth.ts. Chosen over Stripe/Paddle specifically for confirmed Pakistan-seller support.
//
// TIER_LEVERS is the single source of truth for what each plan grants — see docs/pricing-tiers.md for the
// full spec and reasoning. These map onto the same automailsend_app_state columns the existing manual
// admin-override system already uses — a subscription webhook and an admin's hand-edit both ultimately
// just set these same columns.
//
// Renamed Premium -> Elite and Free -> (dropped as a sellable tier) 2026-08-31, operator decision: all
// three real tiers are now paid (Starter/Pro/Elite); "free" is kept only as the technical default/
// unsubscribed state every signup starts in (NOT a product to sell) — its own values are deliberately left
// untouched from before this change, so nothing regresses for any account until it actually subscribes.
import crypto from "crypto";

export type PlanTier = "free" | "starter" | "pro" | "elite";

export type TierLevers = {
  ai_credits: number;
  max_keywords: number | null;
  min_fetch_interval_override: number | null;
  daily_mail_limit: number;
  // Three new levers (2026-08-31, operator spec): follow-up count cap, and two capability gates that sit
  // on top of the existing ai_personalization_enabled user preference rather than replacing it --
  // ai_email_writing_enabled/reply_monitoring_enabled are the TIER's ceiling on what's even available;
  // the user's own toggles (AI on/off, per-account IMAP) still control whether it's actually turned on
  // within that ceiling. See docs/architecture.md's "Tier-gated feature limits" section for exactly which
  // worker call sites check which flag.
  max_follow_ups: number;
  ai_email_writing_enabled: boolean;
  reply_monitoring_enabled: boolean;
};

export const TIER_LEVERS: Record<PlanTier, TierLevers> = {
  // Untouched from before this change -- not a sellable product, just the default new-signup state.
  free: { ai_credits: 10, max_keywords: 10, min_fetch_interval_override: null, daily_mail_limit: 20, max_follow_ups: 3, ai_email_writing_enabled: true, reply_monitoring_enabled: true },
  // Starter's daily_mail_limit (2026-08-31, operator spec, verbatim: "10 or 20 or 13... something like
  // that" -- picked 10 as the clean, defensible number given the explicit uncertainty; trivially adjusted
  // per-account via the existing CreditsCell/OverrideCell admin controls, or here for the tier default).
  // Gets AI for match-scoring (ai_credits > 0, scraper.worker.js/jobspy.worker.js are unaffected by
  // ai_email_writing_enabled) but NOT AI-written emails or reply monitoring, per operator spec.
  starter: { ai_credits: 30, max_keywords: 10, min_fetch_interval_override: 120, daily_mail_limit: 10, max_follow_ups: 0, ai_email_writing_enabled: false, reply_monitoring_enabled: false },
  pro: { ai_credits: 100, max_keywords: 30, min_fetch_interval_override: 60, daily_mail_limit: 20, max_follow_ups: 1, ai_email_writing_enabled: true, reply_monitoring_enabled: true },
  elite: { ai_credits: 300, max_keywords: null, min_fetch_interval_override: 15, daily_mail_limit: 50, max_follow_ups: 3, ai_email_writing_enabled: true, reply_monitoring_enabled: true },
};

// Maps a Lemon Squeezy checkout/subscription's variant_id (one product/price in their dashboard) back to
// our internal tier label. Configured via env, not hardcoded — the operator creates the actual
// Starter/Pro/Elite products in the Lemon Squeezy dashboard and supplies the resulting variant ids.
export function variantIdToTier(variantId: string | number | null | undefined): PlanTier | null {
  if (!variantId) return null;
  const id = String(variantId);
  if (id === process.env.LEMONSQUEEZY_VARIANT_ID_STARTER) return "starter";
  if (id === process.env.LEMONSQUEEZY_VARIANT_ID_PRO) return "pro";
  if (id === process.env.LEMONSQUEEZY_VARIANT_ID_ELITE) return "elite";
  return null;
}

export function tierVariantId(tier: "starter" | "pro" | "elite"): string {
  const envKey = `LEMONSQUEEZY_VARIANT_ID_${tier.toUpperCase()}`;
  const id = process.env[envKey];
  if (!id) throw new Error(`${envKey} is not configured.`);
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
export async function createCheckout(userId: string, email: string, tier: "starter" | "pro" | "elite"): Promise<string> {
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
