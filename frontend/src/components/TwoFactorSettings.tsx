"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Factor = { id: string; status: "verified" | "unverified" };

// Self-contained (2026-08-28, login/logout auth-flow rework) — deliberately not threaded through
// SettingsTab's props / the app's AppState/loadState round trip like the rest of that component: MFA
// enrollment state lives entirely in Supabase's own auth.mfa_factors, not in any automailsend_* table, so
// there's nothing for this app's own state model to own here.
export function TwoFactorSettings() {
  const [factor, setFactor] = useState<Factor | null>(null);
  const [loadingFactors, setLoadingFactors] = useState(true);

  // Enrollment in progress
  const [enrolling, setEnrolling] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [pendingFactorId, setPendingFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function refreshFactors() {
    setLoadingFactors(true);
    supabase.auth.mfa.listFactors().then(({ data, error }) => {
      setLoadingFactors(false);
      if (error) return;
      const verified = data?.totp?.find((f) => f.status === "verified");
      setFactor(verified ? { id: verified.id, status: "verified" } : null);
    });
  }

  useEffect(() => {
    refreshFactors();
  }, []);

  async function handleEnroll() {
    setError(null);
    setBusy(true);
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", issuer: "Cuneihire" });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setPendingFactorId(data.id);
    setQrCode(data.totp.qr_code);
    setSecret(data.totp.secret);
    setEnrolling(true);
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingFactorId) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: pendingFactorId, code });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setEnrolling(false);
    setQrCode(null);
    setSecret(null);
    setPendingFactorId(null);
    setCode("");
    refreshFactors();
  }

  async function handleCancelEnroll() {
    if (pendingFactorId) {
      await supabase.auth.mfa.unenroll({ factorId: pendingFactorId });
    }
    setEnrolling(false);
    setQrCode(null);
    setSecret(null);
    setPendingFactorId(null);
    setCode("");
    setError(null);
  }

  async function handleDisable() {
    if (!factor) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    refreshFactors();
  }

  if (loadingFactors) {
    return <p className="hint compact">Checking your 2FA status…</p>;
  }

  if (factor) {
    return (
      <div>
        <p className="hint compact" style={{ marginBottom: "0.75rem" }}>
          Two-factor authentication is <strong>enabled</strong> — you&apos;ll be asked for a code from your
          authenticator app at login. If you lose access to it, contact support to have it removed.
        </p>
        {error && <p className="text-[var(--danger)] text-sm" style={{ marginBottom: "0.5rem" }}>{error}</p>}
        <button type="button" className="btn ghost danger" onClick={handleDisable} disabled={busy}>
          {busy ? "Disabling..." : "Disable 2FA"}
        </button>
      </div>
    );
  }

  if (enrolling) {
    return (
      <form onSubmit={handleConfirm}>
        <p className="hint compact" style={{ marginBottom: "0.75rem" }}>
          Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.), or
          enter the key manually, then confirm with the 6-digit code it generates.
        </p>
        {qrCode && (
          // Supabase returns the QR as a ready-to-use data:image/svg+xml URI, not raw markup — next/image
          // doesn't handle data URIs, so a plain <img> (same pattern as AttachmentPreviewModal.tsx) is right.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qrCode} alt="Scan with your authenticator app" style={{ width: 180, height: 180, marginBottom: "0.75rem" }} />
        )}
        {secret && (
          <p className="hint compact" style={{ marginBottom: "0.75rem", wordBreak: "break-all" }}>
            Can&apos;t scan? Enter this key manually: <code>{secret}</code>
          </p>
        )}
        <label className="field" style={{ maxWidth: "220px" }}>
          <span>Confirmation Code</span>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            autoFocus
          />
        </label>
        {error && <p className="text-[var(--danger)] text-sm" style={{ margin: "0.5rem 0" }}>{error}</p>}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
          <button type="submit" className="btn primary" disabled={busy || code.length !== 6}>
            {busy ? "Confirming..." : "Confirm & Enable"}
          </button>
          <button type="button" className="btn ghost" onClick={handleCancelEnroll} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div>
      <p className="hint compact" style={{ marginBottom: "0.75rem" }}>
        Add an extra layer of security — after your password (or magic link/email code), you&apos;ll also
        need a code from an authenticator app.
      </p>
      {error && <p className="text-[var(--danger)] text-sm" style={{ marginBottom: "0.5rem" }}>{error}</p>}
      <button type="button" className="btn primary" onClick={handleEnroll} disabled={busy}>
        {busy ? "Starting..." : "Enable 2FA"}
      </button>
    </div>
  );
}
