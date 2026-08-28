const { supabase } = require("../config/supabase");

let memoryCache = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60000; // 1 minute

const DEFAULT_GLOBAL_SETTINGS = {
  min_fetch_interval: 5,
  min_pagination_delay: 5,
  max_pagination_limit: 10,
  allow_signups: true,
  // Algorithmic match-scoring escalation band (2026-08-28) — a score at or beyond either threshold is
  // "confident enough," skip the AI call; a score between them is borderline, escalate to AI. See
  // matchAlgorithm.service.js's shouldEscalateToAI.
  algo_match_escalate_low: 20,
  algo_match_escalate_high: 80,
};

async function getGlobalSettings() {
  const now = Date.now();
  if (memoryCache && (now - lastFetchTime < CACHE_TTL_MS)) {
    return memoryCache;
  }

  try {
    const { data, error } = await supabase
      .from("automailsend_global_settings")
      .select("*")
      .eq("id", 1)
      .single();

    if (error && error.code !== 'PGRST116') {
       console.error("Supabase fetch global_settings error:", error.message);
    }

    memoryCache = data || DEFAULT_GLOBAL_SETTINGS;
    lastFetchTime = now;
    return memoryCache;
  } catch (error) {
    console.error("Failed to read global settings from Supabase", error);
    return memoryCache || DEFAULT_GLOBAL_SETTINGS;
  }
}

async function setGlobalSettings(settings) {
  try {
    const { data, error } = await supabase
      .from("automailsend_global_settings")
      .upsert({ id: 1, ...settings })
      .select()
      .single();

    if (error) throw error;
    memoryCache = data;
    lastFetchTime = Date.now();
    return data;
  } catch (error) {
    console.error("Failed to write global settings to Supabase", error);
    return null;
  }
}

module.exports = {
  getGlobalSettings,
  setGlobalSettings,
  DEFAULT_GLOBAL_SETTINGS
};
