"use client";

// Fire-and-forget client-side call to /api/log-infra-usage (2026-08-29, Phase 3 cost-metering addendum) —
// used right after a Resend-triggered auth email send succeeds (signup confirm, magic link, password reset,
// OTP code, resend confirmation). Never awaited by callers and never throws — logging a metric must never
// block or fail the auth flow it's measuring. See that route for the actual cost computation.
export function logInfraUsage(email: string, eventType: "signup_confirm" | "magic_link" | "otp_code" | "password_reset" | "resend_confirmation") {
  fetch("/api/log-infra-usage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, eventType }),
  }).catch(() => {});
}
