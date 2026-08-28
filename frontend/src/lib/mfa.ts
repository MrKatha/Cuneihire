import { supabase } from "./supabase";

// Login/logout auth-flow rework (2026-08-28) — the one place that decides whether the current session
// still needs a TOTP challenge before it counts as "logged in". Used from two separate route trees
// ([[...tab]]/page.tsx's main app gate, and reset-password/page.tsx's recovery-session gate) so the check
// can't drift between the two — see the plan's note on why /reset-password needs this too: a password-
// recovery session is typically issued at aal1 even for an account with TOTP enrolled, so without this
// check there a compromised inbox alone would be enough to change the password and bypass 2FA entirely.
export async function needsMfaChallenge(): Promise<boolean> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return false;
  return data.nextLevel === "aal2" && data.currentLevel !== "aal2";
}
