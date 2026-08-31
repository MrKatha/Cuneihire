import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/adminAuth";
import { verifyWebhookSignature, variantIdToTier, TIER_LEVERS } from "@/lib/lemonSqueezy";

export const runtime = "nodejs";

type LemonSqueezyWebhookPayload = {
  meta?: { event_name?: string; custom_data?: { user_id?: string } };
  data?: {
    type?: string;
    id?: string | number;
    attributes?: {
      status?: string;
      variant_id?: string | number | null;
      customer_id?: string | number | null;
      renews_at?: string | null;
      ends_at?: string | null;
      updated_at?: string;
    };
  };
};

// No session auth (a webhook has no user to sign in as) — authenticates via the X-Signature HMAC instead.
// Only ever processes events whose `data.type` is "subscriptions" (subscription_created/updated/cancelled/
// resumed/paused/unpaused/expired all share that one resource shape with the full attrs we need — status,
// variant_id, renews_at/ends_at, updated_at). Payment-lifecycle events (subscription_payment_success/failed/
// recovered/refunded) carry a different resource type ("subscription-invoices") and never change plan_tier
// on their own anyway (see the tier-change rule below) — acknowledged and ignored rather than parsed, so
// there's no invoice-payload shape to get wrong for behavior we don't need.
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("X-Signature");
  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ success: false, error: "Invalid signature" }, { status: 401 });
  }

  let payload: LemonSqueezyWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  const eventName: string = payload?.meta?.event_name || "";
  const subData = payload?.data;
  if (!subData || subData.type !== "subscriptions") {
    return NextResponse.json({ success: true, ignored: true });
  }

  const attrs = subData.attributes || {};
  const subscriptionId: string = String(subData.id);
  // Lemon Squeezy attaches checkout_data.custom to meta.custom_data on every webhook for the resulting
  // subscription's lifecycle, not just the first one — but fall back to a lookup by ls_subscription_id
  // (set by an earlier delivery) for the rare case it's ever missing.
  const customUserId: string | undefined = payload?.meta?.custom_data?.user_id;

  let targetUserId: string | null = customUserId || null;
  if (!targetUserId) {
    const { data: existing } = await supabaseAdmin
      .from("automailsend_app_state")
      .select("user_id")
      .eq("ls_subscription_id", subscriptionId)
      .maybeSingle();
    targetUserId = existing?.user_id || null;
  }
  if (!targetUserId) {
    // Nothing to attach this to — ack anyway so Lemon Squeezy doesn't retry-storm forever.
    return NextResponse.json({ success: true, ignored: true, reason: "no matching user" });
  }

  const { data: current } = await supabaseAdmin
    .from("automailsend_app_state")
    .select("plan_tier, ls_synced_at")
    .eq("user_id", targetUserId)
    .maybeSingle();

  // Idempotency / out-of-order safety — Lemon Squeezy can and does redeliver webhooks. Compare the
  // subscription object's OWN updated_at (not our write time) against what we last synced; a redelivery or
  // an out-of-order arrival that's no newer than what's already applied is skipped, not reapplied.
  const incomingUpdatedAt: string | undefined = attrs.updated_at;
  if (incomingUpdatedAt && current?.ls_synced_at && new Date(current.ls_synced_at) >= new Date(incomingUpdatedAt)) {
    return NextResponse.json({ success: true, skipped: true, reason: "stale or duplicate delivery" });
  }

  const resolvedTier = variantIdToTier(attrs.variant_id);
  const update: Record<string, unknown> = {
    ls_subscription_id: subscriptionId,
    subscription_status: attrs.status || null,
    // A cancelled-but-not-yet-expired subscription has ends_at set (when access actually stops); an
    // active one has renews_at (when it next bills) instead — whichever is present is the meaningful date.
    current_period_ends_at: attrs.ends_at || attrs.renews_at || null,
    ls_synced_at: incomingUpdatedAt || new Date().toISOString(),
  };
  if (attrs.customer_id != null) update.ls_customer_id = String(attrs.customer_id);

  // The 4 lever columns (ai_credits, max_keywords, min_fetch_interval_override, daily_mail_limit) — and
  // plan_tier itself — are ONLY overwritten on a genuine tier-change event, so an admin's hand-set override
  // via CreditsCell/OverrideCell survives every other delivery (a routine renewal, a same-tier update, a
  // cancellation that hasn't reached its period end yet).
  if (eventName === "subscription_expired") {
    // Terminal event, fired once the paid period genuinely lapses — mirrors Lemon Squeezy's own semantics:
    // subscription_cancelled alone does NOT revoke anything, the user rides out what they already paid for.
    update.plan_tier = "free";
    Object.assign(update, TIER_LEVERS.free);
  } else if (
    resolvedTier &&
    (eventName === "subscription_created" || (eventName === "subscription_updated" && resolvedTier !== current?.plan_tier))
  ) {
    update.plan_tier = resolvedTier;
    Object.assign(update, TIER_LEVERS[resolvedTier]);
  }

  const { error } = await supabaseAdmin
    .from("automailsend_app_state")
    .upsert({ user_id: targetUserId, ...update }, { onConflict: "user_id" });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
