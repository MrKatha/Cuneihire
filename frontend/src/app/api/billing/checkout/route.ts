import { NextResponse } from "next/server";
import { getAuthedUserId } from "@/lib/aiClient";
import { supabaseAdmin } from "@/lib/adminAuth";
import { createCheckout } from "@/lib/lemonSqueezy";

// Starts a Lemon Squeezy Checkout for the caller's own account. Free has no checkout (nothing to buy).
export async function POST(req: Request) {
  const userId = await getAuthedUserId(req);
  if (!userId) {
    return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
  }

  const { tier } = await req.json();
  if (tier !== "pro" && tier !== "premium") {
    return NextResponse.json({ success: false, error: "tier must be 'pro' or 'premium'." }, { status: 400 });
  }

  const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(userId);
  const email = user?.email;
  if (!email) {
    return NextResponse.json({ success: false, error: "Couldn't resolve your account email." }, { status: 400 });
  }

  try {
    const url = await createCheckout(userId, email, tier);
    return NextResponse.json({ success: true, url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start checkout";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
