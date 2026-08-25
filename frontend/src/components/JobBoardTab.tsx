"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { supabase } from "@/lib/supabase";
import { loadApplicationsForCandidate, loadOpenJobPostings } from "@/lib/storage";
import { composeResumeData, matchRoleToPosting } from "@/lib/resumeCompose";
import type { CandidateProfile, JobApplication, JobPosting, ResumeEntry, ResumeProfile, Role, RoleDef } from "@/lib/types";

type Props = {
  userId: string;
  resumeProfiles: ResumeProfile[];
  resumes: Record<Role, ResumeEntry[]>;
  candidateProfile: CandidateProfile;
  roleDefs: RoleDef[];
  onSaveResumeProfile: (profile: Partial<ResumeProfile> & { id?: string }) => Promise<ResumeProfile | null>;
};

// Easy Apply (2026-08-19) reuses a real ResumeProfile, labeled distinctly so a repeat click on the same
// role updates it in place instead of piling up duplicates.
function easyApplyLabel(roleLabel: string) {
  return `${roleLabel} — Easy Apply`;
}

function formatSalary(p: JobPosting): string | null {
  if (!p.salaryMin && !p.salaryMax) return null;
  const range = p.salaryMin && p.salaryMax ? `${p.salaryMin}–${p.salaryMax}` : `${p.salaryMin || p.salaryMax}`;
  return `${p.salaryCurrency} ${range} / ${p.salaryPeriod}`;
}

// Candidate-facing "Job Board" (2026-08-19, recruiter portal) — browse job postings recruiters posted
// directly on Cuneihire and apply in-app (no outside portal, per the operator's original ask). Owns its
// own data fetch rather than living in page.tsx's PersistedState, since open postings are the first
// genuinely cross-user data in this app — not part of any one user's private saved state. See
// docs/architecture.md's "Recruiter portal" section.
export function JobBoardTab({ userId, resumeProfiles, resumes, candidateProfile, roleDefs, onSaveResumeProfile }: Props) {
  const [postings, setPostings] = useState<JobPosting[]>([]);
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [applyingTo, setApplyingTo] = useState<{ posting: JobPosting; resumeProfileId?: string; matchedRoleLabel?: string } | null>(null);
  const [composingFor, setComposingFor] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    Promise.all([loadOpenJobPostings(), loadApplicationsForCandidate(userId)]).then(([p, a]) => {
      setPostings(p);
      setApplications(a);
      setLoading(false);
    });
  }, [userId]);

  const appliedJobIds = useMemo(() => new Set(applications.map((a) => a.jobId)), [applications]);

  const allResumeFiles = useMemo(
    () => Object.values(resumes).flat(),
    [resumes]
  );

  function handleApplied(jobId: string, applicationId: string) {
    setApplications((prev) => [
      { id: applicationId, jobId, candidateId: userId, candidateName: "", candidateEmail: "", candidatePhone: "", coverNote: "", resumeData: null, status: "submitted", aiScore: null, aiReasoning: null, aiAnalyzedAt: null, createdAt: new Date().toISOString() },
      ...prev,
    ]);
    setApplyingTo(null);
  }

  // Easy Apply (2026-08-19) — composes then opens for review, never auto-submits silently (confirmed with
  // the operator). No AI call here: the module selection was already made on the Jobs & Roles page, so
  // assembly is deterministic (composeResumeData); the only "matching" is a cheap keyword-overlap pick of
  // which role this posting is for (matchRoleToPosting), skipped entirely when there's just one role.
  async function handleEasyApply(posting: JobPosting) {
    const matchedRole = matchRoleToPosting(roleDefs, posting);
    if (!matchedRole) {
      toast.error("Add a role on the Profile & Roles page first — Easy Apply composes a resume from it.");
      return;
    }
    setComposingFor(posting.id);
    try {
      const composed = composeResumeData(candidateProfile, matchedRole);
      const label = easyApplyLabel(matchedRole.label);
      const existing = resumeProfiles.find((p) => p.label === label);
      const saved = await onSaveResumeProfile({ id: existing?.id, label, templateId: "modern", data: composed });
      if (!saved) {
        toast.error("Failed to compose a resume for this role.");
        return;
      }
      setApplyingTo({ posting, resumeProfileId: saved.id, matchedRoleLabel: matchedRole.label });
    } finally {
      setComposingFor(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Job Board</h2>
        <span className="hint compact">Jobs recruiters posted directly on Cuneihire — apply in-app, no outside portal</span>
      </div>
      <div className="panel-body">
        {loading ? (
          <p className="hint">Loading postings…</p>
        ) : postings.length === 0 ? (
          <p className="hint">No open postings right now — check back later.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {postings.map((p) => {
              const expanded = expandedId === p.id;
              const applied = appliedJobIds.has(p.id);
              const salary = formatSalary(p);
              return (
                <li key={p.id} style={{ border: "1px solid var(--line)", borderRadius: "10px", padding: "0.75rem 1rem", background: "var(--bg-elevated)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                    <div>
                      <strong style={{ fontSize: "0.95rem" }}>{p.title}</strong>
                      <div className="hint compact" style={{ margin: "0.2rem 0 0" }}>
                        {p.company || "Company not specified"}{p.location ? ` · ${p.location}` : ""}
                      </div>
                      <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem", flexWrap: "wrap" }}>
                        <span className="chip">{p.employmentType}</span>
                        <span className="chip">{p.workMode}</span>
                        {salary && <span className="chip">{salary}</span>}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", alignItems: "flex-end" }}>
                      {applied ? (
                        <span className="badge ok">Applied ✓</span>
                      ) : (
                        <div style={{ display: "flex", gap: "0.4rem" }}>
                          <button
                            type="button"
                            className="btn primary"
                            onClick={() => handleEasyApply(p)}
                            disabled={composingFor === p.id}
                            title="Composes a resume from your matched role's selected modules, then opens it for review"
                          >
                            {composingFor === p.id ? "Composing…" : "⚡ Easy Apply"}
                          </button>
                          <button type="button" className="btn ghost" onClick={() => setApplyingTo({ posting: p })}>
                            Apply manually
                          </button>
                        </div>
                      )}
                      <button type="button" className="btn ghost" style={{ fontSize: "0.75rem" }} onClick={() => setExpandedId(expanded ? null : p.id)}>
                        {expanded ? "Hide details ▾" : "View details ▸"}
                      </button>
                    </div>
                  </div>
                  {expanded && (
                    <div style={{ marginTop: "0.6rem", paddingTop: "0.6rem", borderTop: "1px solid var(--line)", whiteSpace: "pre-wrap", fontSize: "0.85rem", color: "var(--fg)" }}>
                      {p.description}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {applyingTo && mounted && (
        <ApplyModal
          posting={applyingTo.posting}
          resumeProfiles={resumeProfiles}
          resumeFiles={allResumeFiles}
          initialResumeProfileId={applyingTo.resumeProfileId}
          matchedRoleLabel={applyingTo.matchedRoleLabel}
          onClose={() => setApplyingTo(null)}
          onApplied={handleApplied}
        />
      )}
    </section>
  );
}

function ApplyModal({
  posting,
  resumeProfiles,
  resumeFiles,
  initialResumeProfileId,
  matchedRoleLabel,
  onClose,
  onApplied,
}: {
  posting: JobPosting;
  resumeProfiles: ResumeProfile[];
  resumeFiles: ResumeEntry[];
  initialResumeProfileId?: string;
  matchedRoleLabel?: string;
  onClose: () => void;
  onApplied: (jobId: string, applicationId: string) => void;
}) {
  const [resumeProfileId, setResumeProfileId] = useState(initialResumeProfileId || resumeProfiles[0]?.id || "");
  const [resumeEntryId, setResumeEntryId] = useState("");
  const [coverNote, setCoverNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!resumeProfileId && !resumeEntryId) {
      toast.error("Attach a built resume or a resume file to apply.");
      return;
    }
    setSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/jobs/apply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          jobId: posting.id,
          resumeProfileId: resumeProfileId || undefined,
          resumeEntryId: resumeEntryId || undefined,
          coverNote,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.error || "Failed to submit application.");
        return;
      }
      toast.success(
        data.aiScore != null ? `Applied! AI-ATS match score: ${data.aiScore}` : "Applied!"
      );
      onApplied(posting.id, data.applicationId);
    } catch {
      toast.error("Network error while applying.");
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onClose} style={{ zIndex: 99999 }}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Apply — {posting.title}</h2>
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
          {matchedRoleLabel && (
            <p className="hint compact" style={{ margin: 0 }}>
              ⚡ Using your <strong>&quot;{matchedRoleLabel}&quot;</strong> profile — composed from that
              role&apos;s selected modules. Review below, edit further in the Resume Builder if needed, or
              just submit.
            </p>
          )}
          <label className="field">
            <span>Built resume (from Resume Builder)</span>
            <select value={resumeProfileId} onChange={(e) => setResumeProfileId(e.target.value)}>
              <option value="">— None —</option>
              {resumeProfiles.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Resume file (from your library)</span>
            <select value={resumeEntryId} onChange={(e) => setResumeEntryId(e.target.value)}>
              <option value="">— None —</option>
              {resumeFiles.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </label>
          <p className="hint compact">
            Attach at least one. Only a built resume can be read by the recruiter&apos;s AI-ATS — a file-only
            application still gets seen by the recruiter, just not automatically scored.
          </p>
          <label className="field">
            <span>Cover note (optional)</span>
            <textarea rows={4} value={coverNote} onChange={(e) => setCoverNote(e.target.value)} placeholder="A short note to the recruiter…" />
          </label>
          <button type="button" className="btn primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Submitting…" : "Submit Application"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
