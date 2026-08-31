import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { decryptPassword } from "@/lib/crypto";
import { getAuthedUserId, checkAppCredits, spendAppCredit } from "@/lib/appCredits";

export const runtime = "nodejs";

// Real auth added 2026-08-31 (MVP push) — this route previously had none at all (no Bearer token, no
// userId), which was fine while nothing here was metered. Now every send costs an app credit, so the
// caller's identity has to be real, not client-supplied — same getAuthedUserId pattern resume-import/route.ts
// already uses. QuickSendModal.tsx's fetch call was updated to send a Bearer session token accordingly.
export async function POST(request: NextRequest) {
  try {
    const userId = await getAuthedUserId(request);
    if (!userId) {
      return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
    }

    const gate = await checkAppCredits(userId);
    if (!gate.ok) {
      return NextResponse.json({ success: false, error: gate.error }, { status: 402 });
    }

    const body = await request.json();
    const { fromName, email, fromEmail, appPassword, host, port, toEmail, subject, content, attachments = [] } = body;

    if (!email || !appPassword || !host || !port || !toEmail || !subject) {
      return NextResponse.json(
        {
          success: false,
          error: "email, appPassword, toEmail, and subject are required",
        },
        { status: 400 }
      );
    }

    let decryptedPassword = appPassword;
    try {
      decryptedPassword = decryptPassword(appPassword);
    } catch {
      return NextResponse.json(
        { success: false, error: "Failed to decrypt app password. Please re-verify SMTP config." },
        { status: 400 }
      );
    }

    const transporter = nodemailer.createTransport({
      host: host,
      port: port,
      secure: port === 465,
      auth: {
        user: email,
        pass: decryptedPassword,
      },
    });

    const senderEmail = fromEmail || email;
    const info = await transporter.sendMail({
      from: fromName ? `"${fromName}" <${senderEmail}>` : senderEmail,
      to: toEmail,
      subject,
      text: content,
      html: content.replace(/\n/g, "<br>"),
      attachments: attachments.map((a: { filename: string; path: string; contentType: string }) => ({
        filename: a.filename,
        path: a.path, // This is the public URL
        contentType: a.contentType,
      })),
    });

    await spendAppCredit(userId); // only after sendMail() actually succeeded

    return NextResponse.json({
      success: true,
      messageId: info.messageId,
      email: toEmail,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to send email";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
