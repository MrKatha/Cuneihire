import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/adminAuth";
import { checkAiGate, getAuthedUserId, spendAiCredit, summarizeJobPost } from "@/lib/aiClient";

export const runtime = "nodejs";

// Backs EmailDetailPanel.tsx's "The job" section (2026-09-02). As of 2026-09-03 this is the BACKLOG/
// FAIL-OPEN BRIDGE, not the primary path — the backend's own batched classifyJobPosts() call
// (backend/src/services/ai.service.js) now writes ai_summary directly at scrape time for every newly
// scraped recipient (scraper.worker.js's finalizeAndInsertGroup), reusing the same read that already
// decided the post is a real job posting, so no separate Gemini call is needed at view time any more. This
// route only still fires for the rows that AI didn't reach at scrape time: recipients scraped before this
// feature existed, or ones saved while AI classification was unavailable that run (credits/quota
// exhausted) — see docs/architecture.md. Result still caches on the recipient row so a later open is a
// free read, not a repeat Gemini call.
export async function POST(request: NextRequest) {
  try {
    const userId = await getAuthedUserId(request);
    if (!userId) {
      return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
    }

    const { recipientId } = await request.json();
    if (!recipientId || typeof recipientId !== "string") {
      return NextResponse.json({ success: false, error: "Missing recipientId." }, { status: 400 });
    }

    // Scoped by id AND user_id — a user can't pay to summarize (or read the context_text of) someone
    // else's recipient row by guessing an id.
    const { data: recipient } = await supabaseAdmin
      .from("automailsend_recipients")
      .select("id, context_text, ai_summary")
      .eq("id", recipientId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!recipient) {
      return NextResponse.json({ success: false, error: "Not found." }, { status: 404 });
    }

    // Free short-circuit — the actual caching mechanism. Idempotent-safe if the panel calls this twice.
    if (recipient.ai_summary) {
      return NextResponse.json({ success: true, summary: recipient.ai_summary });
    }
    if (!recipient.context_text) {
      return NextResponse.json({ success: false, error: "Nothing to summarize." }, { status: 400 });
    }

    const gate = await checkAiGate(userId);
    if (!gate.ok) {
      return NextResponse.json({ success: false, error: gate.error }, { status: 402 });
    }

    const summary = await summarizeJobPost(recipient.context_text, gate.temperature, userId);
    await spendAiCredit(userId);

    const generatedAt = new Date().toISOString();
    await supabaseAdmin
      .from("automailsend_recipients")
      .update({ ai_summary: summary, ai_summary_generated_at: generatedAt })
      .eq("id", recipientId);

    return NextResponse.json({ success: true, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to summarize job post";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
