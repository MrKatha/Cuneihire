import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/adminAuth";

// Public, unauthenticated lead capture for the /resume-builder page's email-gated download (2026-08-31) —
// see docs/architecture.md's "Public resume builder" section. No session required by design (that's the
// whole point of the funnel), so this route is the one place doing its own validation/abuse-resistance
// instead of relying on auth: automailsend_resume_leads has RLS enabled with zero policies (default-deny),
// so `supabaseAdmin` (service-role, server-only) is the only thing that can ever write to it.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_PER_WINDOW = 3; // per email OR per IP

export async function POST(req: Request) {
  let body: { email?: string; resumeData?: unknown; templateId?: string; company?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body." }, { status: 400 });
  }

  // Honeypot — a real visitor never sees or fills this field (kept visually hidden client-side); a bot
  // filling every field on a form typically does. Silently pretend success rather than tell a bot its
  // check failed.
  if (body.company) {
    return NextResponse.json({ success: true });
  }

  const email = (body.email || "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ success: false, error: "Enter a valid email address." }, { status: 400 });
  }
  if (!body.resumeData || typeof body.resumeData !== "object") {
    return NextResponse.json({ success: false, error: "Missing resume data." }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

  const { count } = await supabaseAdmin
    .from("automailsend_resume_leads")
    .select("id", { count: "exact", head: true })
    .or(`email.eq.${email},ip_address.eq.${ip}`)
    .gte("created_at", since);

  if ((count || 0) >= RATE_LIMIT_MAX_PER_WINDOW) {
    return NextResponse.json({ success: false, error: "Too many attempts — try again in a few minutes." }, { status: 429 });
  }

  const { error } = await supabaseAdmin.from("automailsend_resume_leads").insert({
    email,
    resume_data: body.resumeData,
    template_id: typeof body.templateId === "string" ? body.templateId : "modern",
    ip_address: ip,
  });

  if (error) {
    console.error("[resume-leads] insert failed:", error.message);
    return NextResponse.json({ success: false, error: "Something went wrong — try again." }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
