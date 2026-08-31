import { NextResponse } from "next/server";
import { supabaseAdmin, verifyAdmin } from "@/lib/adminAuth";

export async function GET(req: Request) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    // auth.users (not automailsend_app_state) is the primary source (2026-08-29 fix) — a user who signed
    // up but never opened the app has no app_state row yet, and was previously invisible to this list
    // entirely. listUsers() is a service-role-gated GoTrue Admin API call, no RLS involved.
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.listUsers();
    if (authError) throw authError;

    const { data: appStates, error: appStateError } = await supabaseAdmin
      .from("automailsend_app_state")
      .select("*");
    if (appStateError) throw appStateError;
    const appStateByUser = new Map((appStates || []).map((s) => [s.user_id, s]));

    // Recruiter portal (2026-08-19) — a separate table (recruiter is a capability, not a column on
    // app_state); merge in ats_ai_credits for any user who's activated it, null for everyone else so the
    // UI can tell "not a recruiter" from "recruiter with 0 credits". Also doubles as the recruiter/
    // candidate signal — user_metadata.account_type isn't reliable (every live signup path hardcodes
    // "candidate" since the signup toggle was removed 2026-08-25).
    const { data: recruiterProfiles } = await supabaseAdmin
      .from("automailsend_recruiter_profiles")
      .select("user_id, ats_ai_credits");
    const atsCreditsByUser = new Map((recruiterProfiles || []).map((r) => [r.user_id, r.ats_ai_credits]));

    const merged = (authData.users || [])
      .map((u) => {
        const state = appStateByUser.get(u.id) || {};
        return {
          is_blocked: false,
          allowed_products: [],
          config: null,
          auto_fetch: null,
          automail: null,
          ai_credits: 0,
          app_credits: 0,
          max_keywords: null,
          min_fetch_interval_override: null,
          // Lemon Squeezy subscription (2026-08-31) — webhook-only-writable, deliberately absent from this
          // route's POST handler below so an admin edit can never desync these from what Lemon Squeezy
          // actually reports. select("*") already returns the real columns for a user who has one.
          plan_tier: "free",
          subscription_status: null,
          current_period_ends_at: null,
          ...state,
          user_id: u.id,
          email: u.email || "",
          // Real signup timestamp, not whenever app_state was first upserted (can be days later — that
          // was already silently wrong for anyone who signed up but didn't immediately touch settings).
          created_at: u.created_at,
          ats_ai_credits: atsCreditsByUser.has(u.id) ? atsCreditsByUser.get(u.id) : null,
        };
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return NextResponse.json({ success: true, data: merged });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const { user_id, is_blocked, allowed_products, ai_credits, app_credits, ats_ai_credits, max_keywords, min_fetch_interval_override } = await req.json();
    if (!user_id) throw new Error("user_id is required");

    const updateData: any = {};
    if (is_blocked !== undefined) updateData.is_blocked = is_blocked;
    if (allowed_products !== undefined) updateData.allowed_products = allowed_products;
    // Platform-managed AI credits (2026-08-18) — admin-granted only, no self-serve purchase yet.
    if (ai_credits !== undefined) updateData.ai_credits = ai_credits;
    // App credits (2026-08-31) — the second currency, spent on every send regardless of AI use.
    if (app_credits !== undefined) updateData.app_credits = app_credits;
    // Manual per-user plan overrides (2026-08-25) — null is a valid, meaningful value here ("clear the
    // override, back to default"), distinct from undefined ("field not sent, don't touch it") — both
    // pass through `!== undefined` correctly since JSON.parse preserves an explicit null.
    if (max_keywords !== undefined) updateData.max_keywords = max_keywords;
    if (min_fetch_interval_override !== undefined) updateData.min_fetch_interval_override = min_fetch_interval_override;

    let data: any = null;
    if (Object.keys(updateData).length > 0) {
      // upsert, not update (2026-08-29) — GET now surfaces every signed-up user via auth.users, including
      // ones with no automailsend_app_state row yet (never opened the app). A plain .update() on a
      // nonexistent row affects 0 rows and .single() then throws "no rows returned" — upsert makes
      // blocking/crediting a brand-new user work the first time an admin touches them.
      const res = await supabaseAdmin
        .from("automailsend_app_state")
        .upsert({ user_id, ...updateData }, { onConflict: "user_id" })
        .select()
        .single();
      if (res.error) throw res.error;
      data = res.data;
    }

    // ats_ai_credits lives on automailsend_recruiter_profiles, not app_state — only a user who's already
    // activated recruiter mode has a row there to update.
    if (ats_ai_credits !== undefined) {
      const res = await supabaseAdmin
        .from("automailsend_recruiter_profiles")
        .update({ ats_ai_credits })
        .eq("user_id", user_id)
        .select()
        .single();
      if (res.error) throw res.error;
      data = { ...(data || { user_id }), ats_ai_credits: res.data.ats_ai_credits };
    }

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
