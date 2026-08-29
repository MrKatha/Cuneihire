import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

// Auth-email infra cost (2026-08-29, Phase 3 cost-metering addendum) — Resend only sends transactional
// auth emails here (signup confirm, magic link, password reset, OTP code); bulk sends go through each
// user's own SMTP (automailsend_smtp_accounts), which costs the operator $0 and isn't logged anywhere.
// All four Resend-triggered actions below happen BEFORE a session exists (that's the point of magic-link/
// password-reset/signup-confirm/OTP) — so there's no user_id to key this on. Keyed on email instead; the
// admin routes join back to a user by email, which they already have on hand from auth.users.
//
// No auth gate beyond the validation below — this is a low-stakes internal metrics endpoint (worst case is
// a junk row in an admin-only ledger, never readable outside the service role), and gating it on a session
// would defeat the purpose, since every call site here is intentionally pre-session.
const VALID_EVENT_TYPES = new Set(["signup_confirm", "magic_link", "otp_code", "password_reset", "resend_confirmation"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Resend's published overage rate — $1 per 1,000 emails. An approximation, not a metered figure like the
// Gemini side: actual marginal cost is $0 while under Resend's free/plan allowance. Runtime-computed at
// insert time, same pattern as aiClient.ts's getGeminiRates, so a future rate change doesn't need a
// backfill or a human remembering to edit a stale constant.
function getResendRate() {
  return {
    perEmailUsd: 0.001,
    tier: "estimated overage rate — actual marginal cost is $0 while under Resend's free/plan allowance",
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const eventType = typeof body?.eventType === "string" ? body.eventType : "";
    if (!EMAIL_RE.test(email) || !VALID_EVENT_TYPES.has(eventType)) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    const rate = getResendRate();
    await supabaseAdmin.from("automailsend_infra_usage_log").insert({
      email,
      event_type: eventType,
      provider: "resend",
      cost_usd: rate.perEmailUsd,
      pricing_snapshot: rate,
    });

    return NextResponse.json({ ok: true });
  } catch {
    // Never let a metrics-logging failure surface as an error to whatever auth flow triggered it.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
