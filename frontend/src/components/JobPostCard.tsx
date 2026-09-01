"use client";

// JobPostCard itself (raw job-post text, AI match reasoning, phone-status dropdown) was dead code as of
// 2026-09-02 — grepped every JSX call site across src/ and found none; only StatusPill below is actually
// imported anywhere (by JamsTab.tsx and EmailDetailPanel.tsx). It's the leftover of an earlier "matched
// job posts" board on Jobs & Roles that architecture.md records as deleted outright once JamsTab absorbed
// that job. Removed rather than left as unused debt — it also carried the exact issues (raw post text
// instead of a summary, the AI's raw match-reasoning narration, a phone-status tracker) the operator had
// just had stripped from the Emails tab; keeping a dead copy of the same problems around served nothing.
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
