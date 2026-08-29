"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, ArrowLeft } from "lucide-react";
import HexMark from "@/components/ui/HexMark";
import { isCompanyEmail } from "@/lib/companyEmail";
import { logInfraUsage } from "@/lib/logInfraUsage";

type AccountType = "candidate" | "recruiter";

export default function SignUpPage() {
  // setAccountType removed (2026-08-25) along with the toggle UI below — see that comment. Add it back
  // alongside the toggle buttons when the recruiter phase starts.
  const [accountType] = useState<AccountType>("candidate");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [allowSignups, setAllowSignups] = useState<boolean | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/public/settings")
      .then(res => res.json())
      .then(data => {
        if (data.success && data.data) {
          setAllowSignups(data.data.allow_signups !== false);
        } else {
          setAllowSignups(true); // default fallback
        }
      })
      .catch(() => setAllowSignups(true));
  }, []);

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      setLoading(false);
      return;
    }

    // Recruiter accounts need a real company email — one email is locked to one account type for
    // good, so this can't be fixed later from inside the app. See docs/architecture.md's "Recruiter
    // portal" section.
    if (accountType === "recruiter" && !isCompanyEmail(email)) {
      setError("Recruiter accounts require a company email address — personal providers like Gmail, Yahoo, or Outlook aren't accepted.");
      setLoading(false);
      return;
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { account_type: accountType } },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      // The project requires email confirmation (mailer_autoconfirm is off) — signInWithPassword will
      // fail with error.code "email_not_confirmed" until the link below is clicked, so don't tell people
      // they can log in immediately.
      setSuccess("Account created! Check your email for a confirmation link before logging in.");
      setLoading(false);
      logInfraUsage(email, "signup_confirm");
      setTimeout(() => router.push("/login"), 4000);
    }
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
        <p className="text-[var(--muted)] text-center mb-6">Create your account to get started.</p>

        {allowSignups === false ? (
          <div className="p-6 bg-[var(--danger-dim)] text-[var(--danger)] text-center border border-[var(--danger)] border-opacity-20">
            <h3 className="font-bold text-lg mb-2">Signups Closed</h3>
            <p className="text-sm opacity-90">
              We are not accepting new accounts at this time. Please check back later or contact the administrator.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSignUp} className="space-y-5">
          {/* Recruiter signup toggle disabled for now (2026-08-25) — recruiter is its own phase with its
              own profile/portal that isn't built yet; every signup is a candidate account until then.
              `accountType` below stays wired (defaults to "candidate") so re-enabling this is just:
              restore `setAccountType` above and the toggle buttons removed here. */}
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
            <span>Password</span>
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
          
          <div className="field">
            <span>Confirm Password</span>
            <div className="relative flex items-center">
              <input
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="w-full pr-10"
              />
              <button
                type="button"
                className="absolute right-3 text-[var(--muted)] hover:text-[var(--accent)] transition-colors"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              >
                {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {error && <p className="text-[var(--danger)] text-sm">{error}</p>}
          {success && <p className="text-[var(--ok)] text-sm">{success}</p>}

          <div className="pt-2">
            <button
              type="submit"
              disabled={loading}
              className="btn primary w-full justify-center py-3 text-base"
            >
              {loading ? "Creating Account..." : "Sign Up"}
            </button>
          </div>
        </form>
        )}

        <p className="mt-6 text-center text-sm text-[var(--muted)]">
          Already have an account?{" "}
          <Link href="/login" className="text-[var(--accent)] hover:underline font-medium">
            Log In
          </Link>
        </p>
      </div>
    </main>
  );
}
