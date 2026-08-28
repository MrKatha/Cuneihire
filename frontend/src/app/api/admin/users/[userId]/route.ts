import { NextResponse } from "next/server";
import { supabaseAdmin, verifyAdmin } from "@/lib/adminAuth";

export async function GET(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  
  const { userId } = await params;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Missing userId" }, { status: 400 });
  }

  try {
    const [
      appStateRes,
      templatesRes,
      recipientsRes,
      executionLogsRes,
      sentLogsRes
    ] = await Promise.all([
      supabaseAdmin.from("automailsend_app_state").select("*").eq("user_id", userId).single(),
      supabaseAdmin.from("automailsend_templates").select("*").eq("user_id", userId),
      supabaseAdmin.from("automailsend_recipients").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      supabaseAdmin.from("automailsend_execution_logs").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      supabaseAdmin.from("automailsend_sent_log").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200)
    ]);

    const data = {
      app_state: appStateRes.data || {},
      templates: templatesRes.data || [],
      recipients: recipientsRes.data || [],
      execution_logs: executionLogsRes.data || [],
      sent_logs: sentLogsRes.data || []
    };

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
