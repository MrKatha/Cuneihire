// Attachment resolution for a role's sends. Used by both automail.worker.js and batchSend.worker.js.
//
// The hierarchy: one resume per role. A role's own `resume_id` wins if set; otherwise it inherits the
// candidate's `global_resume_id`; otherwise there's no resume at all. Both are just Attachment.id
// pointers into the same shared pool (`profile.global_files`) — not a separate storage mechanism, not a
// real FK (an id into a jsonb array has no table row to reference), same "unknown isn't a fail" tolerance
// as everywhere else in this project: a stale/deleted id resolves to nothing, never a guess or a crash.
//
// "Additional files" (a role attaching extra pool files alongside its resume, via `selected_file_ids`)
// was removed 2026-08-20 per operator ask — a role's send now attaches its resume only. `selected_file_ids`
// stays on the schema/RoleDef type, unread (same "superseded, never dropped" precedent as every other
// retired column in this project), in case it's wanted again later.
//
// Both `roleDef` and `profile` are raw Supabase rows (snake_case columns), not the frontend's mapped
// camelCase types — these workers deal in raw rows throughout. `profile.global_files` is the repurposed
// column holding the candidate's whole files pool (see storage.ts's mapCandidateProfileRow).

// This role's one resume — its own override if set, else the candidate's global default, else null.
function resolveRoleResume(roleDef, profile) {
  const allFiles = (profile && Array.isArray(profile.global_files)) ? profile.global_files : [];
  const effectiveId = (roleDef && roleDef.resume_id) || (profile && profile.global_resume_id) || null;
  if (!effectiveId) return null;
  return allFiles.find((f) => f && f.id === effectiveId) || null;
}

// The list that actually goes on the email — just the resume, if there is one. Kept as a small wrapper
// (rather than inlining `resolveRoleResume` at every call site) so callers reading `.all` didn't need to
// change when "additional files" was removed.
function resolveRoleAttachments(roleDef, profile) {
  const resume = resolveRoleResume(roleDef, profile);
  return { resume, all: resume ? [resume] : [] };
}

// A short, human-readable label for sent_log's resume_label column — same "snapshot of what was true at
// send time" reasoning the field already had. Fed the combined `all` list.
function describeFiles(files) {
  if (!files || files.length === 0) return null;
  return files.map((f) => f.name).join(", ");
}

module.exports = { resolveRoleResume, resolveRoleAttachments, describeFiles };
