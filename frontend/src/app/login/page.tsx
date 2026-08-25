"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, ArrowLeft } from "lucide-react";
import HexMark from "@/components/ui/HexMark";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push("/");
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
        <div className="text-center mb-8">
          <p className="text-[var(--muted)]">Welcome back. Please sign in to continue.</p>
        </div>

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

          {error && <p className="text-[var(--danger)] text-sm">{error}</p>}

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

        <p className="mt-6 text-center text-sm text-[var(--muted)]">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="text-[var(--accent)] hover:underline font-medium">
            Sign Up
          </Link>
        </p>
      </div>
    </main>
  );
}
