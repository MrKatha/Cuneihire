"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { AutomailConfig, SmtpAccount, Role, RoleTemplate } from "@/lib/types";
import toast from "react-hot-toast";
import { HelpTooltip } from "./HelpTooltip";

type Props = {
  config: AutomailConfig;
  smtpAccounts: SmtpAccount[];
  templates: Record<Role, RoleTemplate[]>;
  sentTodayCount: number;
  onSave: (config: AutomailConfig) => void;
  onClose: () => void;
};

export function AutomailModal({ config, smtpAccounts, templates, sentTodayCount, onSave, onClose }: Props) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [dailyLimit, setDailyLimit] = useState(config.dailyLimit);
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  async function handleSave() {
    if (enabled) {
      // 1. Verify at least one SMTP account is set up and verified (each account was already verified
      // via /api/verify when it was added, so there's no need to re-verify credentials here).
      const hasReadyAccount = smtpAccounts.some((a) => a.isVerified && a.isActive);
      if (!hasReadyAccount) {
        toast.error("Please add and verify at least one SMTP account first!");
        setEnabled(false);
        return;
      }

      // 2. Verify at least one template exists
      const hasTemplate = Object.values(templates).flat().some(t => t.subject.trim() !== "" && t.content.trim() !== "");
      if (!hasTemplate) {
        toast.error("Please create at least one email template before enabling Automail!");
        setEnabled(false);
        return;
      }
    }

    onSave({
      enabled,
      dailyLimit,
      // Candidate Info now lives on the Profile page, not here — pass it through unchanged.
      candidateInfo: config.candidateInfo,
    });
    toast.success("Automail settings saved!");
    onClose();
  }

  if (!mounted) return null;

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onClose} style={{ zIndex: 99999 }}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="automail-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 id="automail-modal-title">Automail Settings</h2>
            <p className="hint compact">
              Automail will automatically send emails to pending contacts in the background.
            </p>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>

        <div className="modal-body">
          <label className="field">
            <span>
              Enable Background Automail
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.25rem" }}>
              <input
                id="tour-automail-enable"
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                style={{ width: "1.2rem", height: "1.2rem" }}
              />
              <span style={{ fontSize: "0.85rem", color: enabled ? "var(--ok)" : "var(--muted)" }}>
                {enabled ? "Active" : "Inactive"}
              </span>
            </div>
          </label>

          <div style={{ opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none', transition: 'opacity 0.2s' }}>
              <label className="field">
                <span>
                  Daily Mail Limit
                  <HelpTooltip 
                    title="Daily Mail Limit" 
                    content={
                      <>
                        <p>The maximum number of emails the system is allowed to send automatically in a single day.</p>
                        <p><strong>Recommendation:</strong> Keep this under 50 to avoid your email provider (like Gmail) flagging your account for spam.</p>
                      </>
                    } 
                  />
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                  <input
                    id="tour-automail-rules"
                    type="number"
                    min={1}
                    max={500}
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(Number(e.target.value) || 1)}
                    style={{ width: "100px" }}
                  />
                  <span style={{ fontSize: "1.05rem", fontWeight: "500", color: "var(--muted)" }}>
                    emails (Sent today: {sentTodayCount})
                  </span>
                </div>
                <span className="hint compact">Maximum emails to send automatically per day.</span>
              </label>

              <p className="hint compact">
                AI personalization, credits, and behavior settings have moved to the <strong>AI</strong>{" "}
                tab.
              </p>
          </div>

        </div>

        <hr style={{ border: "0", borderTop: "1px solid var(--line)", margin: "1rem 0" }} />
        
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button className="btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button id="tour-automail-save" className="btn primary" onClick={handleSave} disabled={loading}>
            {loading ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
