// Shared resume-name uniqueness helpers (2026-08-20) — every Attachment.name in a candidate's Library must
// stay unique, so nothing (a human picking which to send, or a background worker resolving one
// automatically) can ever grab the wrong resume by name collision. Case-insensitive, trimmed compare —
// "Sohaib — Automation" and "sohaib — automation " count as the same name.
//
// The candidate-facing paths (ResumeBuilder.tsx's Save/Sync flows, ResumeConfigTab.tsx's upload/rename)
// all use isNameTaken to BLOCK and ask for a different name rather than silently renaming — operator ask
// (2026-08-20): "it's better not to have the same names... block and ask me to rename." uniqueNameFallback
// is the one deliberate exception, used only where there's no UI moment to ask at all (ResumeBuilder.tsx's
// zero-click auto-generated default resume, created silently the first time a role with no resolvable
// resume is opened in Builder).
import type { Attachment } from "@/lib/types";

export function isNameTaken(name: string, files: Attachment[], excludeId?: string): boolean {
  const t = name.trim().toLowerCase();
  if (!t) return false;
  return files.some((f) => f.id !== excludeId && f.name.trim().toLowerCase() === t);
}

export function uniqueNameFallback(base: string, files: Attachment[]): string {
  if (!isNameTaken(base, files)) return base;
  let n = 2;
  while (isNameTaken(`${base} (${n})`, files)) n++;
  return `${base} (${n})`;
}
