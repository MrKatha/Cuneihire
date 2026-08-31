// Platform-managed app credits (2026-08-31, MVP push) — a second currency alongside ai_credits
// (aiClient.ts's checkAiGate/spendAiCredit): spent on EVERY send (manual/template/resume/follow-up), not
// just AI-touched ones. An AI-touched send spends BOTH — this file only ever handles app_credits, callers
// spend ai_credits separately via spendAiCredit when AI actually did the work.
//
// Not folded into aiClient.ts (which is AI-specific by name/purpose) — mirrors backend/src/lib/appCredits.js
// (KEEP IN SYNC), same split as that file's own aiCredits.js/ai.service.js separation.
import { createClient } from "@supabase/supabase-js";
import { getAuthedUserId } from "./aiClient";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return createClient(url, key);
}

export type AppCreditGateResult = { ok: true } | { ok: false; error: string };

// Checked before attempting a send — cheap enough to always do fresh rather than trust a possibly-stale
// client-side count. Unlike checkAiGate, there's no "enabled" flag to check — every account has app_credits.
export async function checkAppCredits(userId: string): Promise<AppCreditGateResult> {
  const { data } = await getSupabaseAdmin()
    .from("automailsend_app_state")
    .select("app_credits")
    .eq("user_id", userId)
    .single();
  if (!data?.app_credits || data.app_credits <= 0) {
    return { ok: false, error: "Out of app credits — ask an admin to grant more." };
  }
  return { ok: true };
}

// Spend ONE credit — call this only after a send actually succeeded, never before (a network/SMTP failure
// shouldn't cost a credit). Same optimistic-locking pattern as spendAiCredit/the backend twin.
export async function spendAppCredit(userId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase.from("automailsend_app_state").select("app_credits").eq("user_id", userId).single();
  const current = row?.app_credits ?? 0;
  if (current <= 0) return false;
  const { data: updated } = await supabase
    .from("automailsend_app_state")
    .update({ app_credits: current - 1 })
    .eq("user_id", userId)
    .eq("app_credits", current)
    .select("app_credits");
  return Array.isArray(updated) && updated.length > 0;
}

export { getAuthedUserId };
