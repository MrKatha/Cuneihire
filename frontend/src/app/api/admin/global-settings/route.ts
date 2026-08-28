import { NextResponse } from "next/server";
import { supabaseAdmin, verifyAdmin } from "@/lib/adminAuth";

const DEFAULT_GLOBAL_SETTINGS = {
  min_fetch_interval: 5,
  min_pagination_delay: 5,
  max_pagination_limit: 10,
  allow_signups: true,
  max_daily_send_limit: 100,
};

export async function GET(req: Request) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const { data, error } = await supabaseAdmin
      .from("automailsend_global_settings")
      .select("*")
      .eq("id", 1)
      .single();

    let settings = data || DEFAULT_GLOBAL_SETTINGS;
    return NextResponse.json({ success: true, data: settings });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    
    const { data, error } = await supabaseAdmin
      .from("automailsend_global_settings")
      .upsert({ id: 1, ...body })
      .select()
      .single();

    if (error) throw error;
    
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
