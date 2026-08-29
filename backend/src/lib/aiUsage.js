// AI cost & usage metering (2026-08-29, Phase 3 — "pricing tiers need to be based on real numbers, not a
// guess"). Logs one row per Gemini call to automailsend_ai_usage_log: real token counts (from Gemini's own
// usageMetadata, previously discarded entirely by ai.service.js's callAiJson) plus a $ cost computed at
// insert time from the rate in effect then, so historical rows stay accurate even after a future rate
// change. Deliberately separate from aiCredits.js — that's a remaining-balance counter (gates whether a call
// is allowed at all); this is a row-per-call history (what it actually cost). See docs/architecture.md.
//
// KEEP IN SYNC with frontend/src/lib/aiClient.ts's inline twin (getGeminiRates/logAiUsage there) — same
// rates, same table, same call_type labels.

const { supabase } = require("../config/supabase");

// Gemini pricing (USD per 1M tokens), gemini-flash-latest. A runtime date check rather than a flat constant
// with a comment to update by hand on 2027-01-01 — same reasoning as GEMINI_MODEL's own comment above it in
// ai.service.js: a value silently going stale is the bug class worth designing away, not just fixing once.
function getGeminiRates() {
  const stepAt = Date.UTC(2027, 0, 1); // Google's published rate card steps up on this date
  if (Date.now() < stepAt) {
    return { inputPerMillion: 0.75, outputPerMillion: 3.75, tier: "introductory (through 2026-12-31)" };
  }
  return { inputPerMillion: 1.5, outputPerMillion: 7.5, tier: "standard (from 2027-01-01)" };
}

// Never throws into the caller's own error handling for the AI call itself — callAiJson awaits this wrapped
// in its own try/catch that only logs and moves on, so a Supabase hiccup here can never fail (or even delay
// beyond one insert) a Gemini response that already succeeded. This function's own contract is simpler:
// "write the row or throw" — the swallow-and-continue behavior belongs to the caller, not here.
async function logAiUsage(userId, callType, usageMetadata, model) {
  const promptTokens = usageMetadata?.promptTokenCount || 0;
  const completionTokens = usageMetadata?.candidatesTokenCount || 0;
  const totalTokens = usageMetadata?.totalTokenCount || promptTokens + completionTokens;
  const rates = getGeminiRates();
  const costUsd = (promptTokens / 1_000_000) * rates.inputPerMillion + (completionTokens / 1_000_000) * rates.outputPerMillion;

  const { error } = await supabase.from("automailsend_ai_usage_log").insert({
    user_id: userId || null,
    call_type: callType,
    model,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cost_usd: costUsd,
    pricing_snapshot: rates,
  });
  if (error) throw new Error(error.message);
}

module.exports = { logAiUsage, getGeminiRates };
