import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// flowType: 'pkce' (2026-08-28, login/logout auth-flow rework) — the client's own default is 'implicit'.
// PKCE is the correct flow for a public SPA: the code verifier never leaves the browser that started the
// flow, which matters now that email links (magic link, password recovery) route through /auth/callback.
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { flowType: "pkce" },
});
