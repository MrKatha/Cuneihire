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
  onAutomailChange: (automail: AutomailConfig) => void;
  smtpAccounts: SmtpAccount[];
  sentTodayCount: number;
  globalMaxDailyLimit: number;
  aiCredits: number;
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
// JAMS's landing sub-tab. The automation on/off toggle stays here, not in Settings ("the toggle for the
// automation should obviously be in our dashboard" — operator, same day) — everything else that felt like
// a setting (SMTP/LinkedIn connect, who writes an email, account) moved to SettingsTab.tsx. Quick Send is
// the other action that stays here (moved from the old Dashboard, same reasoning — an action, not config).
export function JamsOverviewTab({
  profile,
  automail,
  onAutomailChange,
  smtpAccounts,
  sentTodayCount,
  globalMaxDailyLimit,
  aiCredits,
  recipients,
  sentLog,
  roleDefs,
  onOpenQuickSend,
}: Props) {
  const readyAccounts = smtpAccounts.filter((a) => a.isVerified && a.isActive);
  // "There will be a limit either by the plan or by the connected SMTP" (operator ask) — the smaller of
  // the admin's account-wide ceiling and what the connected mailboxes can physically send (50/day each,
  // Gmail's own real default — see SmtpConfigPanel.tsx).
  const smtpCeiling = readyAccounts.length * 50;
  const effectiveMaxLimit = Math.max(0, Math.min(globalMaxDailyLimit, smtpCeiling));
  const limitedBy = globalMaxDailyLimit <= smtpCeiling ? "plan" : "connected SMTP accounts";
  const canActivate = readyAccounts.length > 0;
  const progressPct = effectiveMaxLimit > 0 ? Math.min(100, Math.round((sentTodayCount / effectiveMaxLimit) * 100)) : 0;

  function handleLimitChange(value: number) {
    const clamped = Math.min(Math.max(1, value || 1), effectiveMaxLimit || 1);
    onAutomailChange({ ...automail, dailyLimit: clamped });
  }

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
        <StatTile label="AI credits" value={aiCredits} sub="remaining" />
      </div>

      {/* Automation — the one control that stays on this page rather than Settings. */}
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
        {!canActivate && (
          <p className="hint compact" style={{ color: "var(--danger)", marginTop: "-0.5rem", marginBottom: "0.75rem" }}>
            Connect an SMTP account on the Settings tab first.
          </p>
        )}

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
