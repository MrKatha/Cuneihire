"use client";

import { useEffect, useState } from "react";
import type { AutoFetchConfig, AutomailConfig, CandidateProfile, SentRecord, SmtpAccount } from "@/lib/types";
import { ExecutionLogsPanel } from "./ExecutionLogsPanel";

const ACTIVITY_OPEN_KEY = "cuneihire_dashboard_activity_open";

type Props = {
  userId: string | null;
  profile: CandidateProfile;
  automail: AutomailConfig;
  onAutomailChange: (automail: AutomailConfig) => void;
  smtpAccounts: SmtpAccount[];
  autoFetch: AutoFetchConfig;
  sentTodayCount: number;
  globalMaxDailyLimit: number;
  aiCredits: number;
  sentLog: SentRecord[];
  onOpenSmtp: () => void;
  onOpenAutoFetch: () => void;
  onOpenQuickSend: () => void;
};

// The candidate's landing page (2026-08-25, operator ask — "one dashboard where the candidate can see
// the progress and the daily limit... the toggle for the automation should obviously be in our
// dashboard"). JAMS stays the detailed CRM-style contact tracker; this is the at-a-glance summary +
// controls home page, and is now the app's default/landing tab (see page.tsx). The automation toggle and
// daily-limit setter moved here from Settings (was an inline row there); Quick Send moved here from
// JAMS entirely, per the same ask ("It should be moved to that page").
export function DashboardTab({
  userId,
  profile,
  automail,
  onAutomailChange,
  smtpAccounts,
  autoFetch,
  sentTodayCount,
  globalMaxDailyLimit,
  aiCredits,
  sentLog,
  onOpenSmtp,
  onOpenAutoFetch,
  onOpenQuickSend,
}: Props) {
  const readyAccounts = smtpAccounts.filter((a) => a.isVerified && a.isActive);
  // "There will be a limit either by the plan or by the connected SMTP" (operator ask) — the smaller of
  // the admin's account-wide ceiling and what the connected mailboxes can physically send (50/day each,
  // Gmail's own real default — see SmtpConfigPanel.tsx). Zero connected accounts correctly floors this
  // to zero: nothing can send until one's connected, and the UI below says so.
  const smtpCeiling = readyAccounts.length * 50;
  const effectiveMaxLimit = Math.max(0, Math.min(globalMaxDailyLimit, smtpCeiling));
  const limitedBy = globalMaxDailyLimit <= smtpCeiling ? "plan" : "connected SMTP accounts";

  const linkedInConnected = automailLinkedInConnected(autoFetch);
  const canActivate = readyAccounts.length > 0;

  // Automation Activity — moved here from JAMS (2026-08-25, operator ask). ExecutionLogsPanel is fully
  // self-contained (only needs userId), so the move is just relocating where it's rendered.
  const [activityOpen, setActivityOpen] = useState(false);
  useEffect(() => {
    setActivityOpen(typeof window !== "undefined" && localStorage.getItem(ACTIVITY_OPEN_KEY) === "1");
  }, []);
  function toggleActivity() {
    setActivityOpen((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") localStorage.setItem(ACTIVITY_OPEN_KEY, next ? "1" : "0");
      return next;
    });
  }

  function handleLimitChange(value: number) {
    const clamped = Math.min(Math.max(1, value || 1), effectiveMaxLimit || 1);
    onAutomailChange({ ...automail, dailyLimit: clamped });
  }

  const recentSends = [...sentLog]
    .filter((s) => s.status === "sent")
    .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
    .slice(0, 5);

  const progressPct = effectiveMaxLimit > 0 ? Math.min(100, Math.round((sentTodayCount / effectiveMaxLimit) * 100)) : 0;

  return (
    <div className="panel flex-col gap-4">
      <div>
        <h2 className="panel-title">Welcome{profile?.name ? `, ${profile.name.split(" ")[0]}` : ""}</h2>
        <p className="hint compact">Your automation, connections, and daily progress at a glance.</p>
      </div>

      <button type="button" className="btn primary large" onClick={onOpenQuickSend} style={{ alignSelf: "flex-start" }}>
        + Quick Send
      </button>

      <div className="grid-2" style={{ gap: "1rem", alignItems: "stretch" }}>
        {/* Automation card */}
        <div style={{ border: "1px solid var(--line)", borderRadius: "12px", padding: "1.25rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
            <h3 style={{ margin: 0, fontSize: "1rem" }}>Automation</h3>
            <span className={automail.enabled ? "badge ok" : "badge warn"}>{automail.enabled ? "Active" : "Inactive"}</span>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "1rem" }}>
            <input
              type="checkbox"
              checked={automail.enabled}
              disabled={!canActivate}
              onChange={(e) => onAutomailChange({ ...automail, enabled: e.target.checked })}
              style={{ width: "1.2rem", height: "1.2rem" }}
            />
            <span style={{ fontSize: "0.9rem" }}>{automail.enabled ? "Sending automatically" : "Paused — turn on to start sending"}</span>
          </label>
          {!canActivate && <p className="hint compact" style={{ color: "var(--err)", marginTop: "-0.5rem", marginBottom: "0.75rem" }}>Connect an SMTP account below first.</p>}

          <div style={{ marginBottom: "0.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", marginBottom: "0.3rem" }}>
              <span>Sent today: {sentTodayCount} / {effectiveMaxLimit}</span>
              <span className="hint compact">Limited by {limitedBy}</span>
            </div>
            <div style={{ height: "8px", borderRadius: "999px", background: "var(--bg-elevated)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progressPct}%`, background: "var(--accent)", transition: "width 0.3s" }} />
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", marginTop: "0.75rem" }}>
            Daily limit
            <input
              type="number"
              min={1}
              max={effectiveMaxLimit || 1}
              value={automail.dailyLimit}
              disabled={effectiveMaxLimit === 0}
              onChange={(e) => handleLimitChange(Number(e.target.value))}
              style={{ width: "70px" }}
            />
            <span className="hint compact">(max {effectiveMaxLimit}/day)</span>
          </label>
        </div>

        {/* Connections card */}
        <div style={{ border: "1px solid var(--line)", borderRadius: "12px", padding: "1.25rem" }}>
          <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem" }}>Connections</h3>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.6rem 0", borderBottom: "1px solid var(--line)" }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: "0.9rem" }}>SMTP mailboxes</div>
              <span className="hint compact">
                {readyAccounts.length === 0 ? "None connected" : `${readyAccounts.length} connected (${smtpCeiling}/day capacity)`}
              </span>
            </div>
            <button type="button" className="btn ghost small" onClick={onOpenSmtp}>
              {readyAccounts.length === 0 ? "Connect" : "Manage"}
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.6rem 0" }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: "0.9rem" }}>LinkedIn</div>
              <span className={linkedInConnected ? "badge ok" : "badge warn"} style={{ fontSize: "0.7rem" }}>
                {linkedInConnected ? "Connected" : "Not connected"}
              </span>
            </div>
            <button type="button" className="btn ghost small" onClick={onOpenAutoFetch}>
              {linkedInConnected ? "Manage" : "Connect"}
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.6rem 0 0", marginTop: "0.4rem", borderTop: "1px solid var(--line)" }}>
            <div style={{ fontWeight: 500, fontSize: "0.9rem" }}>AI credits</div>
            <span className="hint compact">{aiCredits} remaining</span>
          </div>
        </div>
      </div>

      {/* Recent activity */}
      <div style={{ border: "1px solid var(--line)", borderRadius: "12px", padding: "1.25rem" }}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem" }}>Recent activity</h3>
        {recentSends.length === 0 ? (
          <p className="hint compact">Nothing sent yet — activity will show up here once you do.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {recentSends.map((s, i) => (
              <li key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem" }}>
                <span>{s.email} <span className="hint compact">({s.role})</span></span>
                <span className="hint compact">{new Date(s.sentAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Automation Activity — the scraper/automail run log, moved here from JAMS */}
      <div style={{ border: "1px solid var(--line)", borderRadius: "12px", padding: "1.25rem" }}>
        <button type="button" className="btn ghost" onClick={toggleActivity} style={{ fontSize: "0.8rem" }}>
          {activityOpen ? "▾" : "▸"} Automation Activity
        </button>
        {activityOpen && userId && (
          <div style={{ marginTop: "1rem" }}>
            <ExecutionLogsPanel userId={userId} />
          </div>
        )}
      </div>
    </div>
  );
}

function automailLinkedInConnected(autoFetch: AutoFetchConfig) {
  return !!(autoFetch.liAt && autoFetch.liAt.trim() && autoFetch.jsessionid && autoFetch.jsessionid.trim());
}
