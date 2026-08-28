"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import HexMark from "@/components/ui/HexMark";

type Props = {
  // Fires once mfa.challengeAndVerify succeeds — the caller's own onAuthStateChange effect picks up the
  // now-elevated (aal2) session from there; this component doesn't touch app state itself.
  onVerified: () => void;
  // Shown above the code input — callers phrase this differently (main-app login gate vs. a password
  // reset in progress) even though the underlying TOTP check is identical.
  subtitle?: string;
};

export function MfaChallenge({ onVerified, subtitle = "Enter the 6-digit code from your authenticator app." }: Props) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (error) {
        setListError(error.message);
        return;
      }
      // TOTP is the only factor type this app enrolls (phone/SMS is out of scope for now) — if somehow
      // more than one verified TOTP factor exists, the most recently verified one wins.
      const totp = data?.totp?.filter((f) => f.status === "verified") ?? [];
      setFactorId(totp.length ? totp[totp.length - 1].id : null);
    });
  }, []);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      onVerified();
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", width: "100vw", background: "var(--bg)", position: "fixed", top: 0, left: 0, zIndex: 9999, padding: "1rem" }}>
      <div className="w-full max-w-md p-8 bg-[var(--bg-panel)] border border-[var(--line)]">
        <div className="text-center mb-8 flex flex-col items-center">
          <HexMark variant="outline" size={48} className="mb-4" />
          <h1 className="text-2xl font-bold mb-2 tracking-tight" style={{ color: "var(--ink)", fontFamily: "var(--font-display), Georgia, serif" }}>
            Two-Factor Verification
          </h1>
          <p className="text-[var(--muted)] text-sm">{subtitle}</p>
        </div>

        {listError ? (
          <p className="text-[var(--danger)] text-sm text-center">
            Couldn&apos;t load your 2FA setup ({listError}). Try signing in again.
          </p>
        ) : !factorId ? (
          <p className="text-[var(--muted)] text-sm text-center">Checking your 2FA setup…</p>
        ) : (
          <form onSubmit={handleVerify} className="space-y-5">
            <label className="field">
              <span>Authentication Code</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
                placeholder="123456"
                autoFocus
                style={{ letterSpacing: "0.3em", textAlign: "center", fontSize: "1.25rem" }}
              />
            </label>

            {error && <p className="text-[var(--danger)] text-sm">{error}</p>}

            <button type="submit" disabled={loading || code.length !== 6} className="btn primary w-full justify-center py-3 text-base">
              {loading ? "Verifying..." : "Verify"}
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-[var(--muted)]">
          Not you?{" "}
          <button type="button" onClick={handleSignOut} className="text-[var(--accent)] hover:underline font-medium">
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
