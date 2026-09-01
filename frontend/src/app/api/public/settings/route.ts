import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("automailsend_global_settings")
      .select("allow_signups, max_daily_send_limit, max_smtp_accounts_per_user")
      .eq("id", 1)
      .single();

    if (error && error.code !== 'PGRST116') {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    // Defaults if no row is found
    const allow_signups = data ? data.allow_signups : true;
    // Dashboard's daily-limit ceiling (2026-08-25) — public/candidate-facing, so no admin auth needed to
    // read it, same as allow_signups above.
    const max_daily_send_limit = data ? data.max_daily_send_limit : 100;
    // One SMTP account per user for now, globally, regardless of tier (2026-08-31) — see
    // docs/pricing-tiers.md. Same "public, read-only ceiling" reasoning as max_daily_send_limit above.
    const max_smtp_accounts_per_user = data ? data.max_smtp_accounts_per_user : 1;

    return NextResponse.json({ success: true, data: { allow_signups, max_daily_send_limit, max_smtp_accounts_per_user } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
