import { NextRequest, NextResponse } from "next/server";
import { PDFParse } from "pdf-parse";
import { checkAiGate, getAuthedUserId, parseResumeText, spendAiCredit } from "@/lib/aiClient";

export const runtime = "nodejs";

// Backs ResumeBuilder.tsx's "Import from a resume" — the one AI-powered path in the builder (everything
// else is plain client-side form-to-preview binding). PDF only for v1 — covers the overwhelming majority
// of shared resumes; text-based PDFs only, no OCR for scanned images.
//
// Platform-managed AI (2026-08-18): no more client-supplied provider/apiKey — uses the platform's own
// Gemini key and spends one of the caller's admin-granted credits. The caller's identity comes from the
// Bearer session token, not a client-supplied field.
export async function POST(request: NextRequest) {
  let parser: PDFParse | null = null;
  try {
    const userId = await getAuthedUserId(request);
    if (!userId) {
      return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
    }

    const gate = await checkAiGate(userId);
    if (!gate.ok) {
      return NextResponse.json({ success: false, error: gate.error }, { status: 402 });
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "No file uploaded." }, { status: 400 });
    }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ success: false, error: "Only PDF resumes are supported right now." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const text = (result.text || "").trim();

    if (!text) {
      return NextResponse.json(
        { success: false, error: "Couldn't read any text from that PDF — it may be a scanned image rather than text." },
        { status: 400 }
      );
    }

    const data = await parseResumeText(text, gate.temperature, userId);
    await spendAiCredit(userId);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to import resume";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    if (parser) await parser.destroy().catch(() => {});
  }
}
