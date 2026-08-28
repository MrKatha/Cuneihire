"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import HexMark from "@/components/ui/HexMark";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback`,
    });
    // Always show the same outcome regardless of whether the account exists or the call errored —
    // Supabase's own API doesn't leak account existence on this endpoint either; matching that here
    // avoids turning "forgot password" into an email-enumeration tool.
    setLoading(false);
    setSent(true);
  }

  return (
    <main className="flex items-center justify-center p-4 w-full h-full my-auto flex-grow relative">
      <Link href="/login" className="absolute top-6 left-6 md:top-10 md:left-10 flex items-center gap-2 text-sm font-medium transition-colors" style={{ color: "var(--muted)" }}>
        <ArrowLeft size={16} /> Back to Login
      </Link>
      <div className="w-full max-w-md p-8 bg-[var(--bg-panel)] border border-[var(--line)]">
        <Link href="/" className="text-center mb-8 flex flex-col items-center hover:opacity-80 transition-opacity block">
          <HexMark variant="outline" size={48} className="mb-4" />
          <h1 className="text-3xl font-bold mb-2 tracking-tight" style={{ color: "var(--ink)", fontFamily: "var(--font-display), Georgia, serif" }}>Cuneihire</h1>
        </Link>

        {sent ? (
          <>
            <div className="text-center mb-2">
              <p className="text-[var(--ink)] font-medium mb-2">Check your inbox</p>
              <p className="text-[var(--muted)] text-sm">
                If an account exists for <strong>{email}</strong>, we&apos;ve sent a link to reset your password.
                It expires shortly and can only be used once.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="text-center mb-8">
              <p className="text-[var(--muted)]">Enter your email and we&apos;ll send you a link to reset your password.</p>
            </div>
            <form onSubmit={handleSubmit} className="space-y-5">
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                  autoFocus
                />
              </label>
              <div className="pt-2">
                <button type="submit" disabled={loading} className="btn primary w-full justify-center py-3 text-base">
                  {loading ? "Sending..." : "Send Reset Link"}
                </button>
              </div>
            </form>
          </>
        )}

        <p className="mt-6 text-center text-sm text-[var(--muted)]">
          Remembered your password?{" "}
          <Link href="/login" className="text-[var(--accent)] hover:underline font-medium">
            Log In
          </Link>
        </p>
      </div>
    </main>
  );
}
