"use client";

import { useState } from "react";
import { roleLabel, type Recipient, type ReplyRecord, type RoleDef } from "@/lib/types";

const PAGE_SIZE = 15;

type Props = {
  replies: ReplyRecord[];
  recipients: Recipient[];
  roleDefs: RoleDef[];
};

// "Responses" (2026-09-01, renamed from "Monitoring" — see docs/architecture.md). Operator, verbatim:
// "the user does not need to know that we are checking 110 messages each time just to check the reply...
// he will only care about the replies that he will get... rename this to the responses and only show the
// responses that we get... this doesn't concern the user." The old tab (ExecutionLogsPanel) showed every
// background job run — scraper searches, send batches, reply-checks themselves — none of which the
// candidate asked to see. This tab shows exactly one thing: replies that actually arrived. Nothing here
// when there are none, deliberately — no "we checked and found nothing" noise.
export function ResponsesTab({ replies, recipients, roleDefs }: Props) {
  const [page, setPage] = useState(1);
  const sorted = [...replies].sort(
    (a, b) => new Date(b.receivedAt || 0).getTime() - new Date(a.receivedAt || 0).getTime()
  );
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {visible.map((rep) => {
                const context = contextFor(rep);
                return (
                  <div key={rep.id} style={{ border: '1px solid var(--line)', borderRadius: '10px', padding: '0.65rem 0.8rem', background: 'var(--bg-elevated)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>↩ {rep.fromEmail}</span>
                        {context && (
                          <span className="hint compact" style={{ marginLeft: '0.5rem' }}>
                            re: {context.role}{context.title ? ` — ${context.title}` : ""}
                          </span>
                        )}
                      </div>
                      {rep.receivedAt && <span className="hint compact" style={{ margin: 0, flexShrink: 0 }}>{new Date(rep.receivedAt).toLocaleString()}</span>}
                    </div>
                    {rep.subject && <div style={{ marginTop: '0.3rem', fontSize: '0.82rem', fontWeight: 500 }}>{rep.subject}</div>}
                    {rep.bodySnippet && (
                      <div style={{ marginTop: '0.25rem', fontSize: '0.8rem', color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>
                        {rep.bodySnippet}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

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
    </section>
  );
}
