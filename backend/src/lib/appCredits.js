// Platform-managed app credits (2026-08-31, MVP push) — a second currency alongside ai_credits
// (aiCredits.js): spent on EVERY send (manual/template/resume/follow-up), not just AI-touched ones. An
// AI-touched send spends BOTH — this file only ever handles app_credits, callers spend ai_credits
// separately via spendAiCredit when AI actually did the work. See docs/architecture.md.
//
// Same optimistic-lock shape as spendAiCredit — read the current balance, then a conditional update guarded
// by that same value, so a zero-rows-changed result means someone else already spent it (or it hit 0).
//
// Spend AFTER a successful send, never before — a network/SMTP failure shouldn't cost the user a credit
// (callers are responsible for only calling this once sendMail() actually succeeded).
async function spendAppCredit(supabase, userId) {
  const { data: row } = await supabase
    .from("automailsend_app_state")
    .select("app_credits")
    .eq("user_id", userId)
    .single();

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

module.exports = { spendAppCredit };
