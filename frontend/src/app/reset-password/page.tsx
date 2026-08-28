"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { needsMfaChallenge } from "@/lib/mfa";
import { MfaChallenge } from "@/components/MfaChallenge";
import { Eye, EyeOff } from "lucide-react";
import HexMark from "@/components/ui/HexMark";

export default function ResetPasswordPage() {
  // A recovery session from resetPasswordForEmail is typically issued at aal1 even for an account with
  // TOTP enrolled — without this gate, a compromised email inbox alone would be enough to change the
  // password and walk straight past 2FA, since this route never mounts the main app's auth-gate effect.
  // "checking" avoids a flash of the password form before the check resolves.
  const [mfaState, setMfaState] = useState<"checking" | "required" | "clear">("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const router = useRouter();

  useEffect(() => {
    needsMfaChallenge().then((required) => setMfaState(required ? "required" : "clear"));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      setDone(true);
      setTimeout(() => router.push("/"), 1500);
    }
  }

  if (mfaState === "checking") {
    return (
      <main className="flex items-center justify-center p-4 w-full h-full my-auto flex-grow">
        <p className="text-[var(--muted)]">Checking your session…</p>
      </main>
    );
  }

  if (mfaState === "required") {
    return <MfaChallenge subtitle="Verify it's you before resetting your password." onVerified={() => setMfaState("clear")} />;
  }

  return (
    <main className="flex items-center justify-center p-4 w-full h-full my-auto flex-grow relative">
      <div className="w-full max-w-md p-8 bg-[var(--bg-panel)] border border-[var(--line)]">
        <div className="text-center mb-8 flex flex-col items-center">
          <HexMark variant="outline" size={48} className="mb-4" />
          <h1 className="text-3xl font-bold mb-2 tracking-tight" style={{ color: "var(--ink)", fontFamily: "var(--font-display), Georgia, serif" }}>Cuneihire</h1>
        </div>

        {done ? (
          <p className="text-[var(--ok)] text-center">Password updated. Taking you into Cuneihire…</p>
        ) : (
          <>
            <p className="text-[var(--muted)] text-center mb-6">Choose a new password for your account.</p>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="field">
                <span>New Password</span>
                <div className="relative flex items-center">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    placeholder="••••••••"
                    className="w-full pr-10"
                    autoFocus
                  />
                  <button type="button" className="absolute right-3 text-[var(--muted)] hover:text-[var(--accent)] transition-colors" onClick={() => setShowPassword(!showPassword)}>
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <label className="field">
                <span>Confirm Password</span>
                <input
                  type={showPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                  placeholder="••••••••"
                />
              </label>

              {error && <p className="text-[var(--danger)] text-sm">{error}</p>}

              <div className="pt-2">
                <button type="submit" disabled={loading} className="btn primary w-full justify-center py-3 text-base">
                  {loading ? "Updating..." : "Update Password"}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
