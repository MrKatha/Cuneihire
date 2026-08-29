import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkAtsAiGate, getAuthedUserId, scoreApplicationMatch, spendAtsAiCredit } from "@/lib/aiClient";

export const runtime = "nodejs";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

// Backs ApplicantsModal.tsx's manual "Score with AI" button — for an application that came in before
// AI-ATS was enabled, or a file-only resume the recruiter later wants re-scored after the candidate
// added a built resume. Same server-side, credit-verified pattern as /api/jobs/apply.
export async function POST(request: NextRequest) {
  try {
    const recruiterId = await getAuthedUserId(request);
    if (!recruiterId) {
      return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
    }

    const { applicationId } = await request.json();
    if (!applicationId) {
      return NextResponse.json({ success: false, error: "applicationId is required." }, { status: 400 });
    }

    const { data: application, error: appErr } = await supabaseAdmin
      .from("automailsend_job_applications")
      .select("*, automailsend_job_postings(*)")
      .eq("id", applicationId)
      .single();
    if (appErr || !application) {
      return NextResponse.json({ success: false, error: "Application not found." }, { status: 404 });
    }

    const posting = (application as any).automailsend_job_postings;
    if (!posting || posting.recruiter_id !== recruiterId) {
      return NextResponse.json({ success: false, error: "Not authorized to score this application." }, { status: 403 });
    }
    if (!application.resume_data) {
      return NextResponse.json({ success: false, error: "This application has no structured resume data to score." }, { status: 400 });
    }

    const gate = await checkAtsAiGate(recruiterId);
    if (!gate.ok) {
      return NextResponse.json({ success: false, error: gate.error }, { status: 402 });
    }

    const result = await scoreApplicationMatch(application.resume_data, posting, undefined, recruiterId);
    if (!result) {
      return NextResponse.json({ success: false, error: "AI scoring did not return a usable result." }, { status: 502 });
    }

    await spendAtsAiCredit(recruiterId);
    await supabaseAdmin
      .from("automailsend_job_applications")
      .update({ ai_score: result.score, ai_reasoning: result.reasoning, ai_analyzed_at: new Date().toISOString() })
      .eq("id", applicationId);

    return NextResponse.json({ success: true, aiScore: result.score, aiReasoning: result.reasoning });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to score application.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
