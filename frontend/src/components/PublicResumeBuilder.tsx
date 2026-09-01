"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import {
  uid,
  PersonalInfoSection,
  SummarySection,
  ExperienceSection,
  EducationSection,
  ProjectsSection,
  SkillsSection,
  CertificationsSection,
  LanguagesSection,
  StyleSection,
} from "@/components/ResumeBuilder";
import { ModernTemplate } from "@/lib/resumeTemplates/ModernTemplate";
import { ClassicTemplate } from "@/lib/resumeTemplates/ClassicTemplate";
import { useResumeProfilePdf } from "@/lib/resumePdf";
import { computePageBreaks, mmToPx } from "@/lib/resumePaginate";
import { computeAtsScore } from "@/lib/atsScore";
import { supabase } from "@/lib/supabase";
import { loadCandidateProfile } from "@/lib/storage";
import {
  emptyResumeData,
  defaultResumeStyle,
  type ResumeData,
  type ResumeTemplateId,
  type CandidateProfile,
} from "@/lib/types";

// The free, public, unauthenticated resume builder (2026-08-31, reworked same day per operator ask: "same
// design, same proportion, everything" -- the first pass built a simplified, ad-hoc form/preview that
// didn't match the real app's polish). This version reuses the ACTUAL form-and-preview machinery
// ResumeBuilder.tsx uses -- the same exported section components (PersonalInfoSection, ExperienceSection,
// etc.), the same real A4-proportioned, page-break-aware, zoom-to-fit live preview, the same Content/Style
// tabs -- copied faithfully rather than through ResumeBuilder.tsx itself, because that component's data
// model (roleDefs/activeRole/scratchResumeProfileId) is genuinely role-scoped: there is no such thing as a
// "role" for an anonymous visitor, and forcing one in would be the same kind of risky shared-state
// entanglement this repo already avoided once this session (jobspy.worker.js vs. scraper.worker.js). What
// IS reused directly: the four exported pure pieces (uid, the section components, the template renderers,
// the PDF-generation hook) plus lib/resumePaginate.ts's pagination math -- so the design is pixel-identical,
// only the role-linked state underneath it is replaced with a single, role-less local draft.
//
// Anonymous visitors get exactly ONE resume (localStorage-backed, no account) -- signing up is what
// unlocks saving multiple. Logged-in visitors instead pull their real CandidateProfile / save straight
// into their real automailsend_resume_profiles library, same as the authed Resumes tab.
const DRAFT_KEY = "cuneihire_public_resume_draft";
const TEMPLATE_KEY = "cuneihire_public_resume_template";

const TEMPLATES: Record<ResumeTemplateId, { label: string; Component: (props: { data: ResumeData }) => React.JSX.Element }> = {
  modern: { label: "Modern", Component: ModernTemplate },
  classic: { label: "Classic", Component: ClassicTemplate },
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
  const [formTab, setFormTab] = useState<"content" | "style">("content");
  const [session, setSession] = useState<{ userId: string } | null | undefined>(undefined); // undefined = not checked yet
  const [jobDescription, setJobDescription] = useState("");
  const [showAtsPanel, setShowAtsPanel] = useState(false);
  const [emailGateOpen, setEmailGateOpen] = useState(false);
  const [gateEmail, setGateEmail] = useState("");
  const [gateHoneypot, setGateHoneypot] = useState("");
  const [gateSubmitting, setGateSubmitting] = useState(false);
  const [savingToLibrary, setSavingToLibrary] = useState(false);

  const { generateDownload, portal, busy: pdfBusy } = useResumeProfilePdf();

  function onChange(patch: Partial<ResumeData>) {
    setData((d) => ({ ...d, ...patch }));
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s ? { userId: s.user.id } : null);
    });
  }, []);

  // Debounced localStorage autosave — same ~800ms convention used throughout the app.
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

  // ---- The exact pagination/live-preview machinery ResumeBuilder.tsx uses, copied faithfully (see file
  // header) -- pure functions of data/templateId, nothing role- or auth-dependent about any of it. ----
  const previewContentRef = useRef<HTMLDivElement>(null);
  const previewViewportRef = useRef<HTMLDivElement>(null);
  const printAreaRef = useRef<HTMLDivElement>(null);
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const [pageBreaks, setPageBreaks] = useState<number[]>([]);
  const [atomPage, setAtomPage] = useState<Record<string, number>>({});
  const [currentPage, setCurrentPage] = useState(0);
  const [fitScale, setFitScale] = useState(1);

  useLayoutEffect(() => {
    const el = previewContentRef.current;
    if (!el) return;
    function measure() {
      if (!el) return;
      const paddingPx = mmToPx((data.style ?? defaultResumeStyle()).pagePaddingMm);
      const { breaks, atomPage: nextAtomPage } = computePageBreaks(el, paddingPx);
      setPageBreaks((prev) => (prev.length === breaks.length && prev.every((v, i) => v === breaks[i]) ? prev : breaks));
      setAtomPage((prev) => {
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(nextAtomPage);
        const same = prevKeys.length === nextKeys.length && prevKeys.every((k) => prev[k] === nextAtomPage[k]);
        return same ? prev : nextAtomPage;
      });
      setCurrentPage((p) => Math.min(p, Math.max(breaks.length - 1, 0)));
    }
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data, templateId]);

  useEffect(() => {
    const viewport = previewViewportRef.current;
    const page = printAreaRef.current;
    if (!viewport || !page) return;
    function recompute() {
      if (!viewport || !page || !page.offsetWidth || !page.offsetHeight) return;
      const availH = Math.max(viewport.clientHeight - 24, 0);
      const scale = Math.min(viewport.clientWidth / page.offsetWidth, availH / page.offsetHeight, 1);
      setFitScale((prev) => (Math.abs(prev - scale) < 0.001 ? prev : scale));
    }
    recompute();
    const raf = requestAnimationFrame(recompute);
    const ro = new ResizeObserver(recompute);
    ro.observe(viewport);
    window.addEventListener("resize", recompute);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, []);

  useEffect(() => {
    const container = editorScrollRef.current;
    if (!container) return;
    let rafId: number | null = null;
    function handleScroll() {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!container) return;
        const containerRect = container.getBoundingClientRect();
        const triggerY = containerRect.top + containerRect.height * 0.28;
        const atoms = container.querySelectorAll<HTMLElement>("[data-atom-key]");
        let activeKey: string | null = null;
        for (const el of atoms) {
          if (el.getBoundingClientRect().top <= triggerY) activeKey = el.getAttribute("data-atom-key");
          else break;
        }
        if (activeKey !== null) {
          const page = atomPage[activeKey];
          if (page !== undefined) setCurrentPage((p) => (p === page ? p : page));
        }
      });
    }
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [atomPage]);

  function goToPage(n: number) {
    setCurrentPage((p) => {
      const clamped = Math.max(0, Math.min(n, pageBreaks.length - 1));
      return clamped === p ? p : clamped;
    });
  }
  // ---- end copied pagination machinery ----

  async function startFromProfile() {
    if (session === undefined) return;
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

  if (view === "choose") {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-3" style={{ fontFamily: "var(--font-display), Georgia, serif", color: "var(--ink)" }}>
          Free Resume Builder
        </h1>
        <p className="mb-10" style={{ color: "var(--muted)" }}>
          Build a clean, ATS-friendly resume in minutes. No account needed for one free resume — sign up
          to save multiple versions.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <button type="button" onClick={startFromProfile} className="text-left p-5 border" style={{ borderColor: "var(--line)", borderRadius: "12px", background: "var(--bg-panel)" }}>
            <div className="font-semibold mb-1" style={{ color: "var(--ink)" }}>Build from profile</div>
            <div className="text-sm" style={{ color: "var(--muted)" }}>Already have a Cuneihire account? Pull in your saved profile.</div>
          </button>
          <button type="button" onClick={startFromScratch} className="text-left p-5 border" style={{ borderColor: "var(--line)", borderRadius: "12px", background: "var(--bg-panel)" }}>
            <div className="font-semibold mb-1" style={{ color: "var(--ink)" }}>Start from scratch</div>
            <div className="text-sm" style={{ color: "var(--muted)" }}>Build directly in the browser — one free resume, no account needed.</div>
          </button>
          <div className="text-left p-5 border opacity-60" style={{ borderColor: "var(--line)", borderRadius: "12px", background: "var(--bg-panel)" }}>
            <div className="font-semibold mb-1" style={{ color: "var(--ink)" }}>Upload your own</div>
            <div className="text-sm" style={{ color: "var(--muted)" }}>Coming soon.</div>
          </div>
        </div>
      </div>
    );
  }

  const PreviewTemplate = TEMPLATES[templateId].Component;
  const style = data.style ?? defaultResumeStyle();
  const pageCount = Math.max(pageBreaks.length, 1);
  const startPx = currentPage > 0 ? (pageBreaks[currentPage - 1] ?? 0) : 0;
  const endPx = pageBreaks[currentPage] ?? startPx;
  const thisPageContentPx = Math.max(endPx - startPx, 0);

  return (
    <div className="px-6 py-6" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 2rem)", maxWidth: "1400px", margin: "0 auto" }}>
      {portal}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <button type="button" className="btn ghost small" onClick={() => setView("choose")}>← Start over</button>
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" className="btn primary" onClick={handleDownloadClick} disabled={pdfBusy}>
            {pdfBusy ? "Generating…" : "Download PDF"}
          </button>
          {session ? (
            <button type="button" className="btn ghost" onClick={saveToLibrary} disabled={savingToLibrary}>
              {savingToLibrary ? "Saving…" : "Save to my library"}
            </button>
          ) : (
            <Link href="/signup?next=/resume-builder" className="btn ghost">Sign up to save multiple resumes</Link>
          )}
          <button type="button" className="btn ghost" onClick={() => setShowAtsPanel((v) => !v)}>
            ATS score: {ats.score}/100 {showAtsPanel ? "▲" : "▼"}
          </button>
        </div>
      </div>

      {showAtsPanel && (
        <div className="panel mb-4" style={{ padding: "0.9rem 1rem" }}>
          <label className="field">
            <span>Paste a job description (optional) for a keyword match</span>
            <input value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} placeholder="Paste the job posting text here…" />
          </label>
          {ats.keywordMatch && (
            <p className="text-sm mt-2" style={{ color: "var(--ink)" }}>
              <strong>{ats.keywordMatch.percent}%</strong> keyword overlap with this job description.
              {ats.keywordMatch.missing.length > 0 && <> Consider adding: {ats.keywordMatch.missing.slice(0, 8).join(", ")}.</>}
            </p>
          )}
          <ul className="mt-2" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0.3rem 1rem" }}>
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

      {/* Same two-pane layout as ResumeBuilder.tsx's renderFormAndPreview — see that function's own
          comments (2026-08-20 layout rewrite) for why each of these exact proportions/behaviors exist. */}
      <div style={{ display: "flex", gap: "1.25rem", alignItems: "stretch", flexWrap: "nowrap", flex: "1 1 auto", minHeight: 0 }}>
        <div ref={editorScrollRef} className="no-print" style={{ flex: "1 1 420px", minWidth: "320px", minHeight: 0, overflowY: "auto", paddingRight: "0.25rem" }}>
          <div role="tablist" style={{ display: "flex", gap: "0.4rem", marginBottom: "0.7rem", position: "sticky", top: 0, zIndex: 1, background: "var(--bg)", paddingTop: "0.1rem", paddingBottom: "0.3rem" }}>
            <button type="button" role="tab" aria-selected={formTab === "content"} className={`btn ${formTab === "content" ? "primary" : "ghost"}`} style={{ fontSize: "0.8rem" }} onClick={() => setFormTab("content")}>Content</button>
            <button type="button" role="tab" aria-selected={formTab === "style"} className={`btn ${formTab === "style" ? "primary" : "ghost"}`} style={{ fontSize: "0.8rem" }} onClick={() => setFormTab("style")}>Style</button>
          </div>
          {formTab === "content" ? (
            <>
              <PersonalInfoSection data={data} onChange={onChange} />
              <SummarySection data={data} onChange={onChange} />
              <ExperienceSection data={data} onChange={onChange} />
              <ProjectsSection data={data} onChange={onChange} />
              <EducationSection data={data} onChange={onChange} />
              <SkillsSection data={data} onChange={onChange} />
              <CertificationsSection data={data} onChange={onChange} />
              <LanguagesSection data={data} onChange={onChange} />
            </>
          ) : (
            <StyleSection
              style={style}
              onChange={(patch) => onChange({ style: { ...style, ...patch } })}
              templateId={templateId}
              onTemplateChange={setTemplateId}
            />
          )}
          {/* Ad slot placeholder (2026-08-31) -- no network/script until an ad network is actually
              approved, which needs the cuneihire.com domain first (operator decision). */}
          <div
            aria-hidden="true"
            className="no-print"
            style={{ marginTop: "1rem", minHeight: "90px", border: "1px dashed var(--line)", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", color: "var(--muted)" }}
          >
            Ad slot (reserved)
          </div>
        </div>

        <div style={{ flex: "0 1 480px", minWidth: "320px", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {pageCount > 1 && (
            <div className="no-print" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem", fontSize: "0.8rem" }}>
              <button type="button" className="btn ghost" style={{ padding: "0.15rem 0.55rem" }} disabled={currentPage === 0} onClick={() => goToPage(currentPage - 1)}>‹</button>
              <span className="hint compact" style={{ margin: 0 }}>Page {currentPage + 1} of {pageCount}</span>
              <button type="button" className="btn ghost" style={{ padding: "0.15rem 0.55rem" }} disabled={currentPage >= pageCount - 1} onClick={() => goToPage(currentPage + 1)}>›</button>
            </div>
          )}
          <div ref={previewViewportRef} style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflowY: "auto", overflowX: "hidden" }}>
            <div
              ref={printAreaRef}
              className="resume-print-area"
              style={{ width: "210mm", height: "297mm", overflow: "hidden", display: "flex", flexDirection: "column", zoom: fitScale } as React.CSSProperties}
            >
              <div style={{ height: `${style.pagePaddingMm}mm`, flexShrink: 0 }} />
              <div className="resume-print-clip" style={{ flex: "1 1 auto", minHeight: 0, overflow: "hidden", paddingLeft: `${style.pagePaddingMm}mm`, paddingRight: `${style.pagePaddingMm}mm` }}>
                <div className="resume-print-page-slice" style={{ height: `${thisPageContentPx}px`, overflow: "hidden" }}>
                  <div ref={previewContentRef} className="resume-print-content" style={{ transform: `translateY(-${startPx}px)` }}>
                    <PreviewTemplate data={data} />
                  </div>
                </div>
              </div>
              <div style={{ height: `${style.pagePaddingMm}mm`, flexShrink: 0 }} />
            </div>
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
