"use client";

import { useState } from "react";
import { roleLabel, type Recipient, type RoleDef } from "@/lib/types";
import { matchScoreTone, type JobPostGroup } from "@/lib/jobPosts";

export function StatusPill({ status }: { status?: string }) {
  const s = status || "pending";
  const color = s === "sent" ? "var(--ok)" : s === "failed" || s === "wrong_number" ? "var(--danger)" : "var(--warn)";
  const label = s === "sent" ? "Sent" : s === "failed" ? "Failed" : s === "wrong_number" ? "Wrong number" : "Pending";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", color, fontSize: "0.72rem", fontWeight: 600 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {label}
    </span>
  );
}

export function JobPostCard({
  group,
  roleDefs,
  onUpdateStatus,
  showRole = true,
}: {
  group: JobPostGroup;
  roleDefs: RoleDef[];
  onUpdateStatus?: (id: string, field: "status" | "phone_status", newStatus: string) => Promise<void>;
  // Jobs & Roles already scopes this list to one role's tab, so repeating the role chip on every card is
  // noise there — JamsTab (which can show posts across roles) keeps it.
  showRole?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const tone = matchScoreTone(group.matchScore);
  const snippet = group.contextText || "";
  const isLong = snippet.length > 220;
  const shown = expanded || !isLong ? snippet : snippet.slice(0, 220) + "…";

  return (
    <div className="template-card" style={{ gap: "0.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          {showRole && <span className="chip">{roleLabel(roleDefs, group.role)}</span>}
          {group.authorName && <span className="hint" style={{ margin: 0 }}>by {group.authorName}</span>}
        </div>
        <span style={{ fontSize: "0.72rem", fontWeight: 700, color: tone.color }}>{tone.label}</span>
      </div>

      {group.matchReasoning && (
        <p className="hint" style={{ margin: 0, fontStyle: "italic" }}>&ldquo;{group.matchReasoning}&rdquo;</p>
      )}

      {snippet ? (
        <div>
          <p style={{ margin: 0, fontSize: "0.78rem", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{shown}</p>
          {isLong && (
            <button type="button" className="file-name-btn" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      ) : (
        <p className="hint" style={{ margin: 0 }}>No text captured for this post.</p>
      )}

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        {group.sourceUrl && (
          <a href={group.sourceUrl} target="_blank" rel="noopener noreferrer" className="msg" style={{ color: "var(--accent)" }}>
            View post ↗
          </a>
        )}
        {group.scrapedAt && <span className="hint" style={{ margin: 0 }}>Scraped {new Date(group.scrapedAt).toLocaleDateString()}</span>}
      </div>

      <ul className="recipient-list" style={{ marginTop: "0.25rem" }}>
        {group.contacts.map((c) => (
          <li key={c.id} style={{ gridTemplateColumns: "1fr auto auto" }}>
            <span className="email">{c.email || c.phone || "—"}</span>
            <StatusPill status={c.status} />
            {c.phone && (
              <select
                value={c.phone_status || "pending"}
                onChange={(e) => onUpdateStatus?.(c.id, "phone_status", e.target.value)}
                style={{ fontSize: "0.68rem", padding: "0.15rem 0.3rem" }}
              >
                <option value="pending">Pending</option>
                <option value="sent">Msg Sent</option>
                <option value="wrong_number">Wrong Number</option>
              </select>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
