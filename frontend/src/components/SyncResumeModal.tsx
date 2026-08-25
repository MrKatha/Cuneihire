"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ResumeSyncDiff } from "@/lib/resumeSync";

type Props = {
  diff: ResumeSyncDiff;
  roleLabel: string;
  defaultSyncName: string;
  isNameTaken: (name: string) => boolean;
  onSaveToProfile: (name: string) => void;
  onSaveThisOnly: (name: string) => void;
  onCancel: () => void;
};

function line(count: number, singular: string, plural = `${singular}s`): string | null {
  if (count === 0) return null;
  return `${count} new ${count === 1 ? singular : plural}`;
}

function changedLine(count: number, singular: string, plural = `${singular}s`): string | null {
  if (count === 0) return null;
  return `${count} ${count === 1 ? singular : plural} edited`;
}

// "Save to Profile & Role" or "Just this resume"? (2026-08-20, Resume Builder redesign) — shown from
// ResumeBuilder.tsx's Save flow only when diffResumeAgainstProfile found something worth asking about.
// Same modal conventions as AddProfileItemModal.tsx (.modal-backdrop/.modal-card/.modal-head/.modal-body).
//
// Both choices now always create a brand-new, separately named Library entry (2026-08-20, same-day
// follow-up, operator ask — "then it will create another instance, the resume in the library will stay as
// it is") — neither one silently overwrites what was already there. "Just this resume" always reveals a
// name step (unchanged). "Save to Profile & Role" reuses ResumeBuilder.tsx's current "Resume name" field
// value with no extra step in the common case, but reveals the same kind of name step if that name is
// already taken (operator ask — "block and ask me to rename," never a silent auto-rename) — isNameTaken is
// the caller's single source of truth for what counts as a collision (see lib/resumeNaming.ts).
export function SyncResumeModal({ diff, roleLabel, defaultSyncName, isNameTaken, onSaveToProfile, onSaveThisOnly, onCancel }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [step, setStep] = useState<"choice" | "name-sync" | "name-local">("choice");
  const [syncName, setSyncName] = useState(defaultSyncName);
  const [localName, setLocalName] = useState(`${roleLabel} (edited copy)`);
  const [error, setError] = useState<string | null>(null);
  if (!mounted) return null;

  const changeLines = [
    line(diff.newExperience.length, "experience entry", "experience entries"),
    changedLine(diff.changedExperience.length, "experience entry", "experience entries"),
    line(diff.newEducation.length, "education entry", "education entries"),
    changedLine(diff.changedEducation.length, "education entry", "education entries"),
    line(diff.newProjects.length, "project"),
    changedLine(diff.changedProjects.length, "project"),
    line(diff.newCertifications.length, "certification"),
    changedLine(diff.changedCertifications.length, "certification"),
    diff.newSkillNames.length > 0 ? `${diff.newSkillNames.length} new skill${diff.newSkillNames.length === 1 ? "" : "s"}: ${diff.newSkillNames.join(", ")}` : null,
    diff.summaryChanged ? "Summary updated" : null,
    diff.identityChanged ? "Contact info updated" : null,
  ].filter((l): l is string => l !== null);

  function confirmSync() {
    const trimmed = syncName.trim();
    if (!trimmed) { setError("Give this resume a name."); return; }
    if (isNameTaken(trimmed)) { setError(`"${trimmed}" is already used by another resume in your Library — pick a different name.`); return; }
    onSaveToProfile(trimmed);
  }
  function confirmLocal() {
    const trimmed = localName.trim();
    if (!trimmed) { setError("Give this resume a name."); return; }
    if (isNameTaken(trimmed)) { setError(`"${trimmed}" is already used by another resume in your Library — pick a different name.`); return; }
    onSaveThisOnly(trimmed);
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onCancel} style={{ zIndex: 99999 }}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Save this resume</h2>
          <button type="button" className="btn ghost" onClick={onCancel}>Close</button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
          <p className="hint compact">
            You&apos;ve changed things that started from your profile — {changeLines.join(", ")}.
          </p>
          <p className="hint compact">
            Save these to your <strong>Profile &amp; {roleLabel}</strong> too (so every other resume/role
            picks them up), or keep them local to just this one resume? Either way this becomes a new entry
            in your Library — nothing already there gets overwritten.
          </p>
          {step === "choice" && (
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  if (isNameTaken(defaultSyncName.trim())) {
                    setSyncName(defaultSyncName);
                    setError(`"${defaultSyncName.trim()}" is already used by another resume in your Library — pick a different name.`);
                    setStep("name-sync");
                  } else {
                    onSaveToProfile(defaultSyncName.trim());
                  }
                }}
              >
                Save to Profile &amp; Role
              </button>
              <button type="button" className="btn ghost" onClick={() => { setError(null); setStep("name-local"); }}>Just this resume</button>
            </div>
          )}
          {step !== "choice" && (
            <>
              <label className="field" style={{ maxWidth: "360px", margin: 0 }}>
                <span>Name for this resume</span>
                <input
                  type="text"
                  value={step === "name-sync" ? syncName : localName}
                  onChange={(e) => {
                    setError(null);
                    if (step === "name-sync") setSyncName(e.target.value);
                    else setLocalName(e.target.value);
                  }}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    if (step === "name-sync") confirmSync(); else confirmLocal();
                  }}
                />
              </label>
              {error && <p className="hint compact" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button type="button" className="btn primary" onClick={step === "name-sync" ? confirmSync : confirmLocal}>
                  {step === "name-sync" ? "Save to Profile & Role" : "Save to Library"}
                </button>
                <button type="button" className="btn ghost" onClick={() => { setError(null); setStep("choice"); }}>Back</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
