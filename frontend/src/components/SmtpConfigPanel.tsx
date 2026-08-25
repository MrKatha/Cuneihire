"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { SmtpAccount } from "@/lib/types";
import toast from "react-hot-toast";
import { HelpTooltip } from "./HelpTooltip";

type Props = {
  accounts: SmtpAccount[];
  onSaveAccount: (
    account: Partial<SmtpAccount> & { id?: string; email: string; appPassword: string }
  ) => Promise<SmtpAccount | null>;
  onDeleteAccount: (id: string) => Promise<void>;
  onResetAll: () => void;
  onClose: () => void;
};

const PROVIDERS = [
  { id: "gmail", name: "Gmail", host: "smtp.gmail.com", port: 465, userLabel: "Username / Login", passLabel: "App Password", tooltip: "Google App Password" },
  { id: "sendgrid", name: "SendGrid", host: "smtp.sendgrid.net", port: 465, userLabel: "Username (usually 'apikey')", passLabel: "API Key", tooltip: "SendGrid API Key" },
  { id: "resend", name: "Resend", host: "smtp.resend.com", port: 465, userLabel: "Username (usually 'resend')", passLabel: "API Key", tooltip: "Resend API Key" },
  { id: "custom", name: "Custom SMTP", host: "", port: 465, userLabel: "Username", passLabel: "Password", tooltip: "Your SMTP Password" },
];

const SANITIZE_REGEX = /[^a-zA-Z0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/? ]/g;

// No more per-account daily limit (2026-08-25, operator ask — "Google by default provides a limit of 50
// mails per day so there should not be a daily limit option"). Every account gets this fixed default;
// the actual send cap is now a single account-wide setting controlled by "Activate Automation" in
// Settings, enforced backend-side in automail.worker.js.
const DEFAULT_DAILY_LIMIT = 50;

export function SmtpConfigPanel({ accounts, onSaveAccount, onDeleteAccount, onResetAll, onClose }: Props) {
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<"list" | "form">(accounts.length === 0 ? "form" : "list");
  const [editingId, setEditingId] = useState<string | undefined>(undefined);

  const [email, setEmail] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [provider, setProvider] = useState("gmail");
  const [host, setHost] = useState("smtp.gmail.com");
  const [port, setPort] = useState(465);
  const [imapEnabled, setImapEnabled] = useState(false);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);

  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const currentProvider = PROVIDERS.find((p) => p.id === provider) || PROVIDERS[0];
  const displayAppPassword = appPassword.startsWith("enc:") ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : appPassword;

  function resetForm() {
    setEditingId(undefined);
    setEmail("");
    setFromEmail("");
    setFromName("");
    setAppPassword("");
    setProvider("gmail");
    setHost("smtp.gmail.com");
    setPort(465);
    setImapEnabled(false);
    setImapHost("");
    setImapPort(993);
    setShowPassword(false);
    setMessage(null);
  }

  function openAddForm() {
    resetForm();
    setView("form");
  }

  function openEditForm(a: SmtpAccount) {
    setEditingId(a.id);
    setEmail(a.email);
    setFromEmail(a.fromEmail);
    setFromName(a.fromName);
    setAppPassword(a.appPassword);
    setProvider(a.provider);
    setHost(a.host);
    setPort(a.port);
    setImapEnabled(a.imapEnabled);
    setImapHost(a.imapHost || "");
    setImapPort(a.imapPort || 993);
    setMessage(null);
    setView("form");
  }

  function handleProviderChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    setProvider(val);
    const p = PROVIDERS.find((x) => x.id === val);
    if (p && p.id !== "custom") {
      setHost(p.host);
      setPort(p.port);
    }
    // Relay-only providers (SendGrid/Resend) have no real inbox to poll — never leave reply
    // monitoring silently enabled for one of these.
    if (val === "sendgrid" || val === "resend") {
      setImapEnabled(false);
    }
  }

  const canMonitorReplies = provider !== "sendgrid" && provider !== "resend";

  async function handleVerifyAndSave() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, appPassword, host, port }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setMessage({ type: "err", text: data.error || "Verification failed" });
        toast.error(data.error || "Verification failed");
        return;
      }

      const saved = await onSaveAccount({
        id: editingId,
        // No user-facing label any more — the mailbox's own address IS the account's name everywhere.
        label: email.trim(),
        provider,
        email: email.trim(),
        appPassword: data.encryptedPassword,
        host,
        port,
        fromEmail: fromEmail.trim(),
        fromName: fromName.trim(),
        dailyLimit: DEFAULT_DAILY_LIMIT,
        isVerified: true,
        isActive: true,
        imapEnabled: canMonitorReplies && imapEnabled,
        imapHost: imapHost.trim() || undefined,
        imapPort,
      });
      if (!saved) {
        toast.error("Verified, but failed to save the account. Please try again.");
        return;
      }

      toast.success(editingId ? "Account updated!" : "Account added!");
      resetForm();
      setView("list");
    } catch {
      setMessage({ type: "err", text: "Network error" });
      toast.error("Network error during verification");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(a: SmtpAccount) {
    if (!window.confirm(`Remove "${a.email}"? Sending will stop using this mailbox.`)) return;
    await onDeleteAccount(a.id);
    toast.success("Account removed.");
  }

  function handleReset() {
    if (
      !window.confirm(
        "Reset all settings? Clears recipients, templates, and delay. SMTP accounts are kept — remove them individually if you want those gone too."
      )
    ) {
      return;
    }
    onResetAll();
    toast.success("All settings have been reset.");
  }

  if (!mounted) return null;

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onClose} style={{ zIndex: 99999 }}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="smtp-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 id="smtp-modal-title">SMTP accounts</h2>
            <p className="hint compact">
              Add one or more mailboxes — sends spread across them automatically.
            </p>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="modal-body">
          {view === "list" && (
            <>
              {accounts.length === 0 ? (
                <p className="hint">No SMTP accounts yet — add one to start sending.</p>
              ) : (
                <ul className="file-list tall" style={{ marginBottom: "1rem" }}>
                  {accounts.map((a) => (
                    <li key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                      <div>
                        <div style={{ fontWeight: 500 }}>{a.email}</div>
                        <div className="hint compact">
                          <span className={a.isVerified ? "msg ok" : "msg err"}>
                            {a.isVerified ? "Verified" : "Not verified"}
                          </span>
                          {!a.isActive && " · Paused"}
                        </div>
                      </div>
                      <span style={{ display: "flex", gap: "0.4rem", flex: "none" }}>
                        <button type="button" className="btn ghost" onClick={() => openEditForm(a)}>
                          Edit
                        </button>
                        <button type="button" className="btn ghost danger" onClick={() => handleDelete(a)}>
                          Remove
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="row">
                <button type="button" className="btn primary" onClick={openAddForm} id="tour-smtp-add">
                  + Add account
                </button>
                <button type="button" className="btn ghost danger" onClick={handleReset}>
                  Reset all
                </button>
              </div>
            </>
          )}

          {view === "form" && (
            <>
              <div className="grid-2">
                <label className="field" style={{ gridColumn: "1 / -1" }}>
                  <span>Provider</span>
                  <select value={provider} onChange={handleProviderChange}>
                    {PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>

                {provider === "custom" && (
                  <>
                    <label className="field">
                      <span>SMTP Host</span>
                      <input
                        type="text"
                        value={host}
                        onChange={(e) => { setHost(e.target.value); setMessage(null); }}
                        placeholder="smtp.example.com"
                      />
                    </label>
                    <label className="field">
                      <span>Port</span>
                      <input
                        type="number"
                        value={port}
                        onChange={(e) => { setPort(parseInt(e.target.value, 10)); setMessage(null); }}
                        placeholder="465"
                      />
                    </label>
                  </>
                )}

                <label className="field">
                  <span>From / Sender Email</span>
                  <input
                    type="email"
                    value={fromEmail}
                    onChange={(e) => { setFromEmail(e.target.value); setMessage(null); }}
                    placeholder={email || "e.g. mail@example.com"}
                  />
                </label>

                <label className="field">
                  <span>From / Sender Name</span>
                  <input
                    type="text"
                    value={fromName}
                    onChange={(e) => { setFromName(e.target.value); setMessage(null); }}
                    placeholder="e.g. John Doe"
                  />
                </label>

                <label className="field">
                  <span>{currentProvider.userLabel}</span>
                  <input
                    id="tour-smtp-email"
                    type="text"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setMessage(null); }}
                    placeholder={provider === "gmail" ? "you@gmail.com" : ""}
                  />
                </label>

                <label className="field">
                  <span>
                    {currentProvider.passLabel}
                    {provider === "gmail" && (
                      <HelpTooltip
                        title="Google App Password"
                        content={
                          <>
                            <p>To let this app send emails on your behalf, you need a <strong>Google App Password</strong>.</p>
                            <p><strong>Steps to generate one:</strong></p>
                            <ol style={{ paddingLeft: "1.5rem", margin: "0.5rem 0" }}>
                              <li>Go to your Google Account Settings.</li>
                              <li>Turn on <strong>2-Step Verification</strong> if it isn't already.</li>
                              <li>Search for "App Passwords" in your account settings.</li>
                              <li>Create a new app password (name it "Cuneihire") and copy the 16-character code.</li>
                            </ol>
                            <p>Paste that 16-character code here (spaces don't matter).</p>
                          </>
                        }
                      />
                    )}
                  </span>
                  <div className="password-wrap">
                    <input
                      id="tour-smtp-password"
                      type={showPassword ? "text" : "password"}
                      value={displayAppPassword}
                      onChange={(e) => {
                        let val = e.target.value;
                        if (appPassword.startsWith("enc:")) {
                          val = val.replace(SANITIZE_REGEX, "");
                        }
                        setAppPassword(val);
                        setMessage(null);
                      }}
                      placeholder="xxxx xxxx xxxx xxxx"
                    />
                    <button
                      type="button"
                      className="btn ghost password-toggle"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                </label>

                {canMonitorReplies ? (
                  <label className="field" style={{ gridColumn: "1 / -1" }}>
                    <span>
                      Enable reply monitoring
                      <HelpTooltip
                        title="Reply monitoring"
                        content={
                          <p>
                            Uses this account&apos;s same password to check for replies via IMAP, and
                            surfaces them on the matching contact in JAMS. Only works for a real mailbox
                            like Gmail or another IMAP-capable inbox — not relay services like SendGrid
                            or Resend, which have no inbox to check.
                          </p>
                        }
                      />
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.25rem" }}>
                      <input
                        type="checkbox"
                        checked={imapEnabled}
                        onChange={(e) => setImapEnabled(e.target.checked)}
                        style={{ width: "1.2rem", height: "1.2rem" }}
                      />
                      <span style={{ fontSize: "0.85rem", color: imapEnabled ? "var(--ok)" : "var(--muted)" }}>
                        {imapEnabled ? "Active" : "Inactive"}
                      </span>
                    </div>
                  </label>
                ) : (
                  <p className="hint compact" style={{ gridColumn: "1 / -1" }}>
                    Reply monitoring isn&apos;t available for {currentProvider.name} — it&apos;s a relay
                    service with no inbox to check.
                  </p>
                )}

                {canMonitorReplies && imapEnabled && provider === "custom" && (
                  <>
                    <label className="field">
                      <span>IMAP Host</span>
                      <input
                        type="text"
                        value={imapHost}
                        onChange={(e) => setImapHost(e.target.value)}
                        placeholder="imap.example.com"
                      />
                    </label>
                    <label className="field">
                      <span>IMAP Port</span>
                      <input
                        type="number"
                        value={imapPort}
                        onChange={(e) => setImapPort(parseInt(e.target.value, 10) || 993)}
                        placeholder="993"
                      />
                    </label>
                  </>
                )}
              </div>

              <div className="row">
                <button
                  type="button"
                  className="btn primary"
                  onClick={handleVerifyAndSave}
                  disabled={loading || !email || !appPassword || !host || !port}
                >
                  {loading ? "Verifying..." : "Verify & Save"}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    resetForm();
                    setView("list");
                  }}
                >
                  {accounts.length > 0 ? "Back to accounts" : "Cancel"}
                </button>
                {message && (
                  <span className={message.type === "ok" ? "msg ok" : "msg err"}>
                    {message.text}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
