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
