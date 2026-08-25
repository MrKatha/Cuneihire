"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import {
  SALARY_CURRENCIES,
  type EmploymentType,
  type JobPosting,
  type RecruiterProfile,
  type SalaryPeriod,
  type WorkMode,
} from "@/lib/types";
import { deleteJobPosting, loadMyJobPostings, saveJobPosting, setJobPostingStatus } from "@/lib/storage";
import { HelpTooltip } from "./HelpTooltip";
import { ApplicantsModal } from "./ApplicantsModal";

type Props = {
  userId: string;
  recruiterProfile: RecruiterProfile | null;
  onSaveProfile: (updates: Partial<Pick<RecruiterProfile, "companyName" | "atsAiEnabled">>) => void;
};

// Same option lists JobsRolesTab.tsx uses for RoleDef criteria, minus "any" — a job posting states an
// actual employment type/work mode, it can't be "doesn't matter" the way a candidate's own preference can.
const WORK_MODES: { value: WorkMode; label: string }[] = [
  { value: "remote", label: "Remote" },
  { value: "onsite", label: "On-site" },
  { value: "hybrid", label: "Hybrid" },
];
const EMPLOYMENT_TYPES: { value: EmploymentType; label: string }[] = [
  { value: "full-time", label: "Full-time" },
  { value: "part-time", label: "Part-time" },
  { value: "contract", label: "Contract" },
  { value: "internship", label: "Internship" },
];
const SALARY_PERIODS: { value: SalaryPeriod; label: string }[] = [
  { value: "annual", label: "/ year" },
  { value: "monthly", label: "/ month" },
  { value: "hourly", label: "/ hour" },
];

function emptyDraft() {
  return {
    title: "",
    company: "",
    description: "",
    location: "",
    workMode: "remote" as WorkMode,
    employmentType: "full-time" as EmploymentType,
    salaryCurrency: "USD",
    salaryPeriod: "annual" as SalaryPeriod,
    salaryMin: "",
    salaryMax: "",
  };
}

// The Recruiter tab (2026-08-19) — a capability any signed-in user can self-serve activate, not a
// separate account type (see docs/architecture.md's "Recruiter portal" section). Postings list+detail
// mirrors RoleTemplates.tsx's list+detail pattern; AI-ATS settings block mirrors AITab.tsx's.
export function RecruiterTab({ userId, recruiterProfile, onSaveProfile }: Props) {
  const [postings, setPostings] = useState<JobPosting[]>([]);
  const [loadingPostings, setLoadingPostings] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [viewingApplicantsFor, setViewingApplicantsFor] = useState<JobPosting | null>(null);

  const [companyName, setCompanyName] = useState(recruiterProfile?.companyName || "");
  const [atsAiEnabled, setAtsAiEnabled] = useState(recruiterProfile?.atsAiEnabled || false);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    setCompanyName(recruiterProfile?.companyName || "");
    setAtsAiEnabled(recruiterProfile?.atsAiEnabled || false);
  }, [recruiterProfile?.companyName, recruiterProfile?.atsAiEnabled]);

  useEffect(() => {
    if (!recruiterProfile) return;
    setLoadingPostings(true);
    loadMyJobPostings(userId).then((p) => {
      setPostings(p);
      setLoadingPostings(false);
    });
  }, [userId, recruiterProfile]);

  const profileDirty = companyName !== (recruiterProfile?.companyName || "") || atsAiEnabled !== (recruiterProfile?.atsAiEnabled || false);

  function handleSaveProfile() {
    setSavingProfile(true);
    onSaveProfile({ companyName, atsAiEnabled });
    toast.success("Recruiter settings saved!");
    setSavingProfile(false);
  }

  function startCreate() {
    setSelectedId(null);
    setCreating(true);
    setDraft(emptyDraft());
  }

  function startEdit(p: JobPosting) {
    setCreating(false);
    setSelectedId(p.id);
    setDraft({
      title: p.title,
      company: p.company,
      description: p.description,
      location: p.location,
      workMode: p.workMode === "any" ? "remote" : p.workMode,
      employmentType: p.employmentType === "any" ? "full-time" : p.employmentType,
      salaryCurrency: p.salaryCurrency,
      salaryPeriod: p.salaryPeriod,
      salaryMin: p.salaryMin != null ? String(p.salaryMin) : "",
      salaryMax: p.salaryMax != null ? String(p.salaryMax) : "",
    });
  }

  async function handleSavePosting() {
    if (!draft.title.trim() || !draft.description.trim()) {
      toast.error("Title and description are required.");
      return;
    }
    setSaving(true);
    try {
      const saved = await saveJobPosting(userId, {
        id: selectedId || undefined,
        title: draft.title.trim(),
        company: draft.company.trim(),
        description: draft.description.trim(),
        location: draft.location.trim(),
        workMode: draft.workMode,
        employmentType: draft.employmentType,
        salaryCurrency: draft.salaryCurrency,
        salaryPeriod: draft.salaryPeriod,
        salaryMin: draft.salaryMin ? Number(draft.salaryMin) : null,
        salaryMax: draft.salaryMax ? Number(draft.salaryMax) : null,
      });
      if (!saved) {
        toast.error("Failed to save posting.");
        return;
      }
      setPostings((prev) => (selectedId ? prev.map((p) => (p.id === saved.id ? saved : p)) : [saved, ...prev]));
      setSelectedId(saved.id);
      setCreating(false);
      toast.success(selectedId ? "Posting updated." : "Posting published — candidates can see it now.");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleStatus(p: JobPosting) {
    const next = p.status === "open" ? "closed" : "open";
    await setJobPostingStatus(p.id, next);
    setPostings((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: next } : x)));
    toast.success(next === "closed" ? "Posting closed." : "Posting reopened.");
  }

  async function handleDelete(p: JobPosting) {
    if (!window.confirm(`Delete "${p.title}"? Its applications will also become unreachable.`)) return;
    await deleteJobPosting(p.id);
    setPostings((prev) => prev.filter((x) => x.id !== p.id));
    if (selectedId === p.id) setSelectedId(null);
    toast.success("Posting deleted.");
  }

  if (!recruiterProfile) {
    // Account type is chosen once at signup (candidate vs. recruiter, with a company-email requirement
    // for recruiters) and can't be added to an existing candidate account afterward — one email is one
    // account type for good. See docs/architecture.md's "Recruiter portal" section.
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Recruiter</h2>
        </div>
        <div className="panel-body" style={{ textAlign: "center", padding: "3rem 2rem" }}>
          <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>🧑‍💼</div>
          <h3 style={{ marginBottom: "0.5rem" }}>This is a candidate account</h3>
          <p className="hint" style={{ maxWidth: "420px", margin: "0 auto" }}>
            Recruiter accounts are created at signup with a company email and can&apos;t be added to an
            existing account afterward. Sign up separately with your company email to post jobs and use
            AI-ATS.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Recruiter</h2>
        <span className="hint compact">Post jobs, review applicants, and optionally let AI-ATS rank them</span>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <div style={{ border: "1px solid var(--line)", borderRadius: "10px", padding: "1rem", maxWidth: "480px" }}>
          <h3 style={{ marginTop: 0, fontSize: "0.95rem" }}>Settings</h3>
          <label className="field">
            <span>Company name</span>
            <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Your company" />
          </label>
          <label className="field" style={{ marginTop: "0.75rem" }}>
            <span>
              Enable AI-ATS
              <HelpTooltip
                title="AI-ATS"
                content={
                  <p>
                    When on, every new application with a built resume (from the Resume Builder) is
                    automatically scored 0-100 against your job description. Applications with only an
                    uploaded resume file stay unscored — you can trigger scoring manually per applicant.
                    Uses its own credit balance, separate from candidate-side AI.
                  </p>
                }
              />
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.25rem" }}>
              <input type="checkbox" checked={atsAiEnabled} onChange={(e) => setAtsAiEnabled(e.target.checked)} style={{ width: "1.2rem", height: "1.2rem" }} />
              <span style={{ fontSize: "0.85rem", color: atsAiEnabled ? "var(--ok)" : "var(--muted)" }}>
                {atsAiEnabled ? "Active" : "Inactive"}
              </span>
            </div>
          </label>
          <p className="hint compact" style={{ marginTop: "0.75rem" }}>
            <strong>AI-ATS credits remaining: {recruiterProfile.atsAiCredits}</strong> — ask an admin to
            grant more.
          </p>
          <button type="button" className="btn primary" onClick={handleSaveProfile} disabled={savingProfile || !profileDirty} style={{ marginTop: "0.5rem" }}>
            {savingProfile ? "Saving…" : "Save Settings"}
          </button>
        </div>

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <h3 style={{ margin: 0, fontSize: "0.95rem" }}>Your postings ({postings.length})</h3>
            <button type="button" className="btn" style={{ fontSize: "0.75rem" }} onClick={startCreate}>
              + New posting
            </button>
          </div>

          <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: "0 0 260px", minWidth: "220px" }}>
              {loadingPostings ? (
                <p className="hint compact">Loading…</p>
              ) : postings.length === 0 ? (
                <p className="hint compact">No postings yet.</p>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  {postings.map((p) => (
                    <li
                      key={p.id}
                      onClick={() => startEdit(p)}
                      style={{
                        border: `1px solid ${selectedId === p.id ? "var(--accent)" : "var(--line)"}`,
                        borderRadius: "8px",
                        padding: "0.5rem 0.6rem",
                        cursor: "pointer",
                        background: selectedId === p.id ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "var(--bg-elevated)",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.4rem" }}>
                        <strong style={{ fontSize: "0.85rem" }}>{p.title}</strong>
                        <span className={`badge ${p.status === "open" ? "ok" : ""}`} style={{ fontSize: "0.65rem" }}>{p.status}</span>
                      </div>
                      <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem", flexWrap: "wrap" }}>
                        <button type="button" className="btn ghost" style={{ fontSize: "0.68rem", padding: "0.1rem 0.3rem" }} onClick={(e) => { e.stopPropagation(); setViewingApplicantsFor(p); }}>
                          Applicants
                        </button>
                        <button type="button" className="btn ghost" style={{ fontSize: "0.68rem", padding: "0.1rem 0.3rem" }} onClick={(e) => { e.stopPropagation(); handleToggleStatus(p); }}>
                          {p.status === "open" ? "Close" : "Reopen"}
                        </button>
                        <button type="button" className="btn ghost danger" style={{ fontSize: "0.68rem", padding: "0.1rem 0.3rem", marginLeft: "auto" }} onClick={(e) => { e.stopPropagation(); handleDelete(p); }}>
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="scroll-area" style={{ flex: "1 1 380px", minWidth: "280px" }}>
              {!creating && !selectedId ? (
                <p className="hint">Select a posting to edit it, or create a new one.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                  <label className="field">
                    <span>Title</span>
                    <input type="text" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Backend Engineer" />
                  </label>
                  <div className="grid-2">
                    <label className="field">
                      <span>Company</span>
                      <input type="text" value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>Location</span>
                      <input type="text" value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="e.g. Remote, Pakistan" />
                    </label>
                    <label className="field">
                      <span>Work mode</span>
                      <select value={draft.workMode} onChange={(e) => setDraft({ ...draft, workMode: e.target.value as WorkMode })}>
                        {WORK_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </label>
                    <label className="field">
                      <span>Employment type</span>
                      <select value={draft.employmentType} onChange={(e) => setDraft({ ...draft, employmentType: e.target.value as EmploymentType })}>
                        {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className="field">
                    <span>Salary range (optional)</span>
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      <select value={draft.salaryCurrency} onChange={(e) => setDraft({ ...draft, salaryCurrency: e.target.value })} style={{ width: "90px" }}>
                        {SALARY_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <select value={draft.salaryPeriod} onChange={(e) => setDraft({ ...draft, salaryPeriod: e.target.value as SalaryPeriod })} style={{ width: "100px" }}>
                        {SALARY_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                      <input type="number" min={0} value={draft.salaryMin} onChange={(e) => setDraft({ ...draft, salaryMin: e.target.value })} placeholder="Min" />
                      <input type="number" min={0} value={draft.salaryMax} onChange={(e) => setDraft({ ...draft, salaryMax: e.target.value })} placeholder="Max" />
                    </div>
                  </label>
                  <label className="field">
                    <span>Description &amp; requirements</span>
                    <textarea rows={8} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What the role involves, what you're looking for…" />
                  </label>
                  <div>
                    <button type="button" className="btn primary" onClick={handleSavePosting} disabled={saving}>
                      {saving ? "Saving…" : selectedId ? "Save changes" : "Publish posting"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {viewingApplicantsFor && (
        <ApplicantsModal posting={viewingApplicantsFor} onClose={() => setViewingApplicantsFor(null)} />
      )}
    </section>
  );
}
