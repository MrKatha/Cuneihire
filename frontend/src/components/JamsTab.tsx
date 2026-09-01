"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { supabase } from "@/lib/supabase";
import {
  roleLabel,
  type AutomailConfig,
  type Recipient,
  type ReplyRecord,
  type Role,
  type RoleDef,
  type RoleTemplate,
  type SentRecord,
  type SmtpAccount,
  type SmtpConfig,
} from "@/lib/types";
import { matchScoreTone, firstUrl } from "@/lib/jobPosts";
import { StatusPill } from "./JobPostCard";
import { EmailDetailPanel } from "./EmailDetailPanel";

const PAGE_SIZE = 15;

type Props = {
  userId: string | null;
  recipients: Recipient[];
  roleDefs: RoleDef[];
  templates: Record<Role, RoleTemplate[]>;
  config: SmtpConfig;
  automail: AutomailConfig;
  smtpAccounts: SmtpAccount[];
  sentLog: SentRecord[];
  onSentLogChange: (sentLog: SentRecord[]) => void;
  replies: ReplyRecord[];
  sentTodayCount: number;
  sending: boolean;
  onSendingChange: (sending: boolean) => void;
  delaySec: number;
  onDelayChange: (delaySec: number) => void;
  onUpdateStatus?: (id: string, field: "status" | "phone_status", newStatus: string) => Promise<void>;
};

function sentKey(email: string, role: Role) {
  return `${email.toLowerCase()}::${role}`;
}

// The unified lifecycle hub — every contact found (scraped or manual), with matching context, sending
// actions, and each contact's own send history all in one place. Absorbs what used to be four separate
// tabs (Scraper & Contacts, Sending & Automail, Quick Send, Logs) — see docs/architecture.md. "Does this
// job match what I'm looking for" is a *before-you-reach-out* question, so that discovery/scoring board
// still lives on Jobs & Roles (JobsRolesTab.tsx); a contact sourced from a scraped post shows its match
// score here only as read-only context.
//
// The "Emails" sub-tab of JamsHub.tsx (2026-08-25) — no longer its own top-level `.panel`/panel-head; that
// shell (title, tab strip) now belongs to JamsHub, which renders this as one of three sub-tabs alongside
// Overview and Monitoring.
export function JamsTab({
  userId,
  recipients,
  roleDefs,
  templates,
  config,
  automail,
  smtpAccounts,
  sentLog,
  onSentLogChange,
  replies,
  sentTodayCount,
  sending,
  onSendingChange,
  delaySec,
  onDelayChange,
}: Props) {
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterSource, setFilterSource] = useState("all");
  const [filterRole, setFilterRole] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  // Real pagination (2026-09-01, operator ask — "only 15 emails should be visible on one page"),
  // replacing the old infinite-scroll IntersectionObserver. `page` is clamped against the current
  // filtered set below (see `currentPage`), so narrowing a filter can never strand you on a now-empty
  // page — see that clamp's comment for why there's no separate "reset to page 1" effect.
  const [page, setPage] = useState(1);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // The contact whose full detail (job, send history, follow-ups, replies) is open in the right-side
  // panel (2026-09-01, operator ask — replaces the old inline expand-row + separate small "preview one
  // sent email" modal with one consolidated view, opened by clicking the row itself). Stored as an id,
  // not the row object itself, and re-looked-up from the live `recipients` prop below — so if a reply
  // comes in or a follow-up sends while the panel is open, it reflects that instead of showing a stale
  // snapshot from the moment it was opened.
  const [detailRecipientId, setDetailRecipientId] = useState<string | null>(null);
  const detailRecipient = useMemo(
    () => (detailRecipientId ? recipients.find((r) => r.id === detailRecipientId) || null : null),
    [detailRecipientId, recipients]
  );
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Sending (ported from the old SendPanel/QuickSendTab — same backend batch mechanism)
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [status, setStatus] = useState("");
  const abortRef = useRef(false);
  const initialSentCount = useRef(0);
  const expectedTotal = useRef(0);

  // Rows currently queued on the backend batch worker — it polls every ~10s and then waits
  // send_delay_sec (anti-ban jitter) before actually sending, so a row can sit looking identically
  // "Pending" for tens of seconds with no visible sign anything is happening. This shows that it is.
  const [queuedIds, setQueuedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (queuedIds.size === 0) return;
    setQueuedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const r of recipients) {
        if (next.has(r.id) && (r.status || "pending") !== "pending") {
          next.delete(r.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipients]);

  function markQueued(ids: string[]) {
    setQueuedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    // Safety net in case a status update is ever missed — nothing should look "queued" forever.
    ids.forEach((id) => {
      setTimeout(() => {
        setQueuedIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 90000);
    });
  }


  useEffect(() => {
    if (sending && expectedTotal.current > 0) {
      const processed = Math.max(0, sentLog.length - initialSentCount.current);
      setProgress({ current: processed, total: expectedTotal.current });
      if (processed >= expectedTotal.current) {
        onSendingChange(false);
        setStatus("All emails processed.");
        toast.success("Finished sending batch.");
        expectedTotal.current = 0;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentLog.length, sending]);

  const filtered = useMemo(() => {
    return recipients.filter((r) => {
      if (filterStatus !== "all" && (r.status || "pending") !== filterStatus) return false;
      if (filterSource !== "all" && (r.source || "auto_fetch") !== filterSource) return false;
      if (filterRole !== "all" && r.role !== filterRole) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (![r.email, r.title].some((v) => (v || "").toLowerCase().includes(q))) return false;
      }
      return true;
    });
  }, [recipients, filterStatus, filterSource, filterRole, searchQuery]);

  // No explicit "reset to page 1 on filter change" effect here (that pattern needs either a useEffect,
  // which this repo's React Compiler lint config flags as a cascading-render risk, or a ref read/write
  // during render, which the same config disallows outright). Clamping below already guarantees `page`
  // never points past the end of the current filtered set — the one case that differs from a hard reset
  // is switching between two filters that both have several pages, which lands you on the same page
  // *number* under the new filter rather than jumping to page 1. Minor, and correctness-safe either way.
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function historyFor(r: Recipient) {
    const key = sentKey(r.email, r.role);
    return sentLog.filter((s) => sentKey(s.email, s.role) === key);
  }

  function repliesFor(r: Recipient) {
    return replies.filter((rep) => rep.recipientId === r.id);
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelectedIds((prev) => (prev.size === visible.length ? new Set() : new Set(visible.map((r) => r.id))));
  }

  async function deleteSelected() {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedIds.size} selected contact(s)?`)) return;
    const ids = Array.from(selectedIds);
    const { error } = await supabase.from("automailsend_recipients").delete().in("id", ids);
    if (error) {
      toast.error("Failed to delete selected contacts.");
    } else {
      toast.success(`Deleted ${ids.length} contact(s).`);
      setSelectedIds(new Set());
    }
  }

  async function sendList(list: Recipient[], options: { force: boolean }) {
    if (!userId) return;
    if (!smtpAccounts.some((a) => a.isVerified && a.isActive)) {
      setStatus("Add and verify an SMTP account first.");
      toast.error("Please add and verify at least one SMTP account first.");
      return;
    }
    if (!list.length) {
      setStatus(options.force ? "Nothing to resend." : "No pending contacts selected.");
      toast.error(options.force ? "Nothing to resend." : "No pending contacts selected.");
      return;
    }
    // 2026-08-20: how each recipient's email actually gets composed (manual template, "let AI choose"
    // among your templates, or "let AI write it" from scratch) is decided once, per role, on the Email
    // Templates tab's Configuration sub-tab — not re-chosen per bulk-send here. A manual/ai-select role
    // just needs SOME templates to exist (the worker resolves which one per recipient); an ai-write role
    // needs none at all — that's the whole point of the mode.
    for (const role of new Set(list.map((r) => r.role))) {
      const mode = roleDefs.find((d) => d.key === role)?.emailSendMode || "manual";
      if (mode !== "ai-write" && !(templates[role]?.length)) {
        setStatus(`No template set up for: ${roleLabel(roleDefs, role)}`);
        toast.error(`No template set up for role: ${roleLabel(roleDefs, role)} — add one on the Email Templates tab.`);
        return;
      }
    }

    abortRef.current = false;
    onSendingChange(true);
    setProgress({ current: 0, total: list.length });
    setStatus(`Preparing to send ${list.length} email(s)…`);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      toast.error("You must be logged in to send emails.");
      onSendingChange(false);
      return;
    }

    try {
      const toProcess = list.filter((r) => options.force || (r.status || "pending") !== "sent");
      if (toProcess.length === 0) {
        setStatus("Nothing new to send.");
        toast.success("All selected contacts have already been sent.");
        onSendingChange(false);
        return;
      }

      initialSentCount.current = sentLog.length;
      expectedTotal.current = toProcess.length;

      const updatedConfig = {
        ...config,
        batchTargetIds: list.length === recipients.length ? null : list.map((r) => r.id),
      };

      const { error } = await supabase
        .from("automailsend_app_state")
        .update({ batch_send_pending: true, batch_send_processing: false, config: updatedConfig })
        .eq("user_id", userId);

      if (error) {
        setStatus("Failed to start batch.");
        toast.error(error.message || "Failed to update database.");
        onSendingChange(false);
      } else {
        setStatus("Background send started! Tracking progress...");
        toast.success("Background send started!");
        setSelectedIds(new Set());
        markQueued(toProcess.map((r) => r.id));
      }
    } catch {
      setStatus("Network error queuing batch.");
      toast.error("Network error queuing batch.");
      onSendingChange(false);
    }
  }

  async function stopSending() {
    abortRef.current = true;
    setStatus("Stopping soon...");
    try {
      if (!userId) return;
      const { error } = await supabase
        .from("automailsend_app_state")
        .update({ batch_send_pending: false, batch_send_processing: false })
        .eq("user_id", userId);
      if (error) throw error;
      toast.success("Stop command sent. Ending loop...");
      onSendingChange(false);
      expectedTotal.current = 0;
    } catch {
      toast.error("Failed to send stop command.");
    }
  }

  // Scoped to `filtered`, not just the current page's `visible` — a selection made on page 1 should
  // still be included in Send/Delete Selected after paging to page 2, matching what the "N selected"
  // chip (which counts every selected id) implies.
  const selectedRecipients = useMemo(
    () => filtered.filter((r) => selectedIds.has(r.id)),
    [filtered, selectedIds]
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.5rem" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem" }}>
          <span style={{ color: "var(--muted)" }}>Daily mail limit:</span>
          <span style={{
            background: "var(--bg)",
            padding: "3px 10px",
            borderRadius: "999px",
            border: "1px solid var(--line)",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
          }}>
            <span style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: sentTodayCount >= automail.dailyLimit ? "var(--danger)" : "var(--ok)",
              display: "inline-block",
            }} />
            {sentTodayCount} / {automail.dailyLimit}
          </span>
        </span>
      </div>
      <div className="panel-body">
        {sentTodayCount >= automail.dailyLimit && (
          <div style={{ padding: "0.75rem", background: "var(--danger-light)", color: "var(--danger)", borderRadius: "6px", marginBottom: "1rem", fontSize: "0.9rem", textAlign: "center" }}>
            You have reached your daily limit of <strong>{automail.dailyLimit}</strong> emails. Sending is paused until tomorrow.
          </div>
        )}

        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 1, minWidth: "220px" }}>
            <span>Search</span>
            <input
              type="text"
              placeholder="Search email, title..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Email status</span>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="sent">Sent</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label className="field">
            <span>Source</span>
            <select value={filterSource} onChange={(e) => setFilterSource(e.target.value)}>
              <option value="all">All</option>
              <option value="auto_fetch">Auto-fetch</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          <label className="field">
            <span>Role</span>
            <select value={filterRole} onChange={(e) => setFilterRole(e.target.value)}>
              <option value="all">All roles</option>
              {roleDefs.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Delay (sec)</span>
            <input
              type="number"
              min={0}
              step={1}
              value={delaySec}
              onChange={(e) => onDelayChange(Number(e.target.value) || 0)}
              disabled={sending}
              style={{ width: "80px" }}
            />
          </label>
        </div>

        {selectedIds.size > 0 && (
          <div className="card-header actions-bar" style={{ marginTop: "1rem" }}>
            <span className="chip">{selectedIds.size} selected</span>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" className="btn" onClick={() => sendList(selectedRecipients, { force: false })} disabled={sending}>
                Send Selected
              </button>
              <button type="button" className="btn ghost danger" onClick={deleteSelected} disabled={sending}>
                Delete Selected
              </button>
              <button type="button" className="btn ghost" onClick={() => setSelectedIds(new Set())}>
                Clear selection
              </button>
            </div>
          </div>
        )}

        {status && <p className="status-line">{status}</p>}
        {sending && progress.total > 0 && (
          <div className="progress" style={{ marginBottom: "0.5rem" }}>
            <div className="progress-bar" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
          </div>
        )}
        {sending && (
          <button type="button" className="btn ghost danger" style={{ marginBottom: "1rem", border: "1px solid var(--danger)", background: "var(--bg-elevated)" }} onClick={stopSending}>
            Stop Sending
          </button>
        )}

        {visible.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>No contacts found matching your filters.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr>
                <th style={{ padding: "0.5rem 0.4rem" }}>
                  <input type="checkbox" checked={visible.length > 0 && selectedIds.size === visible.length} onChange={toggleSelectAllVisible} />
                </th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Contact</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Role &amp; title</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Match</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Email</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Source</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const tone = r.job_post_id ? matchScoreTone(r.match_score) : null;
                const postUrl = firstUrl(r.source_url);
                const emailStatus = r.status || "pending";
                return (
                  <tr
                    key={r.id}
                    onClick={() => setDetailRecipientId(r.id)}
                    style={{ borderTop: "1px solid var(--line)", cursor: "pointer" }}
                    className="jams-row"
                  >
                    <td style={{ padding: "0.5rem 0.4rem" }} onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedIds.has(r.id)} onChange={() => toggleSelected(r.id)} />
                    </td>
                    <td style={{ padding: "0.5rem 0.6rem" }}>
                      <div>{r.email || <span className="hint">No email</span>}</div>
                    </td>
                    <td style={{ padding: "0.5rem 0.6rem" }}>
                      <span className="chip">{roleLabel(roleDefs, r.role)}</span>
                      {r.title && <div className="hint" style={{ margin: "0.25rem 0 0" }}>{r.title}</div>}
                    </td>
                    <td style={{ padding: "0.5rem 0.6rem" }}>
                      {tone ? (
                        <span style={{ color: tone.color, fontWeight: 700, fontSize: "0.75rem" }}>{tone.label}</span>
                      ) : (
                        <span className="hint">—</span>
                      )}
                      {postUrl && (
                        <div>
                          <a
                            href={postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="msg"
                            style={{ color: "var(--accent)" }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            View post ↗
                          </a>
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem 0.6rem" }}>
                      <StatusPill status={r.status} />
                      {r.hasReplied && (
                        <span className="badge ok" style={{ marginLeft: "0.4rem", fontSize: "0.65rem" }} title="Replied to this outreach">
                          ↩ Replied{(r.replyCount || 0) > 1 ? ` (${r.replyCount})` : ""}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem 0.6rem" }}>
                      <span className="hint" style={{ margin: 0 }}>{r.source === "manual" ? "Manual" : "Auto-fetch"}</span>
                    </td>
                    <td style={{ padding: "0.5rem 0.6rem" }} onClick={(e) => e.stopPropagation()}>
                      {queuedIds.has(r.id) ? (
                        <span className="hint compact" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", color: "var(--accent)" }}>
                          <span className="spinner-dot" style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
                          Queued — sending soon…
                        </span>
                      ) : emailStatus !== "sent" ? (
                        <button type="button" className="btn ghost" style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }} disabled={sending} onClick={() => sendList([r], { force: false })}>
                          Send
                        </button>
                      ) : (
                        <button type="button" className="btn ghost" style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }} disabled={sending} onClick={() => sendList([r], { force: true })}>
                          Resend
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Pagination (2026-09-01, operator ask — "only 15 emails should be visible on one page"),
            replacing the old infinite-scroll-more mechanism. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem" }}>
          <p className="hint" style={{ margin: 0 }}>
            Showing {filtered.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length} ({recipients.length} total)
          </p>
          {totalPages > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <button type="button" className="btn ghost" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                ← Prev
              </button>
              <span className="hint compact" style={{ margin: 0 }}>Page {currentPage} of {totalPages}</span>
              <button type="button" className="btn ghost" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>
                Next →
              </button>
            </div>
          )}
        </div>
      </div>

      {detailRecipient && mounted && (
        <EmailDetailPanel
          recipient={detailRecipient}
          roleDefs={roleDefs}
          history={historyFor(detailRecipient)}
          replies={repliesFor(detailRecipient)}
          onClose={() => setDetailRecipientId(null)}
        />
      )}
    </div>
  );
}
