import { createClient } from "@supabase/supabase-js";

// Extracted (2026-08-29, admin portal overview task) from three byte-identical copies that had
// accumulated across the admin API routes. SERVER-ONLY — SUPABASE_SERVICE_ROLE_KEY has no NEXT_PUBLIC_
// prefix on purpose, so this file must only ever be imported from route.ts files, never from
// AdminPortal.tsx or any other "use client" component.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

export async function verifyAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return false;
  const token = authHeader.replace("Bearer ", "");

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return false;

  // Renamed from NEXT_PUBLIC_ADMIN_EMAILS (2026-08-29, admin subdomain task) — nothing reads this
  // client-side any more (the in-SPA admin tab was removed), so there's no reason left to bake super-admin
  // emails into the public client bundle. Still super-admin-only, unchanged otherwise — see
  // resolve-role/route.ts for the admin/employee tiers this gates the existing routes against (deliberately
  // not yet).
  const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || "").split(",").map((e) => e.trim()).filter(Boolean);
  return superAdminEmails.includes(user.email || "");
}
