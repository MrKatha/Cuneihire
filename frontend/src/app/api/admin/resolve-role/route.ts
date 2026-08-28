import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/adminAuth";

// Not gated by verifyAdmin() — this route IS what determines admin-ness, gating it with itself would be
// circular. Any authenticated user can call it safely; a null role back is not a leak, it just means
// "you're not staff."
export async function GET(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const token = authHeader.replace("Bearer ", "");

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user || !user.email) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || "").split(",").map((e) => e.trim()).filter(Boolean);
  if (superAdminEmails.includes(user.email)) {
    return NextResponse.json({ success: true, data: { role: "super_admin", modules: [] } });
  }

  try {
    const { data: staff } = await supabaseAdmin
      .from("automailsend_staff")
      .select("role, modules, email")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!staff) {
      return NextResponse.json({ success: true, data: { role: null, modules: [] } });
    }

    // Defense in depth — re-validate the domain even though automailsend_staff should only ever contain
    // correctly-domained rows (only super admins can create staff rows, via the admin panel).
    const allowedDomains = (process.env.STAFF_ALLOWED_EMAIL_DOMAINS || "").split(",").map((d) => d.trim()).filter(Boolean);
    const emailDomain = (staff.email || user.email).split("@")[1]?.toLowerCase();
    if (allowedDomains.length > 0 && !allowedDomains.includes(emailDomain || "")) {
      return NextResponse.json({ success: true, data: { role: null, modules: [] } });
    }

    return NextResponse.json({ success: true, data: { role: staff.role, modules: staff.modules || [] } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
