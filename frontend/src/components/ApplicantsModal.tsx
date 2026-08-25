"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { supabase } from "@/lib/supabase";
import { loadApplicationsForPosting, updateApplicationStatus } from "@/lib/storage";
import { matchScoreTone } from "@/lib/jobPosts";
import type { JobApplication, JobPosting } from "@/lib/types";

type Props = {
  posting: JobPosting;
  onClose: () => void;
};

const STATUS_OPTIONS: JobApplication["status"][] = ["submitted", "shortlisted", "rejected"];

// Per-posting applicant review (2026-08-19, recruiter portal) — resume, cover note, AI-ATS score when
// available, status control, and a manual "Score with AI" for anything the automatic on-apply scoring in
// /api/jobs/apply couldn't reach (AI-ATS enabled after the fact, or re-scoring). See
// docs/architecture.md's "Recruiter portal" section.
export function ApplicantsModal({ posting, onClose }: Props) {
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [scoringId, setScoringId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    loadApplicationsForPosting(posting.id).then((apps) => {
      setApplications(apps);
      setLoading(false);
    });
  }, [posting.id]);

  async function handleStatusChange(app: JobApplication, status: JobApplication["status"]) {
    setApplications((prev) => prev.map((a) => (a.id === app.id ? { ...a, status } : a)));
    try {
      await updateApplicationStatus(app.id, status);
    } catch {
      toast.error("Failed to update status.");
    }
  }

  async function handleScoreWithAi(app: JobApplication) {
    setScoringId(app.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/jobs/score-application", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ applicationId: app.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.error || "Failed to score with AI.");
        return;
      }
      setApplications((prev) =>
        prev.map((a) => (a.id === app.id ? { ...a, aiScore: data.aiScore, aiReasoning: data.aiReasoning, aiAnalyzedAt: new Date().toISOString() } : a))
      );
      toast.success(`Scored: ${data.aiScore}`);
    } catch {
      toast.error("Network error while scoring.");
    } finally {
      setScoringId(null);
    }
  }

  if (!mounted) return null;

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onClose} style={{ zIndex: 99999 }}>
      <div className="modal-card" role="dialog" aria-modal="true" style={{ width: "min(680px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Applicants — {posting.title}</h2>
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body" style={{ maxHeight: "65vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {loading ? (
            <p className="hint">Loading applicants…</p>
          ) : applications.length === 0 ? (
            <p className="hint">No applications yet.</p>
          ) : (
            applications.map((app) => {
              const tone = matchScoreTone(app.aiScore);
              return (
                <div key={app.id} style={{ border: "1px solid var(--line)", borderRadius: "8px", padding: "0.6rem 0.75rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.6rem", flexWrap: "wrap" }}>
                    <div>
                      <strong>{app.candidateName || "Unnamed candidate"}</strong>
                      <div className="hint compact">{app.candidateEmail}{app.candidatePhone ? ` · ${app.candidatePhone}` : ""}</div>
                    </div>
                    <select
                      value={app.status}
                      onChange={(e) => handleStatusChange(app, e.target.value as JobApplication["status"])}
                      style={{ fontSize: "0.75rem", padding: "0.15rem 0.3rem" }}
                    >
                      {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>

                  <div style={{ marginTop: "0.4rem", fontSize: "0.8rem" }}>
                    {app.resumeFileUrl && (
                      <a href={app.resumeFileUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                        {app.resumeFileName || "Resume file"} ↗
                      </a>
                    )}
                    {app.resumeData && (
                      <span className="hint compact">
                        {app.resumeFileUrl ? " · " : ""}Built resume attached
                      </span>
                    )}
                  </div>

                  {app.coverNote && (
                    <div style={{ marginTop: "0.4rem", fontSize: "0.8rem", whiteSpace: "pre-wrap", color: "var(--fg)" }}>
                      {app.coverNote}
                    </div>
                  )}

                  <div style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    {app.aiAnalyzedAt ? (
                      <span style={{ color: tone.color, fontWeight: 700, fontSize: "0.78rem" }}>AI-ATS: {tone.label}</span>
                    ) : (
                      <span className="hint compact">Not scored yet</span>
                    )}
                    {!app.aiAnalyzedAt && app.resumeData && (
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}
                        disabled={scoringId === app.id}
                        onClick={() => handleScoreWithAi(app)}
                      >
                        {scoringId === app.id ? "Scoring…" : "Score with AI"}
                      </button>
                    )}
                  </div>
                  {app.aiReasoning && (
                    <div className="hint compact" style={{ marginTop: "0.25rem" }}>{app.aiReasoning}</div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
