"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import HexMark from "@/components/ui/HexMark";

// Single redirect target for every Supabase auth email link (magic link, password recovery, signup
// confirmation). With flowType: 'pkce' + the client's default detectSessionInUrl: true, the code in the
// URL is auto-exchanged as part of the client's own initialization the moment this page imports
// supabase.ts — do NOT also call exchangeCodeForSession here, it's single-use and would race the
// automatic exchange. Instead: listen on onAuthStateChange (the sanctioned pattern per @supabase/auth-js's
// own docs) and branch on the dedicated PASSWORD_RECOVERY event Supabase fires for recovery links, so
// there's no need to hand-parse a `?type=` query param either.
export default function AuthCallbackPage() {
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    let done = false;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (done) return;
      if (event === "PASSWORD_RECOVERY") {
        done = true;
        router.replace("/reset-password");
      } else if (session) {
        done = true;
        router.replace("/");
      }
    });

    // The automatic exchange above swallows a failed/reused/cross-device code silently — no event ever
    // fires in that case. This second call is free (memoized against the same in-flight/completed
    // initialization, not a second network round trip) and is the only way to surface that failure
    // instead of leaving the page hanging with a spinner forever.
    supabase.auth.initialize().then(({ error }) => {
      if (error && !done) {
        setError("This link is invalid or has expired. Request a new one and try again.");
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  return (
    <main className="flex items-center justify-center p-4 w-full h-full my-auto flex-grow relative">
      <div className="w-full max-w-md p-8 bg-[var(--bg-panel)] border border-[var(--line)] text-center">
        <div className="flex flex-col items-center mb-6">
          <HexMark variant="outline" size={48} className="mb-4" />
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--ink)", fontFamily: "var(--font-display), Georgia, serif" }}>
            Cuneihire
          </h1>
        </div>

        {error ? (
          <>
            <p className="text-[var(--danger)] text-sm mb-6">{error}</p>
            <Link href="/login" className="btn primary w-full justify-center py-3 text-base">
              Back to Login
            </Link>
          </>
        ) : (
          <p className="text-[var(--muted)]">Signing you in…</p>
        )}
      </div>
    </main>
  );
}
