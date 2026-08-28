import { NextResponse } from "next/server";
import { supabaseAdmin, verifyAdmin } from "@/lib/adminAuth";

// Which worker jobs write to automailsend_execution_logs, and under what details.jobType value — see
// backend/src/lib/logger.js's ExecutionLogger callers. batchSend.worker.js never writes to this table
// (despite an SQL comment claiming otherwise), so there's no fourth entry here.
const JOB_TYPES = ["scraper", "automail", "reply_poll"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Platform-wide "overall status" summary (2026-08-29, admin portal task) — a live snapshot only, no
// AI-credit spend ledger exists to build usage-over-time from (confirmed with the operator, out of scope
// this pass). Every query here is a simple count/limit(1), fine at the app's current scale.
export async function GET(req: Request) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const sinceWeek = new Date(Date.now() - WEEK_MS).toISOString();
    const sinceDay = new Date(Date.now() - DAY_MS).toISOString();

    const [
      usersRes,
      appStatesRes,
      recruiterCountRes,
      recipientsCountRes,
      sentCountRes,
      repliesCountRes,
      recentFailuresRes,
      ...lastRunRes
    ] = await Promise.all([
      supabaseAdmin.auth.admin.listUsers(),
      supabaseAdmin.from("automailsend_app_state").select("is_blocked, ai_credits"),
      supabaseAdmin.from("automailsend_recruiter_profiles").select("user_id", { count: "exact", head: true }),
      supabaseAdmin.from("automailsend_recipients").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("automailsend_sent_log").select("id", { count: "exact", head: true }).eq("status", "sent"),
      supabaseAdmin.from("automailsend_replies").select("id", { count: "exact", head: true }),
      supabaseAdmin
        .from("automailsend_execution_logs")
        .select("id", { count: "exact", head: true })
        .in("status", ["error", "failed"])
        .gte("created_at", sinceDay),
      ...JOB_TYPES.map((jobType) =>
        supabaseAdmin
          .from("automailsend_execution_logs")
          .select("created_at, status")
          .contains("details", { jobType })
          .order("created_at", { ascending: false })
          .limit(1)
      ),
    ]);

    if (usersRes.error) throw usersRes.error;
    if (appStatesRes.error) throw appStatesRes.error;

    const users = usersRes.data.users || [];
    const totalUsers = users.length;
    const signupsLast7d = users.filter((u) => u.created_at && u.created_at >= sinceWeek).length;
    const recruiterCount = recruiterCountRes.count ?? 0;

    const appStates = appStatesRes.data || [];
    const blockedCount = appStates.filter((s) => s.is_blocked).length;
    const totalAiCredits = appStates.reduce((sum, s) => sum + (s.ai_credits ?? 0), 0);

    const workerHealth = JOB_TYPES.map((jobType, i) => {
      const row = lastRunRes[i]?.data?.[0];
      return { jobType, lastRunAt: row?.created_at ?? null, lastStatus: row?.status ?? null };
    });

    return NextResponse.json({
      success: true,
      data: {
        totalUsers,
        candidateCount: totalUsers - recruiterCount,
        recruiterCount,
        activeCount: totalUsers - blockedCount,
        blockedCount,
        signupsLast7d,
        totalLeads: recipientsCountRes.count ?? 0,
        totalEmailsSent: sentCountRes.count ?? 0,
        totalReplies: repliesCountRes.count ?? 0,
        totalAiCreditsRemaining: totalAiCredits,
        recentFailures24h: recentFailuresRes.count ?? 0,
        workerHealth,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
