"use client";

import { useState } from "react";
import { roleLabel, type Recipient, type ReplyRecord, type RoleDef, type SentRecord, type SmtpAccount } from "@/lib/types";
import { ResponseDetailPanel } from "./ResponseDetailPanel";

const PAGE_SIZE = 15;

type Props = {
  replies: ReplyRecord[];
  recipients: Recipient[];
  roleDefs: RoleDef[];
  sentLog: SentRecord[];
  smtpAccounts: SmtpAccount[];
  userId: string | null;
  // Deep-link from the new-reply toast (2026-09-02) — see JamsHub.tsx's matching Props comment. Wins over
  // detailReplyId at render time until cleared; never synced into local state via an effect.
  pendingReplyFocus?: string | null;
  onClearPendingReplyFocus?: () => void;
};

// "Responses" (2026-09-01, renamed from "Monitoring" — see docs/architecture.md; reworked same day into a
// clickable table + detail panel, mirroring the Emails tab's own shape per the operator's explicit ask:
// "this whole thing will look similar to the email section... we will see the same emails that we sent but
// it will focus more on the responses that we get... we click the same way clickable"). Rows are replies,
// not contacts — each one opens ResponseDetailPanel.tsx, which also lets you send a manual reply back
// through the SMTP account that received it. Shows nothing when there are no replies, deliberately — no
// job-run/algorithm noise, per the operator's original "if there are no replies there will be nothing to
// be shown here."
export function ResponsesTab({ replies, recipients, roleDefs, sentLog, smtpAccounts, userId, pendingReplyFocus, onClearPendingReplyFocus }: Props) {
  const [page, setPage] = useState(1);
  // No SSR-safety "mounted" guard needed before rendering the createPortal-based detail panel below (a
  // pattern used elsewhere in this codebase) — `detailReplyId` can only ever become non-null from a user
  // click, which can't happen before the DOM (and `document.body`) already exists, so there's no window
  // where this would try to portal before it's safe to.
  const [detailReplyId, setDetailReplyId] = useState<string | null>(null);

  const sorted = [...replies].sort(
    (a, b) => new Date(b.receivedAt || 0).getTime() - new Date(a.receivedAt || 0).getTime()
  );
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  // A pending focus (from the new-reply toast) always wins over whatever row was locally clicked, until
  // it's cleared — see the Props comment above.
  const effectiveDetailReplyId = pendingReplyFocus ?? detailReplyId;
  const detailReply = effectiveDetailReplyId ? replies.find((r) => r.id === effectiveDetailReplyId) || null : null;

  function contextFor(rep: ReplyRecord) {
    const recipient = recipients.find((r) => r.id === rep.recipientId);
    if (!recipient) return null;
    return { role: roleLabel(roleDefs, recipient.role), title: recipient.title };
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Responses</h2>
          <p className="hint compact" style={{ margin: '0.2rem 0 0' }}>Replies you&apos;ve received — nothing else.</p>
        </div>
      </div>
      <div className="panel-body">
        {sorted.length === 0 ? (
          <p className="hint" style={{ textAlign: 'center', margin: '2rem 0' }}>
            No replies yet. They&apos;ll show up here as soon as someone responds to one of your emails.
          </p>
        ) : (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>From</th>
                  <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Role &amp; title</th>
                  <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Message</th>
                  <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", color: "var(--muted)", fontWeight: 600 }}>Received</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((rep) => {
                  const context = contextFor(rep);
                  return (
                    <tr
                      key={rep.id}
                      onClick={() => { setDetailReplyId(rep.id); onClearPendingReplyFocus?.(); }}
                      style={{ borderTop: "1px solid var(--line)", cursor: "pointer" }}
                      className="jams-row"
                    >
                      <td style={{ padding: "0.5rem 0.6rem" }}>↩ {rep.fromEmail}</td>
                      <td style={{ padding: "0.5rem 0.6rem" }}>
                        {context ? (
                          <>
                            <span className="chip">{context.role}</span>
                            {context.title && <div className="hint" style={{ margin: "0.25rem 0 0" }}>{context.title}</div>}
                          </>
                        ) : (
                          <span className="hint">—</span>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem 0.6rem", maxWidth: "320px" }}>
                        {rep.subject && <div style={{ fontWeight: 500 }}>{rep.subject}</div>}
                        {rep.bodySnippet && (
                          <div className="hint" style={{ margin: "0.2rem 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {rep.bodySnippet}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem 0.6rem" }}>
                        <span className="hint" style={{ margin: 0 }}>{rep.receivedAt ? new Date(rep.receivedAt).toLocaleString() : "—"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem' }}>
              <p className="hint" style={{ margin: 0 }}>
                Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, sorted.length)} of {sorted.length}
              </p>
              {totalPages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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
          </>
        )}
      </div>

      {detailReply && (
        <ResponseDetailPanel
          reply={detailReply}
          recipients={recipients}
          roleDefs={roleDefs}
          sentLog={sentLog}
          replies={replies}
          smtpAccounts={smtpAccounts}
          userId={userId}
          onClose={() => { setDetailReplyId(null); onClearPendingReplyFocus?.(); }}
        />
      )}
    </section>
  );
}
