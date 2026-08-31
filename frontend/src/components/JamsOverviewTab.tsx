"use client";

import { useMemo } from "react";
import {
  roleLabel,
  type AutomailConfig,
  type CandidateProfile,
  type Recipient,
  type RoleDef,
  type SentRecord,
  type SmtpAccount,
} from "@/lib/types";

type Props = {
  profile: CandidateProfile;
  automail: AutomailConfig;
  smtpAccounts: SmtpAccount[];
  sentTodayCount: number;
  globalMaxDailyLimit: number;
  aiCredits: number;
  appCredits: number;
  recipients: Recipient[];
  sentLog: SentRecord[];
  roleDefs: RoleDef[];
  onOpenQuickSend: () => void;
};

function StatTile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "12px", padding: "0.9rem 1rem", minWidth: 0 }}>
      <div className="hint compact" style={{ margin: "0 0 0.3rem" }}>{label}</div>
      <div style={{ fontSize: "1.4rem", fontWeight: 650, lineHeight: 1.1 }}>{value}</div>
      {sub && <div className="hint compact" style={{ margin: "0.25rem 0 0" }}>{sub}</div>}
    </div>
  );
}

// The candidate's "what's working" snapshot (2026-08-25, operator ask — "one tab is for the like stats,
// metrics, analytics, overall things that are working"), replacing the old standalone Dashboard tab as
// JAMS's landing sub-tab. Read-only — the automation on/off toggle itself moved to Settings the next day
// (2026-08-26, operator ask — "just have a quick toggle button for the setting, like play or pause...
// forget about the whole section and just move the button to the settings"), so this page no longer edits
// `automail` at all; the "Sent today" tile below still shows Active/Paused as context. Everything that felt
// like a setting (SMTP/LinkedIn connect, who writes an email, account) already lived in SettingsTab.tsx.
// Quick Send is the one action that stays here (moved from the old Dashboard) — an action, not config.
export function JamsOverviewTab({
  profile,
  automail,
  smtpAccounts,
  sentTodayCount,
  globalMaxDailyLimit,
  aiCredits,
  appCredits,
  recipients,
  sentLog,
  roleDefs,
  onOpenQuickSend,
}: Props) {
  const readyAccounts = smtpAccounts.filter((a) => a.isVerified && a.isActive);
  // "There will be a limit either by the plan or by the connected SMTP" (operator ask) — the smaller of
  // the admin's account-wide ceiling and what the connected mailboxes can physically send (50/day each,
  // Gmail's own real default — see SmtpConfigPanel.tsx). Still used by the "Sent today" tile below.
  const smtpCeiling = readyAccounts.length * 50;
  const effectiveMaxLimit = Math.max(0, Math.min(globalMaxDailyLimit, smtpCeiling));

  const totalSent = useMemo(() => recipients.filter((r) => (r.status || "pending") === "sent").length, [recipients]);
  const totalReplied = useMemo(() => recipients.filter((r) => r.hasReplied).length, [recipients]);
  const replyRatePct = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;

  const perRole = useMemo(() => {
    const map = new Map<string, { role: string; total: number; sent: number; replied: number }>();
    for (const r of recipients) {
      const row = map.get(r.role) || { role: r.role, total: 0, sent: 0, replied: 0 };
      row.total += 1;
      if ((r.status || "pending") === "sent") row.sent += 1;
      if (r.hasReplied) row.replied += 1;
      map.set(r.role, row);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [recipients]);

  const recentSends = useMemo(
    () =>
      [...sentLog]
        .filter((s) => s.status === "sent")
        .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
        .slice(0, 5),
    [sentLog]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: "1rem" }}>Welcome{profile?.name ? `, ${profile.name.split(" ")[0]}` : ""}</h3>
          <p className="hint compact" style={{ margin: "0.2rem 0 0" }}>What&apos;s working, at a glance.</p>
        </div>
        <button type="button" className="btn primary large" onClick={onOpenQuickSend}>
          + Quick Send
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem" }}>
        <StatTile
          label="Sent today"
          value={`${sentTodayCount} / ${effectiveMaxLimit}`}
          sub={automail.enabled ? "Automation active" : "Automation paused"}
        />
        <StatTile label="Total contacts" value={recipients.length} />
        <StatTile label="Total sent" value={totalSent} />
        <StatTile label="Replies" value={totalReplied} sub={totalSent > 0 ? `${replyRatePct}% reply rate` : undefined} />
        <StatTile label="App credits" value={appCredits} sub="remaining — every send uses one" />
        <StatTile label="AI credits" value={aiCredits} sub="remaining" />
      </div>

      <div style={{ border: "1px solid var(--line)", borderRadius: "12px", padding: "1.25rem" }}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem" }}>Recent activity</h3>
        {recentSends.length === 0 ? (
          <p className="hint compact">Nothing sent yet — activity will show up here once you do.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {recentSends.map((s, i) => (
              <li key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", gap: "0.5rem" }}>
                <span>{s.email} <span className="hint compact">({roleLabel(roleDefs, s.role)})</span></span>
                <span className="hint compact">{new Date(s.sentAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {perRole.length > 0 && (
        <div style={{ border: "1px solid var(--line)", borderRadius: "12px", padding: "1.25rem" }}>
          <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem" }}>By role</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "0.3rem 0.5rem 0.5rem 0", color: "var(--muted)", fontWeight: 600 }}>Role</th>
                <th style={{ textAlign: "right", padding: "0.3rem 0.5rem 0.5rem", color: "var(--muted)", fontWeight: 600 }}>Contacts</th>
                <th style={{ textAlign: "right", padding: "0.3rem 0.5rem 0.5rem", color: "var(--muted)", fontWeight: 600 }}>Sent</th>
                <th style={{ textAlign: "right", padding: "0.3rem 0 0.5rem 0.5rem", color: "var(--muted)", fontWeight: 600 }}>Replied</th>
              </tr>
            </thead>
            <tbody>
              {perRole.map((row) => (
                <tr key={row.role} style={{ borderTop: "1px solid var(--line)" }}>
                  <td style={{ padding: "0.4rem 0.5rem 0.4rem 0" }}>{roleLabel(roleDefs, row.role)}</td>
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>{row.total}</td>
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>{row.sent}</td>
                  <td style={{ padding: "0.4rem 0 0.4rem 0.5rem", textAlign: "right" }}>{row.replied}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
