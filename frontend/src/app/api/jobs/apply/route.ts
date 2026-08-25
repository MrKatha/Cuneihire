import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkAtsAiGate, getAuthedUserId, scoreApplicationMatch, spendAtsAiCredit } from "@/lib/aiClient";

export const runtime = "nodejs";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

// Recruiter portal + AI-ATS (2026-08-19) — backs JobBoardTab.tsx's "Apply" action. Everything here runs
// server-side with the service-role key rather than a client-side insert, same reasoning as
// /api/ai-enhance and /api/resume-import: AI-credit spending must be server-verified, and the candidate-
// contact-info + resume snapshot should come from trusted DB reads, not client-supplied copies.
export async function POST(request: NextRequest) {
  try {
    const candidateId = await getAuthedUserId(request);
    if (!candidateId) {
      return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
    }

    const body = await request.json();
    const { jobId, resumeProfileId, resumeEntryId, coverNote } = body;
    if (!jobId) {
      return NextResponse.json({ success: false, error: "jobId is required." }, { status: 400 });
    }

    const { data: posting, error: postingErr } = await supabaseAdmin
      .from("automailsend_job_postings")
      .select("*")
      .eq("id", jobId)
      .single();
    if (postingErr || !posting || posting.status !== "open") {
      return NextResponse.json({ success: false, error: "This job is no longer accepting applications." }, { status: 404 });
    }

    const { data: existing } = await supabaseAdmin
      .from("automailsend_job_applications")
      .select("id")
      .eq("job_id", jobId)
      .eq("candidate_id", candidateId)
      .maybeSingle();
    if (existing) {
      return NextResponse.json({ success: false, error: "You've already applied to this job." }, { status: 409 });
    }

    // Contact info now lives on automailsend_candidate_profiles (2026-08-19), not app_state's old
    // candidate_* columns — see storage.ts's saveCandidateProfile.
    const { data: candidateProfile } = await supabaseAdmin
      .from("automailsend_candidate_profiles")
      .select("name, email, phone")
      .eq("user_id", candidateId)
      .maybeSingle();

    let resumeData: Record<string, unknown> | null = null;
    let resumeFileUrl: string | null = null;
    let resumeFileName: string | null = null;

    if (resumeProfileId) {
      const { data: profileRow } = await supabaseAdmin
        .from("automailsend_resume_profiles")
        .select("data")
        .eq("id", resumeProfileId)
        .eq("user_id", candidateId)
        .maybeSingle();
      if (profileRow?.data) resumeData = profileRow.data;
    }
    if (resumeEntryId) {
      const { data: entryRow } = await supabaseAdmin
        .from("automailsend_resumes")
        .select("files")
        .eq("id", resumeEntryId)
        .eq("user_id", candidateId)
        .maybeSingle();
      const firstFile = Array.isArray(entryRow?.files) ? entryRow.files[0] : null;
      if (firstFile) {
        resumeFileUrl = firstFile.url || null;
        resumeFileName = firstFile.name || null;
      }
    }

    if (!resumeData && !resumeFileUrl) {
      return NextResponse.json({ success: false, error: "Attach a resume to apply." }, { status: 400 });
    }

    const { data: application, error: insertErr } = await supabaseAdmin
      .from("automailsend_job_applications")
      .insert({
        job_id: jobId,
        candidate_id: candidateId,
        candidate_name: candidateProfile?.name || "",
        candidate_email: candidateProfile?.email || "",
        candidate_phone: candidateProfile?.phone || "",
        cover_note: (coverNote || "").trim(),
        resume_data: resumeData,
        resume_file_url: resumeFileUrl,
        resume_file_name: resumeFileName,
      })
      .select("*")
      .single();

    if (insertErr || !application) {
      return NextResponse.json({ success: false, error: insertErr?.message || "Failed to submit application." }, { status: 500 });
    }

    // Auto-score with the recruiter's AI-ATS, if they've enabled it and have credits, and there's
    // structured resume data to score against (a file-only resume stays unscored — see aiClient.ts).
    let aiScore: number | null = null;
    let aiReasoning: string | null = null;
    if (resumeData) {
      const gate = await checkAtsAiGate(posting.recruiter_id);
      if (gate.ok) {
        try {
          const result = await scoreApplicationMatch(resumeData as any, posting, undefined);
          if (result) {
            await spendAtsAiCredit(posting.recruiter_id);
            aiScore = result.score;
            aiReasoning = result.reasoning;
            await supabaseAdmin
              .from("automailsend_job_applications")
              .update({ ai_score: aiScore, ai_reasoning: aiReasoning, ai_analyzed_at: new Date().toISOString() })
              .eq("id", application.id);
          }
        } catch {
          // AI-ATS scoring failing must never fail the application itself — it stays unscored,
          // same "unknown isn't a fail" precedent as everywhere else AI scoring is used.
        }
      }
    }

    return NextResponse.json({ success: true, applicationId: application.id, aiScore, aiReasoning });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit application.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
