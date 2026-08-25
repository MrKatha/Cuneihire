"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { AttachmentPreviewModal } from "./AttachmentPreviewModal";
import { type Attachment, type CandidateProfile } from "@/lib/types";
import { deleteAttachment, uploadAttachment } from "@/lib/storage";
import { isNameTaken } from "@/lib/resumeNaming";

type Props = {
  userId: string | null;
  profile: CandidateProfile;
  onProfileChange: (profile: CandidateProfile) => void;
};

// "Everything related to the resume lives in the Resume tab" (2026-08-20) — the candidate's file pool and
// per-role attachment selection live here, as this tab's "Configuration" sub-tab (see page.tsx).
//
// One resume per role, with a global default (2026-08-20, same-day follow-up) — the previous design let a
// role select any number of resume-shaped files with no distinction from a portfolio file ("how many
// times can you possibly build one resume for one role?"). Now: CandidateProfile.globalResumeId is the
// hierarchy's top, a role inherits it automatically (RoleDef.resumeId === null) unless it sets its own
// override. See docs/architecture.md's "Email Templates redesign" section's newest follow-up.
//
// Trimmed down to candidate-level only (2026-08-20, Resume Builder redesign) — all per-role resume
// authoring (build from profile / start from scratch) moved to the Resumes → Builder tab's role-tabbed
// view (ResumeBuilder.tsx), which is now the one place a role's resume is set.
//
// "Additional files" removed (2026-08-20, operator ask) — a role no longer attaches anything alongside
// its resume; RoleDef.selectedFileIds is retired, unread (same "superseded, never dropped" precedent as
// every other retired field in this project).
//
// Renamed Configuration → "Library" (2026-08-20, same-day follow-up, operator ask) — once per-role
// authoring moved to Builder, this sub-tab only ever did one thing: the resume/file library, and picking
// which one is the default. "Library" names that; "Configuration" didn't. Component/file name unchanged
// (same "rename the label, not the file" precedent as JobsRolesTab.tsx).
//
// Simplified again same day (2026-08-20, operator ask — "that's it, simple") — the "Generate from Resume
// Builder…" dropdown is gone (a resume you build now always goes through Builder's own Save/"Use as
// resume" flow, which already adds it here; a second parallel path to the same result was the confusion),
// and so is "🔄 Regenerate" (nobody could tell what it did). "Upload a file" is the one plain upload
// action. Every list row is now the resume itself: a radio marks the one candidate-wide default (replacing
// the standalone picker card below), and the name is inline-editable — the same field a role's own
// "Resume name" writes to from Builder — since the name is literally the filename recipients see
// (Attachment.name === nodemailer's `filename`, confirmed in automail.worker.js/batchSend.worker.js).
//
// Names must stay unique across the whole Library (2026-08-20, same-day follow-up, operator ask — "it's
// better not to have the same names... block and ask me to rename") — uploading or renaming to a name
// that's already in use is blocked with an inline error instead of silently applying, same guard
// ResumeBuilder.tsx's Save/Sync flows use (see lib/resumeNaming.ts's isNameTaken).
export function ResumeConfigTab({ userId, profile, onProfileChange }: Props) {
  const [previewFile, setPreviewFile] = useState<Attachment | null>(null);
  const [fileUploading, setFileUploading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Blocks, doesn't silently rename (2026-08-20, operator ask — "it's better not to have the same names...
  // block and ask me to rename," so nothing ever grabs the wrong resume by name collision). Shared with
  // ResumeBuilder.tsx's Save/Sync flows via lib/resumeNaming.ts.
  const [nameError, setNameError] = useState<string | null>(null);

  async function handleUploadFile(file: File) {
    if (!userId) return;
    if (isNameTaken(file.name, profile.files)) {
      setNameError(`"${file.name}" is already used by another resume in your Library — rename the file and try again.`);
      return;
    }
    setNameError(null);
    setFileUploading(true);
    try {
      const attachment = await uploadAttachment(file, userId);
      onProfileChange({ ...profile, files: [...profile.files, attachment] });
      toast.success("File added.");
    } catch {
      toast.error("Failed to upload file.");
    } finally {
      setFileUploading(false);
    }
  }

  function handleRemoveFile(index: number, storagePath: string) {
    deleteAttachment(storagePath).catch(console.error);
    onProfileChange({ ...profile, files: profile.files.filter((_, i) => i !== index) });
  }

  function setAsDefault(id: string) {
    onProfileChange({ ...profile, globalResumeId: id });
  }

  function startRename(f: Attachment) {
    setNameError(null);
    setRenamingId(f.id);
    setRenameValue(f.name);
  }
  function commitRename() {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) { setRenamingId(null); return; }
    if (isNameTaken(trimmed, profile.files, renamingId)) {
      setNameError(`"${trimmed}" is already used by another resume in your Library — pick a different name.`);
      return; // keep editing open so the name can be fixed
    }
    setNameError(null);
    onProfileChange({ ...profile, files: profile.files.map((f) => (f.id === renamingId ? { ...f, name: trimmed } : f)) });
    setRenamingId(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <div className="template-card single">
        <div className="template-head">
          <h3>Your Resume Library</h3>
        </div>
        <p className="hint compact" style={{ margin: "0 0 0.6rem" }}>
          Every resume/file you&apos;ve got. Build one on the <strong>From your profile</strong> or{" "}
          <strong>Start from scratch</strong> tab, or upload one directly below. Mark one as your default —
          every role uses it automatically unless it builds its own.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.6rem" }}>
          <label className="btn attach-add">
            {fileUploading ? "Uploading..." : "Upload your own resume"}
            <input
              type="file"
              className="sr-only"
              disabled={fileUploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUploadFile(file);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {nameError && <p className="hint compact" style={{ color: "var(--danger)", marginBottom: "0.6rem" }}>{nameError}</p>}

        {profile.files.length === 0 ? (
          <p className="hint compact">No files yet — upload a resume, or build one on the From your profile / Start from scratch tab.</p>
        ) : (
          <ul className="file-list tall">
            {profile.files.map((f, index) => (
              <li key={f.id} title={f.name}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", flex: 1, minWidth: 0 }}>
                  <input
                    type="radio"
                    name="globalDefaultResume"
                    checked={f.id === profile.globalResumeId}
                    onChange={() => setAsDefault(f.id)}
                    title="Use as your default resume"
                  />
                  {renamingId === f.id ? (
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => { setNameError(null); setRenameValue(e.target.value); }}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      autoFocus
                      style={{ fontSize: "0.72rem", flex: 1, minWidth: 0 }}
                    />
                  ) : (
                    <button type="button" className="file-name-btn" onClick={() => startRename(f)} title="Click to rename">
                      {f.name}
                      {f.id === profile.globalResumeId && <span className="badge ok" style={{ marginLeft: "0.4rem", fontSize: "0.62rem" }}>Default</span>}
                    </button>
                  )}
                </label>
                <span className="file-actions">
                  <button type="button" className="btn ghost" onClick={() => setPreviewFile(f)}>Preview</button>
                  <button type="button" className="btn ghost danger" onClick={() => handleRemoveFile(index, f.storagePath)}>×</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {previewFile && <AttachmentPreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
    </div>
  );
}
