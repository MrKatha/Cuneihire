"use client";

import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { AutoGrowTextarea } from "@/components/AutoGrowTextarea";
import { MarkdownLiteField, uid } from "@/components/ResumeBuilder";
import { ModernTemplate } from "@/lib/resumeTemplates/ModernTemplate";
import { ClassicTemplate } from "@/lib/resumeTemplates/ClassicTemplate";
import { useResumeProfilePdf } from "@/lib/resumePdf";
import { computeAtsScore } from "@/lib/atsScore";
import { supabase } from "@/lib/supabase";
import { loadCandidateProfile } from "@/lib/storage";
import {
  emptyResumeData,
  type ResumeData,
  type ResumeExperience,
  type ResumeEducation,
  type ResumeProject,
  type ResumeCertification,
  type ResumeLanguage,
  type ResumeTemplateId,
  type CandidateProfile,
} from "@/lib/types";

// The free, public, unauthenticated resume builder (2026-08-31) — the lead-gen/ad-monetized funnel
// decision, see docs/architecture.md's "Public resume builder" section. Deliberately NOT a reuse of
// ResumeBuilder.tsx itself (that component is woven into roles/candidate-profile/Supabase-save state that
// doesn't exist for an anonymous visitor) — this is a smaller, self-contained sibling that reuses only the
// genuinely pure pieces: the template renderers, the PDF-generation hook, MarkdownLiteField, and the
// ResumeData type itself (so a later "claim this as your real profile" flow is a trivial save, same shape).
const DRAFT_KEY = "cuneihire_public_resume_draft";
const TEMPLATE_KEY = "cuneihire_public_resume_template";

const TEMPLATES: Record<ResumeTemplateId, (props: { data: ResumeData }) => React.JSX.Element> = {
  modern: ModernTemplate,
  classic: ClassicTemplate,
};

function candidateProfileToResumeData(p: CandidateProfile): ResumeData {
  const base = emptyResumeData();
  return {
    ...base,
    personalInfo: { ...base.personalInfo, fullName: p.name, email: p.email, phone: p.phone, portfolioUrl: p.portfolioUrl },
    experience: p.experience,
    education: p.education,
    projects: p.projects,
    certifications: p.certifications,
    languages: p.languages,
    skills: p.skills.map((s) => s.name),
  };
}

function loadDraft(): ResumeData | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as ResumeData) : null;
  } catch {
    return null;
  }
}

export function PublicResumeBuilder({ initialMode }: { initialMode: "choose" | "scratch" | "profile" }) {
  const [view, setView] = useState<"choose" | "build">(initialMode === "choose" ? "choose" : "build");
  const [data, setData] = useState<ResumeData>(() => loadDraft() || emptyResumeData());
  const [templateId, setTemplateId] = useState<ResumeTemplateId>(() => {
    if (typeof window === "undefined") return "modern";
    return (window.localStorage.getItem(TEMPLATE_KEY) as ResumeTemplateId) || "modern";
  });
  const [session, setSession] = useState<{ userId: string } | null | undefined>(undefined); // undefined = not checked yet
  const [jobDescription, setJobDescription] = useState("");
  const [showAtsPanel, setShowAtsPanel] = useState(false);
  const [emailGateOpen, setEmailGateOpen] = useState(false);
  const [gateEmail, setGateEmail] = useState("");
  const [gateHoneypot, setGateHoneypot] = useState("");
  const [gateSubmitting, setGateSubmitting] = useState(false);
  const [savingToLibrary, setSavingToLibrary] = useState(false);

  const { generateDownload, portal, busy: pdfBusy } = useResumeProfilePdf();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s ? { userId: s.user.id } : null);
    });
  }, []);

  // Debounced localStorage autosave — same ~800ms convention as the authed app's own debounces.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
      } catch {
        // Private-browsing/storage-blocked — silently skip; the form still works for this session.
      }
    }, 800);
    return () => clearTimeout(t);
  }, [data]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TEMPLATE_KEY, templateId);
    } catch {
      // ignore
    }
  }, [templateId]);

  async function startFromProfile() {
    if (session === undefined) return; // still checking
    if (!session) {
      window.location.href = "/login?next=/resume-builder";
      return;
    }
    const profile = await loadCandidateProfile(session.userId);
    setData(candidateProfileToResumeData(profile));
    setView("build");
  }

  function startFromScratch() {
    setView("build");
  }

  const ats = useMemo(() => computeAtsScore(data, jobDescription), [data, jobDescription]);
  const Template = TEMPLATES[templateId];

  async function doDownload() {
    const profile = { id: uid(), label: data.personalInfo.fullName || "Resume", templateId, data };
    try {
      const { url, fileName } = await generateDownload(profile);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      toast.success("Resume downloaded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate PDF.");
    }
  }

  async function handleDownloadClick() {
    if (session) {
      await doDownload();
      return;
    }
    setEmailGateOpen(true);
  }

  async function submitEmailGate(e: React.FormEvent) {
    e.preventDefault();
    setGateSubmitting(true);
    try {
      const res = await fetch("/api/public/resume-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: gateEmail, resumeData: data, templateId, company: gateHoneypot }),
      });
      const json = await res.json();
      if (!json.success) {
        toast.error(json.error || "Something went wrong.");
        setGateSubmitting(false);
        return;
      }
      setEmailGateOpen(false);
      await doDownload();
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setGateSubmitting(false);
    }
  }

  async function saveToLibrary() {
    if (!session) return;
    setSavingToLibrary(true);
    try {
      const { error } = await supabase.from("automailsend_resume_profiles").insert({
        user_id: session.userId,
        label: data.personalInfo.fullName ? `${data.personalInfo.fullName}'s Resume` : "My Resume",
        template_id: templateId,
        data,
      });
      if (error) throw error;
      toast.success("Saved to your Resume library — find it under the Resumes tab.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSavingToLibrary(false);
    }
  }

  // ---- repeatable-array helpers ----
  function addExperience() {
    const item: ResumeExperience = { id: uid(), company: "", title: "", location: "", startDate: "", endDate: "", current: false, description: "" };
    setData((d) => ({ ...d, experience: [...d.experience, item] }));
  }
  function updateExperience(id: string, patch: Partial<ResumeExperience>) {
    setData((d) => ({ ...d, experience: d.experience.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  }
  function removeExperience(id: string) {
    setData((d) => ({ ...d, experience: d.experience.filter((e) => e.id !== id) }));
  }

  function addEducation() {
    const item: ResumeEducation = { id: uid(), school: "", degree: "", field: "", startDate: "", endDate: "", notes: "" };
    setData((d) => ({ ...d, education: [...d.education, item] }));
  }
  function updateEducation(id: string, patch: Partial<ResumeEducation>) {
    setData((d) => ({ ...d, education: d.education.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  }
  function removeEducation(id: string) {
    setData((d) => ({ ...d, education: d.education.filter((e) => e.id !== id) }));
  }

  function addProject() {
    const item: ResumeProject = { id: uid(), name: "", description: "", link: "" };
    setData((d) => ({ ...d, projects: [...d.projects, item] }));
  }
  function updateProject(id: string, patch: Partial<ResumeProject>) {
    setData((d) => ({ ...d, projects: d.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }
  function removeProject(id: string) {
    setData((d) => ({ ...d, projects: d.projects.filter((p) => p.id !== id) }));
  }

  function addCertification() {
    const item: ResumeCertification = { id: uid(), name: "", issuer: "", date: "" };
    setData((d) => ({ ...d, certifications: [...d.certifications, item] }));
  }
  function updateCertification(id: string, patch: Partial<ResumeCertification>) {
    setData((d) => ({ ...d, certifications: d.certifications.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  }
  function removeCertification(id: string) {
    setData((d) => ({ ...d, certifications: d.certifications.filter((c) => c.id !== id) }));
  }

  function addLanguage() {
    const item: ResumeLanguage = { id: uid(), name: "", level: "" };
    setData((d) => ({ ...d, languages: [...d.languages, item] }));
  }
  function updateLanguage(id: string, patch: Partial<ResumeLanguage>) {
    setData((d) => ({ ...d, languages: d.languages.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  }
  function removeLanguage(id: string) {
    setData((d) => ({ ...d, languages: d.languages.filter((l) => l.id !== id) }));
  }

  if (view === "choose") {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-3" style={{ fontFamily: "var(--font-display), Georgia, serif", color: "var(--ink)" }}>
          Free Resume Builder
        </h1>
        <p className="mb-10" style={{ color: "var(--muted)" }}>
          Build a clean, ATS-friendly resume in minutes. No account needed — sign in only unlocks saving
          multiple versions.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <button type="button" onClick={startFromProfile} className="text-left p-5 border" style={{ borderColor: "var(--line)", borderRadius: "12px", background: "var(--bg-panel)" }}>
            <div className="font-semibold mb-1" style={{ color: "var(--ink)" }}>Build from profile</div>
            <div className="text-sm" style={{ color: "var(--muted)" }}>Already have a Cuneihire account? Pull in your saved profile.</div>
          </button>
          <button type="button" onClick={startFromScratch} className="text-left p-5 border" style={{ borderColor: "var(--line)", borderRadius: "12px", background: "var(--bg-panel)" }}>
            <div className="font-semibold mb-1" style={{ color: "var(--ink)" }}>Start from scratch</div>
            <div className="text-sm" style={{ color: "var(--muted)" }}>Build directly in the browser — nothing saved until you download.</div>
          </button>
          <div className="text-left p-5 border opacity-60" style={{ borderColor: "var(--line)", borderRadius: "12px", background: "var(--bg-panel)" }}>
            <div className="font-semibold mb-1" style={{ color: "var(--ink)" }}>Upload your own</div>
            <div className="text-sm" style={{ color: "var(--muted)" }}>Coming soon.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      {portal}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <button type="button" className="btn ghost small" onClick={() => setView("choose")}>← Start over</button>
        <div className="flex items-center gap-2">
          {(["modern", "classic"] as ResumeTemplateId[]).map((t) => (
            <button key={t} type="button" className="btn ghost small" onClick={() => setTemplateId(t)} style={{ borderBottom: templateId === t ? "2px solid var(--accent)" : "2px solid transparent", borderRadius: 0, fontWeight: templateId === t ? 600 : 500 }}>
              {t === "modern" ? "Modern" : "Classic"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_1fr] gap-8">
        {/* Form column */}
        <div className="space-y-6">
          <section className="p-4 border" style={{ borderColor: "var(--line)", borderRadius: "12px" }}>
            <h3 className="font-semibold mb-3" style={{ color: "var(--ink)" }}>Personal Info</h3>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="field"><span>Full name</span><input value={data.personalInfo.fullName} onChange={(e) => setData((d) => ({ ...d, personalInfo: { ...d.personalInfo, fullName: e.target.value } }))} /></label>
              <label className="field"><span>Title / headline</span><input value={data.personalInfo.title} onChange={(e) => setData((d) => ({ ...d, personalInfo: { ...d.personalInfo, title: e.target.value } }))} placeholder="Senior Product Designer" /></label>
              <label className="field"><span>Email</span><input type="email" value={data.personalInfo.email} onChange={(e) => setData((d) => ({ ...d, personalInfo: { ...d.personalInfo, email: e.target.value } }))} /></label>
              <label className="field"><span>Phone</span><input value={data.personalInfo.phone} onChange={(e) => setData((d) => ({ ...d, personalInfo: { ...d.personalInfo, phone: e.target.value } }))} /></label>
              <label className="field"><span>Location</span><input value={data.personalInfo.location} onChange={(e) => setData((d) => ({ ...d, personalInfo: { ...d.personalInfo, location: e.target.value } }))} /></label>
              <label className="field"><span>LinkedIn URL</span><input value={data.personalInfo.linkedinUrl} onChange={(e) => setData((d) => ({ ...d, personalInfo: { ...d.personalInfo, linkedinUrl: e.target.value } }))} /></label>
            </div>
          </section>

          <section className="p-4 border" style={{ borderColor: "var(--line)", borderRadius: "12px" }}>
            <h3 className="font-semibold mb-2" style={{ color: "var(--ink)" }}>Summary</h3>
            <AutoGrowTextarea value={data.summary} onChange={(e) => setData((d) => ({ ...d, summary: e.target.value }))} placeholder="2-3 sentences on who you are and what you're looking for." maxHeight={160} />
          </section>

          <section className="p-4 border" style={{ borderColor: "var(--line)", borderRadius: "12px" }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold" style={{ color: "var(--ink)" }}>Experience</h3>
              <button type="button" className="btn ghost small" onClick={addExperience}>+ Add</button>
            </div>
            {data.experience.map((exp) => (
              <div key={exp.id} className="mb-4 pb-4" style={{ borderBottom: "1px solid var(--line)" }}>
                <div className="grid sm:grid-cols-2 gap-2 mb-2">
                  <label className="field"><span>Title</span><input value={exp.title} onChange={(e) => updateExperience(exp.id, { title: e.target.value })} /></label>
                  <label className="field"><span>Company</span><input value={exp.company} onChange={(e) => updateExperience(exp.id, { company: e.target.value })} /></label>
                  <label className="field"><span>Start</span><input value={exp.startDate} onChange={(e) => updateExperience(exp.id, { startDate: e.target.value })} placeholder="Jan 2022" /></label>
                  <label className="field"><span>End</span><input value={exp.endDate} onChange={(e) => updateExperience(exp.id, { endDate: e.target.value })} placeholder="Present" disabled={exp.current} /></label>
                </div>
                <label className="flex items-center gap-2 text-sm mb-2" style={{ color: "var(--muted)" }}>
                  <input type="checkbox" checked={exp.current} onChange={(e) => updateExperience(exp.id, { current: e.target.checked, endDate: e.target.checked ? "Present" : exp.endDate })} /> Current role
                </label>
                <MarkdownLiteField label="Description" value={exp.description} onChange={(v) => updateExperience(exp.id, { description: v })} placeholder={"- Led a team of 5 engineers\n- Reduced load time by 40%"} />
                <button type="button" className="btn ghost small" style={{ color: "var(--danger)" }} onClick={() => removeExperience(exp.id)}>Remove</button>
              </div>
            ))}
            {data.experience.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>No experience added yet.</p>}
          </section>

          <section className="p-4 border" style={{ borderColor: "var(--line)", borderRadius: "12px" }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold" style={{ color: "var(--ink)" }}>Education</h3>
              <button type="button" className="btn ghost small" onClick={addEducation}>+ Add</button>
            </div>
            {data.education.map((ed) => (
              <div key={ed.id} className="mb-4 pb-4" style={{ borderBottom: "1px solid var(--line)" }}>
                <div className="grid sm:grid-cols-2 gap-2 mb-2">
                  <label className="field"><span>School</span><input value={ed.school} onChange={(e) => updateEducation(ed.id, { school: e.target.value })} /></label>
                  <label className="field"><span>Degree</span><input value={ed.degree} onChange={(e) => updateEducation(ed.id, { degree: e.target.value })} /></label>
                  <label className="field"><span>Field</span><input value={ed.field} onChange={(e) => updateEducation(ed.id, { field: e.target.value })} /></label>
                  <label className="field"><span>Years</span><input value={`${ed.startDate}${ed.endDate ? " - " + ed.endDate : ""}`} onChange={(e) => updateEducation(ed.id, { startDate: e.target.value })} placeholder="2018 - 2022" /></label>
                </div>
                <button type="button" className="btn ghost small" style={{ color: "var(--danger)" }} onClick={() => removeEducation(ed.id)}>Remove</button>
              </div>
            ))}
            {data.education.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>No education added yet.</p>}
          </section>

          <section className="p-4 border" style={{ borderColor: "var(--line)", borderRadius: "12px" }}>
            <h3 className="font-semibold mb-2" style={{ color: "var(--ink)" }}>Skills</h3>
            <input
              value={data.skills.join(", ")}
              onChange={(e) => setData((d) => ({ ...d, skills: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }))}
              placeholder="React, Figma, SQL, Project Management"
            />
            <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Comma-separated.</p>
          </section>

          <section className="p-4 border" style={{ borderColor: "var(--line)", borderRadius: "12px" }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold" style={{ color: "var(--ink)" }}>Projects</h3>
              <button type="button" className="btn ghost small" onClick={addProject}>+ Add</button>
            </div>
            {data.projects.map((p) => (
              <div key={p.id} className="mb-4 pb-4" style={{ borderBottom: "1px solid var(--line)" }}>
                <div className="grid sm:grid-cols-2 gap-2 mb-2">
                  <label className="field"><span>Name</span><input value={p.name} onChange={(e) => updateProject(p.id, { name: e.target.value })} /></label>
                  <label className="field"><span>Link</span><input value={p.link} onChange={(e) => updateProject(p.id, { link: e.target.value })} /></label>
                </div>
                <MarkdownLiteField label="Description" value={p.description} onChange={(v) => updateProject(p.id, { description: v })} />
                <button type="button" className="btn ghost small" style={{ color: "var(--danger)" }} onClick={() => removeProject(p.id)}>Remove</button>
              </div>
            ))}
          </section>

          <section className="p-4 border" style={{ borderColor: "var(--line)", borderRadius: "12px" }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold" style={{ color: "var(--ink)" }}>Certifications</h3>
              <button type="button" className="btn ghost small" onClick={addCertification}>+ Add</button>
            </div>
            {data.certifications.map((c) => (
              <div key={c.id} className="grid sm:grid-cols-3 gap-2 mb-2 items-end">
                <label className="field"><span>Name</span><input value={c.name} onChange={(e) => updateCertification(c.id, { name: e.target.value })} /></label>
                <label className="field"><span>Issuer</span><input value={c.issuer} onChange={(e) => updateCertification(c.id, { issuer: e.target.value })} /></label>
                <div className="flex gap-2">
                  <input value={c.date} onChange={(e) => updateCertification(c.id, { date: e.target.value })} placeholder="2024" />
                  <button type="button" className="btn ghost small" style={{ color: "var(--danger)" }} onClick={() => removeCertification(c.id)}>×</button>
                </div>
              </div>
            ))}
          </section>

          <section className="p-4 border" style={{ borderColor: "var(--line)", borderRadius: "12px" }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold" style={{ color: "var(--ink)" }}>Languages</h3>
              <button type="button" className="btn ghost small" onClick={addLanguage}>+ Add</button>
            </div>
            {data.languages.map((l) => (
              <div key={l.id} className="grid sm:grid-cols-2 gap-2 mb-2 items-end">
                <label className="field"><span>Language</span><input value={l.name} onChange={(e) => updateLanguage(l.id, { name: e.target.value })} /></label>
                <div className="flex gap-2">
                  <input value={l.level} onChange={(e) => updateLanguage(l.id, { level: e.target.value })} placeholder="Fluent" />
                  <button type="button" className="btn ghost small" style={{ color: "var(--danger)" }} onClick={() => removeLanguage(l.id)}>×</button>
                </div>
              </div>
            ))}
          </section>
        </div>

        {/* Preview + ATS + download column */}
        <div className="space-y-4 lg:sticky lg:top-6 self-start">
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="btn primary" onClick={handleDownloadClick} disabled={pdfBusy}>
              {pdfBusy ? "Generating…" : "Download PDF"}
            </button>
            {session && (
              <button type="button" className="btn ghost" onClick={saveToLibrary} disabled={savingToLibrary}>
                {savingToLibrary ? "Saving…" : "Save to my library"}
              </button>
            )}
            <button type="button" className="btn ghost" onClick={() => setShowAtsPanel((v) => !v)}>
              ATS score: {ats.score}/100 {showAtsPanel ? "▲" : "▼"}
            </button>
          </div>

          {showAtsPanel && (
            <div className="p-4 border space-y-3" style={{ borderColor: "var(--line)", borderRadius: "12px", background: "var(--bg-panel)" }}>
              <label className="field">
                <span>Paste a job description (optional) for a keyword match</span>
                <AutoGrowTextarea value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} maxHeight={120} placeholder="Paste the job posting text here…" />
              </label>
              {ats.keywordMatch && (
                <p className="text-sm" style={{ color: "var(--ink)" }}>
                  <strong>{ats.keywordMatch.percent}%</strong> keyword overlap with this job description.
                  {ats.keywordMatch.missing.length > 0 && (
                    <> Consider adding: {ats.keywordMatch.missing.slice(0, 8).join(", ")}.</>
                  )}
                </p>
              )}
              <ul className="space-y-1.5">
                {ats.findings.map((f) => (
                  <li key={f.id} className="text-sm flex gap-2">
                    <span style={{ color: f.ok ? "var(--ok)" : "var(--warn)" }}>{f.ok ? "✓" : "•"}</span>
                    <span>
                      <strong style={{ color: "var(--ink)" }}>{f.label}</strong>
                      {!f.ok && <span style={{ color: "var(--muted)" }}> — {f.hint}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="border overflow-hidden" style={{ borderColor: "var(--line)", borderRadius: "12px" }}>
            <div style={{ transform: "scale(0.72)", transformOrigin: "top left", width: "138.9%" }}>
              <Template data={data} />
            </div>
          </div>

          {/* Ad slot placeholder (2026-08-31) -- no network/script until an ad network is actually
              approved, which needs the cuneihire.com domain first (operator decision). This div marks
              where that unit goes once approved. */}
          <div
            aria-hidden="true"
            style={{ minHeight: "90px", border: "1px dashed var(--line)", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", color: "var(--muted)" }}
          >
            Ad slot (reserved)
          </div>
        </div>
      </div>

      {emailGateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }}>
          <form onSubmit={submitEmailGate} className="w-full max-w-sm p-6 space-y-4" style={{ background: "var(--bg-panel)", borderRadius: "12px", border: "1px solid var(--line)" }}>
            <h3 className="font-semibold text-lg" style={{ color: "var(--ink)" }}>Almost there</h3>
            <p className="text-sm" style={{ color: "var(--muted)" }}>Enter your email to download your resume as a PDF.</p>
            <label className="field">
              <span>Email</span>
              <input type="email" required value={gateEmail} onChange={(e) => setGateEmail(e.target.value)} placeholder="you@example.com" autoFocus />
            </label>
            {/* Honeypot -- hidden from real visitors via CSS, not `type="hidden"` (some bots skip those). */}
            <input
              type="text"
              value={gateHoneypot}
              onChange={(e) => setGateHoneypot(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              style={{ position: "absolute", left: "-9999px", width: "1px", height: "1px", opacity: 0 }}
              aria-hidden="true"
            />
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn ghost" onClick={() => setEmailGateOpen(false)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={gateSubmitting}>{gateSubmitting ? "Sending…" : "Download"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
