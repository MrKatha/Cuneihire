import { NextRequest, NextResponse } from "next/server";
import { checkAiGate, enhanceQuickSendEmail, getAuthedUserId, spendAiCredit } from "@/lib/aiClient";

export const runtime = "nodejs";

// Backs QuickSendModal.tsx's "Enhance with AI" button — a synchronous, single-draft AI polish, distinct
// from the backend's queued per-recipient personalization (generateAiPersonalizedEmail in
// ai.service.js, which reads a scraped job post). No job post here, just a manual draft.
//
// Platform-managed AI (2026-08-18): no more client-supplied provider/apiKey — uses the platform's own
// Gemini key and spends one of the caller's admin-granted credits. The caller's identity comes from the
// Bearer session token, not a client-supplied field.
export async function POST(request: NextRequest) {
  try {
    const userId = await getAuthedUserId(request);
    if (!userId) {
      return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
    }

    const gate = await checkAiGate(userId);
    if (!gate.ok) {
      return NextResponse.json({ success: false, error: gate.error }, { status: 402 });
    }

    const body = await request.json();
    const { draftSubject, draftBody, candidateInfo, profile, recipientName, recipientRole, recipientJobTitle } = body;

    const result = await enhanceQuickSendEmail({
      draftSubject,
      draftBody,
      candidateInfo,
      profile,
      recipientName,
      recipientRole,
      recipientJobTitle,
      temperature: gate.temperature,
    });

    await spendAiCredit(userId);

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enhance email";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
