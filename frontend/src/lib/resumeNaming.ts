// Shared resume-name uniqueness helpers (2026-08-20) — every Attachment.name in a candidate's Library must
// stay unique WITHIN its own source category (2026-08-25, operator ask — "in one category there should not
// be two resumes that have the same name," scoped per category rather than across the whole Library, so a
// candidate can e.g. upload a file called "Sohaib — Resume" and separately build a from-scratch resume with
// the same name without a collision). Case-insensitive, trimmed compare — "Sohaib — Automation" and "sohaib
// — automation " count as the same name.
//
// The candidate-facing paths (ResumeBuilder.tsx's Save/Sync flows, ResumeConfigTab.tsx's upload/rename)
// all use isNameTaken to BLOCK and ask for a different name rather than silently renaming — operator ask
// (2026-08-20): "it's better not to have the same names... block and ask me to rename." uniqueNameFallback
// is the one deliberate exception, used only where there's no UI moment to ask at all (ResumeBuilder.tsx's
// zero-click auto-generated default resume, created silently the first time a role with no resolvable
// resume is opened in Builder).
import type { Attachment } from "@/lib/types";

// A resume's origin, derived from which of Attachment's two source-tag fields (if either) is set — never
// stored as its own field, so it can't drift out of sync with the fields that actually drive behavior
// elsewhere (regenerate-from-source, refresh-from-profile, etc.).
//  - "upload": neither tag set — a file added directly via ResumeConfigTab's "Upload your own resume".
//  - "scratch": sourceResumeProfileId set — generated from a "Start from scratch" ResumeProfile.
//  - "profile": sourceRoleId set — composed live from the candidate profile + a role's module selection
//    ("From your profile" mode); each save creates its own named instance, so a candidate can have several
//    of these, one per role save, all under this one source.
export type ResumeSource = "upload" | "scratch" | "profile";

export const RESUME_SOURCE_LABELS: Record<ResumeSource, string> = {
  upload: "Uploaded by me",
  scratch: "Created from scratch",
  profile: "Based on your profile",
};

export function resumeSource(f: Attachment): ResumeSource {
  if (f.sourceResumeProfileId) return "scratch";
  if (f.sourceRoleId) return "profile";
  return "upload";
}

export function isNameTaken(name: string, files: Attachment[], source: ResumeSource, excludeId?: string): boolean {
  const t = name.trim().toLowerCase();
  if (!t) return false;
  return files.some((f) => f.id !== excludeId && resumeSource(f) === source && f.name.trim().toLowerCase() === t);
}

export function uniqueNameFallback(base: string, files: Attachment[], source: ResumeSource): string {
  if (!isNameTaken(base, files, source)) return base;
  let n = 2;
  while (isNameTaken(`${base} (${n})`, files, source)) n++;
  return `${base} (${n})`;
}
