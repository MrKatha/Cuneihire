"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, ArrowLeft } from "lucide-react";
import HexMark from "@/components/ui/HexMark";
import { logInfraUsage } from "@/lib/logInfraUsage";

type Method = "password" | "magic" | "code";

// A short client-side disable after any button that triggers a Supabase auth email — the live project's
// auth mailer is rate-limited to 2 emails/hour, so this just keeps someone from double-clicking into a
// confusing 429. The server-side limit is still the real enforcement; this is only a UX nicety.
const EMAIL_ACTION_COOLDOWN_MS = 30_000;

export default function LoginPage() {
  const [method, setMethod] = useState<Method>("password");
  // This page is shared by both the main app and the admin subdomain (proxy.ts passes /login through
  // untouched on both hosts) — staff accounts are provisioned by a super admin, not self-serve, so the
  // "Sign Up" link/copy shouldn't appear there.
  const [isAdminHost, setIsAdminHost] = useState(false);
  const router = useRouter();

  useEffect(() => {
    setIsAdminHost(window.location.hostname.startsWith("admin."));
  }, []);

  // Password method
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(false);

  // Magic link / email code — share the same email field and signInWithOtp call, just diverge on what
  // happens after: magic link waits for a redirect, code verifies in-page.
  const [otpEmail, setOtpEmail] = useState("");
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [otpCooldown, setOtpCooldown] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [verifyLoading, setVerifyLoading] = useState(false);

  function startCooldown(setter: (v: boolean) => void) {
    setter(true);
    setTimeout(() => setter(false), EMAIL_ACTION_COOLDOWN_MS);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setErrorCode(undefined);
    setResendSent(false);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setErrorCode(error.code);
      setLoading(false);
    } else {
      router.push("/");
    }
  }

  async function handleResendConfirmation() {
    setResendLoading(true);
    const { error } = await supabase.auth.resend({ type: "signup", email });
    setResendLoading(false);
    if (!error) {
      setResendSent(true);
      startCooldown(setResendCooldown);
      logInfraUsage(email, "resend_confirmation");
    }
  }

  async function sendOtp() {
    setOtpLoading(true);
    setOtpError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: otpEmail,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    setOtpLoading(false);
    if (error) {
      setOtpError(error.message);
    } else {
      setOtpSent(true);
      startCooldown(setOtpCooldown);
      logInfraUsage(otpEmail, method === "magic" ? "magic_link" : "otp_code");
    }
  }

  function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    sendOtp();
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setVerifyLoading(true);
    setOtpError(null);
    const { error } = await supabase.auth.verifyOtp({ email: otpEmail, token: otpCode, type: "email" });
    if (error) {
      setOtpError(error.message);
      setVerifyLoading(false);
    } else {
      router.push("/");
    }
  }

  function switchMethod(next: Method) {
    setMethod(next);
    setError(null);
    setErrorCode(undefined);
    setOtpError(null);
  }

  return (
    <main className="flex items-center justify-center p-4 w-full h-full my-auto flex-grow relative">
      <Link href="/" className="absolute top-6 left-6 md:top-10 md:left-10 flex items-center gap-2 text-sm font-medium transition-colors" style={{ color: 'var(--muted)' }}>
        <ArrowLeft size={16} /> Back to Home
      </Link>
      <div className="w-full max-w-md p-8 bg-[var(--bg-panel)] border border-[var(--line)]">
        <Link href="/" className="text-center mb-8 flex flex-col items-center hover:opacity-80 transition-opacity block">
          <HexMark variant="outline" size={48} className="mb-4" />
          <h1 className="text-3xl font-bold mb-2 tracking-tight" style={{ color: 'var(--ink)', fontFamily: 'var(--font-display), Georgia, serif' }}>Cuneihire</h1>
        </Link>
        <div className="text-center mb-6">
          <p className="text-[var(--muted)]">
            {isAdminHost ? "Staff sign in." : "Welcome back. Please sign in to continue."}
          </p>
        </div>

        <div className="flex gap-2 mb-6" style={{ borderBottom: '1px solid var(--line)' }}>
          {([
            ["password", "Password"],
            ["magic", "Magic Link"],
            ["code", "Email Code"],
          ] as [Method, string][]).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => switchMethod(key)}
              className="btn ghost small"
              style={{
                borderBottom: method === key ? '2px solid var(--accent)' : '2px solid transparent',
                borderRadius: 0,
                color: method === key ? 'var(--ink)' : 'var(--muted)',
                fontWeight: method === key ? 600 : 500,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {method === "password" && (
          <>
            <form onSubmit={handleLogin} className="space-y-5">
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                />
              </label>
              <div className="field">
                <div className="flex items-center justify-between">
                  <span>Password</span>
                  <Link href="/forgot-password" className="text-xs text-[var(--accent)] hover:underline font-medium">
                    Forgot password?
                  </Link>
                </div>
                <div className="relative flex items-center">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="••••••••"
                    className="w-full pr-10"
                  />
                  <button
                    type="button"
                    className="absolute right-3 text-[var(--muted)] hover:text-[var(--accent)] transition-colors"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {error && (
                <div>
                  <p className="text-[var(--danger)] text-sm">{error}</p>
                  {errorCode === "email_not_confirmed" && (
                    <button
                      type="button"
                      onClick={handleResendConfirmation}
                      disabled={resendLoading || resendCooldown}
                      className="text-sm text-[var(--accent)] hover:underline font-medium mt-1"
                    >
                      {resendLoading ? "Sending..." : resendSent ? "Confirmation email sent — resend?" : "Resend confirmation email"}
                    </button>
                  )}
                </div>
              )}

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="btn primary w-full justify-center py-3 text-base"
                >
                  {loading ? "Signing in..." : "Sign In"}
                </button>
              </div>
            </form>
          </>
        )}

        {method === "magic" && (
          otpSent ? (
            <div className="text-center">
              <p className="text-[var(--ink)] font-medium mb-2">Check your inbox</p>
              <p className="text-[var(--muted)] text-sm mb-4">
                We sent a sign-in link to <strong>{otpEmail}</strong>. Open it on this device to continue.
              </p>
              <button
                type="button"
                onClick={sendOtp}
                disabled={otpLoading || otpCooldown}
                className="text-sm text-[var(--accent)] hover:underline font-medium"
              >
                Didn&apos;t get it? Resend
              </button>
            </div>
          ) : (
            <form onSubmit={handleSendOtp} className="space-y-5">
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={otpEmail}
                  onChange={(e) => setOtpEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                />
              </label>
              {otpError && <p className="text-[var(--danger)] text-sm">{otpError}</p>}
              <div className="pt-2">
                <button type="submit" disabled={otpLoading || otpCooldown} className="btn primary w-full justify-center py-3 text-base">
                  {otpLoading ? "Sending..." : "Send Magic Link"}
                </button>
              </div>
            </form>
          )
        )}

        {method === "code" && (
          otpSent ? (
            <form onSubmit={handleVerifyOtp} className="space-y-5">
              <p className="text-[var(--muted)] text-sm">
                Enter the code we sent to <strong>{otpEmail}</strong>.
              </p>
              <label className="field">
                <span>Code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                  required
                  placeholder="12345678"
                  autoFocus
                  style={{ letterSpacing: "0.3em", textAlign: "center", fontSize: "1.1rem" }}
                />
              </label>
              {otpError && <p className="text-[var(--danger)] text-sm">{otpError}</p>}
              <div className="pt-2">
                <button type="submit" disabled={verifyLoading || otpCode.length < 6} className="btn primary w-full justify-center py-3 text-base">
                  {verifyLoading ? "Verifying..." : "Verify & Sign In"}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setOtpSent(false)}
                className="text-sm text-[var(--accent)] hover:underline font-medium"
              >
                Use a different email
              </button>
            </form>
          ) : (
            <form onSubmit={handleSendOtp} className="space-y-5">
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={otpEmail}
                  onChange={(e) => setOtpEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                />
              </label>
              {otpError && <p className="text-[var(--danger)] text-sm">{otpError}</p>}
              <div className="pt-2">
                <button type="submit" disabled={otpLoading || otpCooldown} className="btn primary w-full justify-center py-3 text-base">
                  {otpLoading ? "Sending..." : "Send Code"}
                </button>
              </div>
            </form>
          )
        )}

        {!isAdminHost && (
          <p className="mt-6 text-center text-sm text-[var(--muted)]">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="text-[var(--accent)] hover:underline font-medium">
              Sign Up
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
