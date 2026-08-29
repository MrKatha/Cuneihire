import { NextResponse } from "next/server";
import { supabaseAdmin, verifyAdmin } from "@/lib/adminAuth";

export async function GET(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  
  const { userId } = await params;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Missing userId" }, { status: 400 });
  }

  try {
    // Resolve email first (needed to key the infra-usage lookup below — see automailsend_infra_usage_log's
    // schema comment: those rows are keyed by email, not user_id, since every auth-email event fires before
    // a session exists).
    const { data: userRow } = await supabaseAdmin.auth.admin.getUserById(userId);
    const email = userRow?.user?.email || "";

    const [
      appStateRes,
      templatesRes,
      recipientsRes,
      executionLogsRes,
      sentLogsRes,
      aiUsageLogRes,
      aiUsageTotalsRes,
      infraUsageLogRes
    ] = await Promise.all([
      supabaseAdmin.from("automailsend_app_state").select("*").eq("user_id", userId).single(),
      supabaseAdmin.from("automailsend_templates").select("*").eq("user_id", userId),
      supabaseAdmin.from("automailsend_recipients").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      supabaseAdmin.from("automailsend_execution_logs").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      supabaseAdmin.from("automailsend_sent_log").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      supabaseAdmin.from("automailsend_ai_usage_log").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      // Uncapped, 2-column — the point of this feature is accurate dollar figures, so the stat tiles show
      // the user's true lifetime total rather than inheriting the 200-row cap the other tabs above accept.
      supabaseAdmin.from("automailsend_ai_usage_log").select("cost_usd, total_tokens").eq("user_id", userId),
      email
        ? supabaseAdmin.from("automailsend_infra_usage_log").select("*").eq("email", email).order("created_at", { ascending: false }).limit(200)
        : Promise.resolve({ data: [] as unknown[] })
    ]);

    const aiUsageTotals = (aiUsageTotalsRes.data || []).reduce(
      (acc, r) => ({
        totalCostUsd: acc.totalCostUsd + (r.cost_usd ?? 0),
        totalTokens: acc.totalTokens + (r.total_tokens ?? 0),
        callCount: acc.callCount + 1
      }),
      { totalCostUsd: 0, totalTokens: 0, callCount: 0 }
    );

    const data = {
      app_state: appStateRes.data || {},
      templates: templatesRes.data || [],
      recipients: recipientsRes.data || [],
      execution_logs: executionLogsRes.data || [],
      sent_logs: sentLogsRes.data || [],
      ai_usage_log: aiUsageLogRes.data || [],
      ai_usage_totals: aiUsageTotals,
      infra_usage_log: infraUsageLogRes.data || []
    };

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
