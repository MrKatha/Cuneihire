import { NextResponse } from "next/server";
import { getAuthedUserId } from "@/lib/aiClient";
import { supabaseAdmin } from "@/lib/adminAuth";
import { fetchSubscription } from "@/lib/lemonSqueezy";

// Returns the caller's Lemon Squeezy Customer Portal URL — the one surface where a user cancels, pauses,
// changes plan, or updates payment method. Deliberately not cached: the signed URL Lemon Squeezy returns is
// only valid 24h, so always fetch fresh rather than store one.
export async function GET(req: Request) {
  const userId = await getAuthedUserId(req);
  if (!userId) {
    return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
  }

  const { data: row } = await supabaseAdmin
    .from("automailsend_app_state")
    .select("ls_subscription_id")
    .eq("user_id", userId)
    .single();

  if (!row?.ls_subscription_id) {
    return NextResponse.json({ success: false, error: "No active subscription found." }, { status: 404 });
  }

  try {
    const subscription = await fetchSubscription(row.ls_subscription_id);
    const url = subscription?.attributes?.urls?.customer_portal;
    if (!url) throw new Error("Lemon Squeezy did not return a customer portal URL.");
    return NextResponse.json({ success: true, url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load your billing portal";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
