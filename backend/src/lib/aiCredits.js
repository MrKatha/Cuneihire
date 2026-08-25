// Platform-managed AI credits (2026-08-18) — shared by all three workers that spend a credit on a
// successful Gemini call (automail, batchSend, scraper). See docs/architecture.md.
//
// Atomic without a new Postgres function: read the current balance, then a conditional update guarded by
// that same value as a WHERE clause (`.eq("ai_credits", current)`) — a classic optimistic-lock pattern.
// If zero rows change, someone else already spent it (or it hit 0) and the caller should treat this as
// insufficient. Good enough for admin-granted internal credits, not real-money billing, so the tiny
// residual race window isn't worth a dedicated SQL function.
//
// Spend AFTER a successful AI response, never before — a network/API failure shouldn't cost the user a
// credit (callers are responsible for only calling this once the Gemini call actually succeeded).
async function spendAiCredit(supabase, userId) {
  const { data: row } = await supabase
    .from("automailsend_app_state")
    .select("ai_credits")
    .eq("user_id", userId)
    .single();

  const current = row?.ai_credits ?? 0;
  if (current <= 0) return false;

  const { data: updated } = await supabase
    .from("automailsend_app_state")
    .update({ ai_credits: current - 1 })
    .eq("user_id", userId)
    .eq("ai_credits", current)
    .select("ai_credits");

  return Array.isArray(updated) && updated.length > 0;
}

module.exports = { spendAiCredit };
