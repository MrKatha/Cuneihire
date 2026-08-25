// Frontend mirror of backend/src/lib/emailResolve.js — deliberately duplicated across the two deployables,
// same reasoning as crypto.ts/crypto.js and placeholders.ts/ai.service.js. KEEP IN SYNC. Needed here
// because QuickSendModal.tsx resolves its own attachments client-side (it sends synchronously via
// /api/send, not through a backend worker). Operates on the frontend's mapped camelCase types.
//
// One resume per role (2026-08-20) — a role's own `resumeId` wins if set; otherwise it inherits the
// candidate's `globalResumeId`; otherwise there's no resume at all.
//
// "Additional files" (a role attaching extra pool files alongside its resume, via `selectedFileIds`) was
// removed 2026-08-20 per operator ask — a role's send now attaches its resume only. `selectedFileIds`
// stays on the RoleDef type/schema, unread (same "superseded, never dropped" precedent as every other
// retired field in this project), in case it's wanted again later.
import type { Attachment, CandidateProfile, RoleDef } from "@/lib/types";

// This role's one resume — its own override if set, else the candidate's global default, else null. A
// stale/unknown id resolves to null (unknown isn't a fail), never a guess or a crash.
export function resolveRoleResume(roleDef: RoleDef | null, profile: CandidateProfile): Attachment | null {
  const effectiveId = roleDef?.resumeId || profile.globalResumeId || null;
  if (!effectiveId) return null;
  return profile.files.find((f) => f.id === effectiveId) || null;
}

// The list that actually goes on the email — just the resume, if there is one. Kept as a small wrapper
// (rather than inlining resolveRoleResume at every call site) so callers reading `.all` didn't need to
// change when "additional files" was removed.
export function resolveRoleAttachments(
  roleDef: RoleDef | null,
  profile: CandidateProfile
): { resume: Attachment | null; all: Attachment[] } {
  const resume = resolveRoleResume(roleDef, profile);
  return { resume, all: resume ? [resume] : [] };
}

// A short, human-readable label for SentRecord.resumeLabel — same "snapshot of what was true at send
// time" reasoning the field already had. Fed the combined `all` list.
export function describeFiles(files: Attachment[]): string | undefined {
  if (!files || files.length === 0) return undefined;
  return files.map((f) => f.name).join(", ");
}
