"use client";

import { RESUME_SOURCE_LABELS, resumeSource } from "@/lib/resumeNaming";
import type { Attachment } from "@/lib/types";

// A small pill naming where a Library entry came from (2026-08-25, operator ask — "I should be able to
// figure out the resume source"). Plain neutral `.badge` (not `.badge ok`/`.badge warn`) — this is
// informational, not a status. Kept as its own component since ResumeConfigTab.tsx needs it inline next to
// the existing "Default" badge, and any future Library-style listing can reuse it the same way.
export function ResumeSourceBadge({ file }: { file: Attachment }) {
  return (
    <span className="badge" style={{ marginLeft: "0.4rem", fontSize: "0.62rem" }}>
      {RESUME_SOURCE_LABELS[resumeSource(file)]}
    </span>
  );
}
