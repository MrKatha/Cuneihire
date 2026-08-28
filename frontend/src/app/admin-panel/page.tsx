"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { needsMfaChallenge } from "@/lib/mfa";
import { MfaChallenge } from "@/components/MfaChallenge";
import { AdminPortal } from "@/components/AdminPortal";
import HexMark from "@/components/ui/HexMark";

type Role = "super_admin" | "admin" | "employee";

// Standalone entry point for the admin subdomain (2026-08-29) — proxy.ts rewrites everything on
// admin.hire.cuneihive.com (except the shared auth pages) to this page. Deliberately NOT reusing
// [[...tab]]/page.tsx's mega-component — this mounts nothing but AdminPortal, with its own minimal
// auth/MFA bootstrap, same shape as that component's effect but far simpler since there's no candidate
// app state to hydrate here.
export default function AdminPanelPage() {
  const [status, setStatus] = useState<"loading" | "mfa-required" | "resolving-role" | "no-session" | "not-authorized" | "authorized">("loading");
  const [role, setRole] = useState<Role | null>(null);
  const router = useRouter();

  useEffect(() => {
    const admit = async (session: NonNullable<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>) => {
      if (await needsMfaChallenge()) {
        setStatus("mfa-required");
        return;
      }
      setStatus("resolving-role");
      const res = await fetch("/api/admin/resolve-role", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const json = await res.json();
      if (json.success && json.data.role) {
        setRole(json.data.role);
        setStatus("authorized");
      } else {
        setStatus("not-authorized");
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) admit(session);
      else setStatus("no-session");
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) admit(session);
      else setStatus("no-session");
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (status === "no-session") router.push("/login");
  }, [status, router]);

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  if (status === "loading" || status === "resolving-role" || status === "no-session") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: "1rem" }}>
        <HexMark variant="outline" size={48} />
        <p className="hint">Loading…</p>
      </div>
    );
  }

  if (status === "mfa-required") {
    return <MfaChallenge subtitle="Verify it's you to access the admin panel." onVerified={() => setStatus("loading")} />;
  }

  if (status === "not-authorized") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: "1rem", textAlign: "center", padding: "1rem" }}>
        <HexMark variant="outline" size={48} />
        <h1 style={{ fontSize: "1.4rem", fontFamily: "var(--font-display), Georgia, serif" }}>Not authorized</h1>
        <p className="hint" style={{ maxWidth: "24rem" }}>
          This account doesn&apos;t have access to the admin panel. If you think this is a mistake, contact your administrator.
        </p>
        <button type="button" className="btn ghost" onClick={handleSignOut}>Sign out</button>
        <a href="/login" className="hint compact" style={{ textDecoration: "underline" }}>Back to login</a>
      </div>
    );
  }

  return (
    <div className="panel flex-col gap-4" style={{ padding: "1.5rem" }}>
      <AdminPortal role={role!} />
    </div>
  );
}
