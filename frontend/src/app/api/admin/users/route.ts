import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

async function verifyAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return false;
  const token = authHeader.replace("Bearer ", "");
  
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return false;

  const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "").split(",");
  return adminEmails.includes(user.email || "");
}

export async function GET(req: Request) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const { data, error } = await supabaseAdmin
      .from("automailsend_app_state")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    // Recruiter portal (2026-08-19) — a separate table (recruiter is a capability, not a column on
    // app_state); merge in ats_ai_credits for any user who's activated it, null for everyone else so the
    // UI can tell "not a recruiter" from "recruiter with 0 credits".
    const { data: recruiterProfiles } = await supabaseAdmin
      .from("automailsend_recruiter_profiles")
      .select("user_id, ats_ai_credits");
    const atsCreditsByUser = new Map((recruiterProfiles || []).map((r) => [r.user_id, r.ats_ai_credits]));

    const merged = (data || []).map((u) => ({
      ...u,
      ats_ai_credits: atsCreditsByUser.has(u.user_id) ? atsCreditsByUser.get(u.user_id) : null,
    }));

    return NextResponse.json({ success: true, data: merged });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const { user_id, is_blocked, allowed_products, ai_credits, ats_ai_credits, max_keywords, min_fetch_interval_override } = await req.json();
    if (!user_id) throw new Error("user_id is required");

    const updateData: any = {};
    if (is_blocked !== undefined) updateData.is_blocked = is_blocked;
    if (allowed_products !== undefined) updateData.allowed_products = allowed_products;
    // Platform-managed AI credits (2026-08-18) — admin-granted only, no self-serve purchase yet.
    if (ai_credits !== undefined) updateData.ai_credits = ai_credits;
    // Manual per-user plan overrides (2026-08-25) — null is a valid, meaningful value here ("clear the
    // override, back to default"), distinct from undefined ("field not sent, don't touch it") — both
    // pass through `!== undefined` correctly since JSON.parse preserves an explicit null.
    if (max_keywords !== undefined) updateData.max_keywords = max_keywords;
    if (min_fetch_interval_override !== undefined) updateData.min_fetch_interval_override = min_fetch_interval_override;

    let data: any = null;
    if (Object.keys(updateData).length > 0) {
      const res = await supabaseAdmin
        .from("automailsend_app_state")
        .update(updateData)
        .eq("user_id", user_id)
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
