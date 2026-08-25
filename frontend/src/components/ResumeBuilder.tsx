"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { AutoGrowTextarea } from "@/components/AutoGrowTextarea";
import { HoverHint } from "@/components/HoverHint";
import { ModernTemplate } from "@/lib/resumeTemplates/ModernTemplate";
import { ClassicTemplate } from "@/lib/resumeTemplates/ClassicTemplate";
import { supabase } from "@/lib/supabase";
import { composeResumeData } from "@/lib/resumeCompose";
import { useResumeProfilePdf } from "@/lib/resumePdf";
import { deleteAttachment } from "@/lib/storage";
import { ResumeConfigTab } from "./ResumeConfigTab";
import { computePageBreaks, mmToPx } from "@/lib/resumePaginate";
import { resolveRoleResume } from "@/lib/emailResolve";
import { isNameTaken, uniqueNameFallback } from "@/lib/resumeNaming";
import { diffResumeAgainstProfile, mergeResumeIntoProfile, type ResumeSyncDiff } from "@/lib/resumeSync";
import { SyncResumeModal } from "./SyncResumeModal";
import { PdfPreviewModal } from "./PdfPreviewModal";
import {
  emptyResumeData,
  defaultResumeStyle,
  RESUME_FONT_OPTIONS,
  RESUME_TEMPLATE_IDS,
  type AiConfig,
  type Attachment,
  type CandidateProfile,
  type ResumeCertification,
  type ResumeData,
  type ResumeEducation,
  type ResumeExperience,
  type ResumeLanguage,
  type ResumeProfile,
  type ResumeProject,
  type ResumeStyleSettings,
  type ResumeTemplateId,
  type Role,
  type RoleDef,
} from "@/lib/types";

type Props = {
  userId: string | null;
  candidateProfile: CandidateProfile;
  onProfileChange: (profile: CandidateProfile) => void;
  profiles: ResumeProfile[];
  ai: AiConfig;
  roleDefs: RoleDef[];
  // Same shared role-key selection as the Roles/Email Templates tabs (2026-08-20) — switching role here
  // stays in sync everywhere else too.
  activeRole: Role;
  onActiveRoleChange: (role: Role) => void;
  onUpdateRoleRules: (id: string, patch: Partial<RoleDef>) => void;
  onSave: (profile: Partial<ResumeProfile> & { id?: string }) => Promise<ResumeProfile | null>;
  onDelete: (id: string) => Promise<void>;
};

export function uid() {
  return crypto.randomUUID();
}

function seedFromCandidate(p: CandidateProfile): ResumeData {
  const base = emptyResumeData();
  return { ...base, personalInfo: { ...base.personalInfo, fullName: p.name, email: p.email, phone: p.phone, portfolioUrl: p.portfolioUrl } };
}

const TEMPLATES: Record<ResumeTemplateId, { label: string; Component: (props: { data: ResumeData }) => React.JSX.Element }> = {
  modern: { label: "Modern", Component: ModernTemplate },
  classic: { label: "Classic", Component: ClassicTemplate },
};

const MODE_PILLS = ["profile", "scratch"] as const;
const MODE_LABELS: Record<(typeof MODE_PILLS)[number], string> = {
  profile: "From your profile",
  scratch: "Start from scratch",
};
// A role's own effective mode, folding away the retired "upload" pill — see decision 3 in the 2026-08-20
// follow-up: a role saved with resumeMode "upload" from before that change just renders the "profile" pill
// as active (never a phantom third view) until the candidate clicks either pill, which overwrites it.
function effectiveMode(mode: RoleDef["resumeMode"]): (typeof MODE_PILLS)[number] {
  return mode === "scratch" ? "scratch" : "profile";
}

// Resume Builder redesign (2026-08-18, major rewrite 2026-08-20) — role tabs (same as Roles/Email
// Templates/Resumes-Library), each with exactly two modes:
//  - "profile" (default): composed live from the candidate's profile + this role's own module selection
//    (lib/resumeCompose.ts's composeResumeData — no AI, deterministic). Ephemeral until Save — edits live
//    in profileDrafts below, not written anywhere until the candidate explicitly saves. Saving asks
//    whether to also write new/changed items back into the shared Profile & this role's selection (see
//    lib/resumeSync.ts), or keep them local to just this one resume as a separately named Library entry
//    (2026-08-20, same-day follow-up — see finalizeProfileResumeSave's `keepAsDefault` param). Neither
//    choice overwrites what was already in the Library (2026-08-20, later same-day follow-up, operator
//    ask) — both always create a new, uniquely-named entry (see `alwaysNewInstance`); a role with nothing
//    resolvable at all (lib/emailResolve.ts's resolveRoleResume returns null) gets one generated and saved
//    automatically the moment it's opened here, with no click required — see the auto-generate effect
//    below. Every save blocks on a colliding name rather than silently renaming — lib/resumeNaming.ts.
//  - "scratch": an ordinary hand-built resume with zero profile linkage — today's original builder
//    behavior, just scoped to a role via RoleDef.scratchResumeProfileId instead of a flat list.
// A third "upload" mode existed briefly (2026-08-20) — removed the same day per operator ask ("that's it,
// simple"): uploading now only ever sets the one candidate-wide default, in the Library
// (ResumeConfigTab.tsx). A role with no resume of its own inherits that default automatically —
// lib/emailResolve.ts's resolveRoleResume/resolveRoleAttachments are untouched, no resolver change needed.
// The live preview paginates for real now (2026-08-20, bug fix) — lib/resumePaginate.ts's
// computePageBreaks, shared with lib/resumePdf.tsx's PDF generation, so the on-screen page boundaries
// match what's actually emailed.
export function ResumeBuilder({ userId, candidateProfile, onProfileChange, profiles, ai, roleDefs, activeRole, onActiveRoleChange, onUpdateRoleRules, onSave, onDelete }: Props) {
  const active = roleDefs.find((d) => d.key === activeRole) || roleDefs[0] || null;
  const activeMode = active ? effectiveMode(active.resumeMode) : "profile";
  const scratchProfile = active?.scratchResumeProfileId ? profiles.find((p) => p.id === active.scratchResumeProfileId) || null : null;

  // Top-level view (2026-08-24 UI pass, operator ask — "remove the Builder tab... put a direct From your
  // Profile and Start from Scratch tab and a Library tab, so it will be three tabs"). Was two stacked rows
  // (a "Builder"/"Library" pair above a separate "From your profile"/"Start from scratch" pill row) eating
  // real height for no reason once "Builder" was just a wrapper label around the mode pills — now one flat
  // row of three tabs (see the render body below), moved here from page.tsx since ResumeConfigTab (the
  // former "Library" sub-tab) is now rendered directly by this component instead of a sibling in page.tsx.
  // Choosing "From your profile" or "Start from scratch" both switches this to "builder" *and* writes the
  // role's own resumeMode (via onUpdateRoleRules) — same effect the old mode pills had, just relabeled as a
  // full tab. "Library" needs no role context, so it's the one tab that doesn't touch resumeMode at all.
  const [resumeSubTab, setResumeSubTab] = useState<"builder" | "library">("builder");
  // Content vs Style, nested one level inside "builder" (2026-08-24, operator ask — "these sliders should
  // be on a separate tab... one tab about the content of the page, [one] about the style"). Splits what used
  // to be one long scroll (every section, then the Style sliders at the very bottom) into two — Style no
  // longer eats space in the content tab, and vice versa.
  const [formTab, setFormTab] = useState<"content" | "style">("content");

  // "profile" mode's live draft, kept in memory only — keyed per role so switching role tabs doesn't lose
  // in-progress edits, but nothing here is persisted until Save (see handleSaveProfileResume below).
  const [profileDrafts, setProfileDrafts] = useState<Record<string, ResumeData>>({});
  const [dirtyRoles, setDirtyRoles] = useState<Record<string, boolean>>({});
  // Memoized (2026-08-20, bug fix) — this used to call composeResumeData()/emptyResumeData() inline as a
  // fallback, producing a brand-new object every render until the candidate's first edit seeds
  // profileDrafts. That fed formData below, which the pagination useLayoutEffect depends on: every render
  // re-triggered the effect, which called setPageBreaks/setCurrentPage, which re-rendered, which
  // recomputed this as a new object again — an infinite "Maximum update depth exceeded" loop the instant
  // Builder opened in the default "profile" mode. Memoizing gives it a stable reference across re-renders
  // whenever its actual inputs (active, profileDrafts, candidateProfile) haven't changed.
  const profileDraft = useMemo(
    () => (active ? (profileDrafts[active.id] ?? composeResumeData(candidateProfile, active)) : emptyResumeData()),
    [active, profileDrafts, candidateProfile]
  );

  // The name that'll be used as this role's default-resume filename on the next Save (2026-08-20 — "there
  // should be some area where I could see or change the name," instead of a bare role label like
  // "Automation"). Keyed per role, same pattern as profileDrafts; defaults fresh each time rather than
  // trying to reverse-engineer the current attachment's (sanitized, hyphenated) filename back into a
  // display name.
  const [profileResumeNames, setProfileResumeNames] = useState<Record<string, string>>({});
  const defaultProfileResumeName = active ? `${candidateProfile.name || "My Resume"} — ${active.label}` : "";
  const profileResumeName = active ? (profileResumeNames[active.id] ?? defaultProfileResumeName) : "";
  function setProfileResumeName(name: string) {
    if (!active) return;
    setNameError(null);
    setProfileResumeNames((prev) => ({ ...prev, [active.id]: name }));
  }

  // "profile" mode's chosen template (2026-08-24, operator ask — the inline template picker that used to
  // sit in the "Start from scratch" toolbar moves into the shared Style tab and now applies to "From your
  // profile" too, which previously had no template choice at all (always hardcoded "modern" — see
  // finalizeProfileResumeSave/the auto-default effect below). Keyed per role, same pattern as
  // profileResumeNames; a role that's never had one picked defaults to "modern".
  const [profileTemplateIds, setProfileTemplateIds] = useState<Record<string, ResumeTemplateId>>({});
  const profileTemplateId: ResumeTemplateId = active ? (profileTemplateIds[active.id] ?? "modern") : "modern";
  function setProfileTemplateId(t: ResumeTemplateId) {
    if (!active) return;
    setProfileTemplateIds((prev) => ({ ...prev, [active.id]: t }));
  }

  // Every save blocks on a colliding name rather than silently renaming (2026-08-20, operator ask — "it's
  // better not to have the same names... block and ask me to rename," so nothing, human or the automated
  // send worker, can ever grab the wrong resume by name). Shared across profile-mode Save/Sync and
  // scratch-mode "Use as resume" — see lib/resumeNaming.ts's isNameTaken.
  const [nameError, setNameError] = useState<string | null>(null);

  // "scratch" mode's currently-open ResumeProfile — synced from whichever one this role points at, same
  // debounced-autosave pattern as this component always used.
  const [scratchLabel, setScratchLabel] = useState("");
  const [scratchTemplateId, setScratchTemplateId] = useState<ResumeTemplateId>("modern");
  const [scratchDraft, setScratchDraft] = useState<ResumeData>(emptyResumeData());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emptyImportInputRef = useRef<HTMLInputElement>(null);

  const [syncPromptFor, setSyncPromptFor] = useState<{ diff: ResumeSyncDiff; draft: ResumeData } | null>(null);
  const printAreaRef = useRef<HTMLDivElement>(null);
  const { generate: generateResumePdf, generateDownload, portal: resumePdfPortal, busy: pdfBusy } = useResumeProfilePdf();

  // "Preview as PDF" (2026-08-25, operator ask — "an option alongside Download PDF... a pop-up where you
  // will see the resume... full A4 size"; two same-day follow-ups since — "do not use the default preview
  // provided by the browser... should not be interactive... cover almost the whole height of the screen",
  // then "the page breaks are messed up again... have some inspiration from the normal resume builder page
  // preview... present the PDF as it is presenting it in the resume builder, just bigger"). `previewPdf`
  // is a snapshot of what to show, INCLUDING this component's own already-computed `pageBreaks` (below) —
  // PdfPreviewModal.tsx reuses those exact break points rather than re-measuring on its own; a first attempt
  // that did re-measure independently still disagreed with the live preview by a whole page on a real
  // resume, traced to zoom-dependent sub-pixel rounding drift between the two differently-sized contexts
  // (see PdfPreviewModal.tsx's header comment for the full story). Opening the preview is instant (no
  // render/upload to wait on); the real PDF is only generated lazily, when Download is actually clicked
  // inside the modal (see requestPdfDownload below).
  const [previewPdf, setPreviewPdf] = useState<{ data: ResumeData; templateId: ResumeTemplateId; fileName: string; pageBreaks: number[] } | null>(null);
  function handlePreviewPdf() {
    if (!active) return;
    const label = (isScratchMode ? scratchLabel : profileResumeName) || "Resume";
    setPreviewPdf({ data: formData, templateId: formTemplateId, fileName: label.endsWith(".pdf") ? label : `${label}.pdf`, pageBreaks });
  }
  // Passed to the modal as onRequestDownload — generateDownload() itself doesn't need pdfBusy/toast
  // handling duplicated here; the modal's own handleDownload already catches and toasts a rejection (e.g.
  // "Already generating a PDF" if Save happens to be mid-flight at the same moment).
  function requestPdfDownload() {
    if (!previewPdf) return Promise.reject(new Error("Nothing to download."));
    return generateDownload({ id: "preview", label: previewPdf.fileName, templateId: previewPdf.templateId, data: previewPdf.data });
  }

  // Real pagination for the live preview (2026-08-20, bug fix; layout rewritten 2026-08-20, second bug fix
  // — see lib/resumePaginate.ts for the self-correcting scale factor this depends on). Re-measured
  // whenever the rendered content changes size, whether from typing (formData) or a template swap.
  const previewContentRef = useRef<HTMLDivElement>(null);
  const [pageBreaks, setPageBreaks] = useState<number[]>([]);
  const [atomPage, setAtomPage] = useState<Record<string, number>>({});
  const [currentPage, setCurrentPage] = useState(0);

  // The page window (2026-08-20) — the preview is now a fixed, non-scrolling single-page viewport ("the
  // resume page should always be visible in front of me... one page should be visible at a time," operator
  // ask) rather than one long scrolling image with dashed dividers. `.resume-print-area` is a fixed,
  // real-world-sized (210mm × 297mm) window with `overflow:hidden`; `previewContentRef` (holding the full,
  // all-pages-concatenated render) shifts up via `translateY` to reveal only the current page. `fitScale`
  // shrinks that fixed-size window to whatever room is actually available, via CSS `zoom` (not `transform`)
  // — zoom shrinks the element's own reserved layout footprint along with its visual size, so the flex box
  // around it sizes correctly with no extra placeholder-box bookkeeping (transform would only shrink the
  // paint, leaving a full-size hole in the layout). This is unrelated to, and doesn't fix on its own, the
  // page-break value bug — that's fixed inside computePageBreaks itself so its output is safe to reapply as
  // a local translateY under either mechanism.
  const previewViewportRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(1);
  const editorScrollRef = useRef<HTMLDivElement>(null);

  // `justHydratedScratch` (2026-08-25, CRITICAL data-loss bug fix) — guards a real race between this
  // effect and the debounced autosave effect right below it. Both effects run in the same commit whenever
  // `scratchProfile` is already resolved (non-null) on the very render that first mounts/switches to it —
  // not just on ordinary mount, but on ANY render where `scratchProfile?.id` changes to a value this
  // effect hasn't hydrated from yet. This effect's `setScratchLabel`/`setScratchTemplateId`/`setScratchDraft`
  // calls only take effect on the *next* render — the autosave effect below, running immediately after in
  // this same pass, still closes over the *current* render's stale `scratchLabel`/`scratchTemplateId`/
  // `scratchDraft` (this component's plain `useState` defaults: `""` / `"modern"` / `emptyResumeData()`
  // the very first time, or whatever the *previous* scratch resume's values were on a later switch) — and
  // schedules an 800ms save of THAT stale/blank state, not the real data just loaded. A fast enough
  // cascading re-render normally cancels that stale timer before it fires (the autosave effect's own
  // cleanup clears it once real values propagate) — but there's no guarantee of "fast enough", and when it
  // isn't, the real saved resume gets silently overwritten with blanks 800ms after load. Confirmed for
  // real, not just in theory — a live resume with 8 certifications, dozens of skills, 4 experience entries
  // and 8 projects was found wiped to completely empty in Supabase, `updated_at` landing seconds after a
  // page load. Fix: a ref (synchronous, unlike setState — visible to the autosave effect in the very same
  // pass) marks "the value I just hydrated FROM is the one autosave is about to see, so let this one pass
  // through unsaved" every time this effect loads real data; the autosave effect below checks and consumes
  // it before ever starting a save timer.
  const justHydratedScratch = useRef(false);
  useEffect(() => {
    if (scratchProfile) {
      setScratchLabel(scratchProfile.label);
      setScratchTemplateId(scratchProfile.templateId);
      setScratchDraft(scratchProfile.data);
      justHydratedScratch.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scratchProfile?.id]);

  // A stale "name already taken" error from a previous role/mode shouldn't linger after switching away.
  useEffect(() => { setNameError(null); }, [active?.id, activeMode]);

  // Debounced auto-save — a resume has too many fields for a "Save" button per edit to be pleasant. Only
  // touches the scratch ResumeProfile row; "profile" mode's draft is never auto-saved (see decision above).
  // See justHydratedScratch above — this must never fire on the same pass that just loaded scratchProfile's
  // real data into local state, or it saves stale/blank state right back over it.
  useEffect(() => {
    if (!scratchProfile) return;
    if (justHydratedScratch.current) { justHydratedScratch.current = false; return; }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onSave({ id: scratchProfile.id, label: scratchLabel, templateId: scratchTemplateId, data: scratchDraft });
    }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scratchLabel, scratchTemplateId, scratchDraft]);

  // Zero-click default resume (2026-08-20, operator ask — "should always be in our library but we do not
  // have to manually save it"). The moment a role is opened here in "profile" mode and nothing resolves
  // for it at all (no override of its own, no candidate-wide fallback either — see
  // lib/emailResolve.ts's resolveRoleResume), silently compose-and-save one right away, exactly like
  // clicking Save with zero edits would. Scoped to "the moment I open that role in Builder" per the
  // operator's confirmed choice — a role never opened here still has nothing until it is, same as today.
  // PDF generation only happens in the browser (html2canvas), so this can't be done from the background
  // send worker — visiting Builder is what triggers it. attemptedRoles guards against retrying every
  // render; a failed attempt is removed so the next visit can retry.
  const attemptedAutoDefaultRoles = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!userId || !active || activeMode !== "profile") return;
    if (attemptedAutoDefaultRoles.current.has(active.id)) return;
    if (resolveRoleResume(active, candidateProfile)) return; // something already resolves — nothing to do
    attemptedAutoDefaultRoles.current.add(active.id);
    const roleId = active.id;
    const draft = composeResumeData(candidateProfile, active);
    const name = uniqueNameFallback(`${candidateProfile.name || "My Resume"} — ${active.label}`, candidateProfile.files, "profile");
    (async () => {
      try {
        const attachment = await generateResumePdf({ id: "auto", label: name, templateId: "modern", data: draft }, userId);
        const tagged: Attachment = { ...attachment, sourceRoleId: roleId };
        onProfileChange({ ...candidateProfile, files: [...candidateProfile.files, tagged] });
        onUpdateRoleRules(roleId, { resumeId: tagged.id });
      } catch (e) {
        attemptedAutoDefaultRoles.current.delete(roleId); // let the next visit retry
        console.error("Auto-generating the default resume failed:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, activeMode, userId]);

  const isScratchMode = activeMode === "scratch";
  const formData = isScratchMode ? scratchDraft : profileDraft;
  const formTemplateId: ResumeTemplateId = isScratchMode ? scratchTemplateId : profileTemplateId;
  function formOnChange(patch: Partial<ResumeData>) {
    if (isScratchMode) setScratchDraft((d) => ({ ...d, ...patch }));
    else updateProfileDraft(patch);
  }
  function formTemplateOnChange(t: ResumeTemplateId) {
    if (isScratchMode) setScratchTemplateId(t);
    else setProfileTemplateId(t);
  }

  // Measures the live preview after every render where content could have changed size — typing, template
  // swap, style-setting change, or switching role/mode. A ResizeObserver catches anything else (font
  // metrics settling, viewport resize). Deliberately NOT keyed on pageBreaks/currentPage/atomPage
  // themselves, so setting that state here never re-triggers this effect. See lib/resumePaginate.ts.
  useLayoutEffect(() => {
    const el = previewContentRef.current;
    if (!el) return;
    function measure() {
      if (!el) return;
      // Page-height needs the live padding setting (2026-08-20, bug fix) — computePageBreaks can't see it
      // on its own since `el` (previewContentRef) is deliberately unpadded; see lib/resumePaginate.ts.
      const paddingPx = mmToPx((formData.style ?? defaultResumeStyle()).pagePaddingMm);
      const { breaks, atomPage: nextAtomPage } = computePageBreaks(el, paddingPx);
      // Skip the state update when nothing actually changed (2026-08-20, defensive hardening alongside the
      // profileDraft memoization fix above) — computePageBreaks always returns new object/array references,
      // so without this a render triggered for any unrelated reason would still cause a state update here.
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
  }, [formData, formTemplateId]);

  // Shrinks the fixed-size (210mm × 297mm) page window to whatever room is actually available in the
  // right column, via CSS `zoom` (see the state declaration above for why zoom, not transform). Only the
  // *available* side needs watching — the window's own native size is a constant CSS value, confirmed
  // stable regardless of the zoom currently applied (offsetWidth/offsetHeight ignore zoom).
  useEffect(() => {
    const viewport = previewViewportRef.current;
    const page = printAreaRef.current;
    if (!viewport || !page) return;
    function recompute() {
      if (!viewport || !page || !page.offsetWidth || !page.offsetHeight) return;
      // Shave a fixed slack off the available height (2026-08-24, bug fix — "the page should not be
      // touching the bottom of the screen") before fitting the page into it, rather than fitting to the
      // viewport's full clientHeight — the flex centering below then splits that slack into a real gap on
      // both sides instead of the page landing flush with the pane's edges.
      const availH = Math.max(viewport.clientHeight - 24, 0);
      const scale = Math.min(viewport.clientWidth / page.offsetWidth, availH / page.offsetHeight, 1);
      setFitScale((prev) => (Math.abs(prev - scale) < 0.001 ? prev : scale));
    }
    recompute();
    // A second pass one frame later (2026-08-24, defensive hardening — operator report of the page getting
    // cut off with no way to reach the rest of it, not reproduced locally across several window sizes, but
    // cheap to guard against regardless) — catches the page window ever measuring 0 on the very first
    // synchronous call (recompute() no-ops in that case, per the guard above) before its real box has been
    // laid out, which would otherwise leave fitScale stuck at its initial default of 1 (full native size,
    // taller than most panes) until the next unrelated resize happened to fire the observer.
    const raf = requestAnimationFrame(recompute);
    const ro = new ResizeObserver(recompute);
    ro.observe(viewport);
    // Belt-and-suspenders alongside the ResizeObserver above, which already reacts to the browser window
    // resizing (that's what changes `viewport`'s own size) — an explicit listener costs nothing and covers
    // it even if some intermediate layout step ever doesn't bubble into a ResizeObserver callback.
    window.addEventListener("resize", recompute);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, []);

  // Scroll-linked page auto-sync (2026-08-20, operator ask — "if I am scrolling up and the editor hits the
  // point where the resume page has no relevant content... it will automatically shift to the next page").
  // Plain scroll-position polling (rAF-throttled), not IntersectionObserver — an observer only reports
  // unordered "near-visible" booleans, still needing a getBoundingClientRect() pass afterward to rank atoms
  // by position, so a direct scroll handler does the same job in one pass with no rootMargin tuning. Finds
  // the last editor-side [data-atom-key] element (same keys as the preview templates' atoms, matched via
  // atomPage) whose top has scrolled at or above ~28% down the editor's own viewport, and switches the
  // preview to whichever page that atom's corresponding content landed on. Manual prev/next (goToPage)
  // just calls setCurrentPage directly — the next scroll event here naturally re-syncs afterward, no
  // "pinned" mode needed.
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
          else break; // atoms are in DOM order top-to-bottom — once past the trigger line, we're done
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

  function updateProfileDraft(patch: Partial<ResumeData>) {
    if (!active) return;
    setProfileDrafts((prev) => ({
      ...prev,
      [active.id]: { ...(prev[active.id] ?? composeResumeData(candidateProfile, active)), ...patch },
    }));
    setDirtyRoles((prev) => ({ ...prev, [active.id]: true }));
  }

  // ---- Mode: "profile" — compose, edit, Save (with the sync-to-profile prompt) ----

  async function handleSaveProfileResume() {
    if (!userId || !active) return;
    const currentDraft = profileDrafts[active.id] ?? composeResumeData(candidateProfile, active);
    const diff = diffResumeAgainstProfile(candidateProfile, active, currentDraft);
    if (diff.hasChanges) {
      setSyncPromptFor({ diff, draft: currentDraft });
      return;
    }
    // No edits since last save — still the same resume, so it's fine to regenerate/replace it in place
    // (excludes itself from the collision check below; renaming "itself" back to its own current name
    // isn't a collision). See finalizeProfileResumeSave's `alwaysNewInstance` param.
    const prevFile = active.resumeId ? candidateProfile.files.find((f) => f.id === active.resumeId) : null;
    const excludeId = prevFile && prevFile.sourceRoleId === active.id ? prevFile.id : undefined;
    if (isNameTaken(profileResumeName, candidateProfile.files, "profile", excludeId)) {
      setNameError(`"${profileResumeName.trim()}" is already used by another resume based on your profile — pick a different name.`);
      return;
    }
    await finalizeProfileResumeSave(currentDraft, candidateProfile, {}, profileResumeName, true, false);
  }

  // "Save to Profile & Role" and "Just this resume" both always create a new, separately named Library
  // entry now (2026-08-20, operator ask — "then it will create another instance, the resume in the
  // library will stay as it is") — editing and syncing no longer silently overwrites what was there
  // before. The only real difference between the two is whether the edits also get merged back into the
  // shared Profile/Role selections; either way this role's `resumeId` moves to point at the fresh
  // instance, and nothing already in the Library is touched. See finalizeProfileResumeSave's
  // `alwaysNewInstance` param and SyncResumeModal.tsx's name prompt (now shown for both choices when
  // needed).
  async function handleSyncChoice(choice: "sync" | "local", name: string) {
    if (!syncPromptFor || !active) return;
    const { draft: draftData } = syncPromptFor;
    setSyncPromptFor(null);
    if (choice === "sync") {
      const { profile: mergedProfile, roleDefPatch } = mergeResumeIntoProfile(candidateProfile, active, draftData);
      await finalizeProfileResumeSave(draftData, mergedProfile, roleDefPatch, name, true, true);
    } else {
      await finalizeProfileResumeSave(draftData, candidateProfile, {}, name, false);
    }
  }

  // One onProfileChange + one onUpdateRoleRules call, no matter which path got here — calling either
  // setter twice in the same action risks the second call clobbering the first with a stale closure
  // (React hasn't re-rendered with the new props yet), so every field that needs to change lands in a
  // single combined patch instead.
  //
  // `keepAsDefault`: true points this role's resumeId at the result (the usual "this is my resume" path);
  // false leaves resumeId untouched — "Just this resume" adds a named Library entry without changing what
  // the role currently sends.
  // `alwaysNewInstance` (2026-08-20): true always appends a brand-new Attachment and never deletes/
  // overwrites an existing one, even when keepAsDefault is also true — used by the sync path, since real
  // edits were made and the previous entry should stay exactly as it was. false (the default) keeps the
  // original "no edits, just re-save" behavior of replacing the same entry in place when it was this
  // role's own previous save.
  async function finalizeProfileResumeSave(
    draftData: ResumeData,
    baseProfile: CandidateProfile,
    extraRoleDefPatch: Partial<RoleDef>,
    label: string,
    keepAsDefault: boolean,
    alwaysNewInstance: boolean = false
  ) {
    if (!userId || !active) return;
    const trimmed = label.trim();
    if (!trimmed) {
      setNameError("Give this resume a name before saving.");
      return;
    }
    const prevFile = active.resumeId ? baseProfile.files.find((f) => f.id === active.resumeId) : null;
    const replaceInPlace = keepAsDefault && !alwaysNewInstance && !!(prevFile && prevFile.sourceRoleId === active.id);
    // Defense in depth — the callers above already checked this against the pre-save state so the operator
    // sees the error before any PDF gets generated; re-checking here catches the rare race where files
    // changed in between (e.g. another tab).
    if (isNameTaken(trimmed, baseProfile.files, "profile", replaceInPlace ? prevFile?.id : undefined)) {
      setNameError(`"${trimmed}" is already used by another resume based on your profile — pick a different name.`);
      return;
    }
    setNameError(null);
    try {
      const attachment = await generateResumePdf({ id: "auto", label: trimmed, templateId: profileTemplateId, data: draftData }, userId);
      const tagged: Attachment = { ...attachment, sourceRoleId: active.id };
      if (keepAsDefault) {
        if (replaceInPlace && prevFile) deleteAttachment(prevFile.storagePath).catch(console.error);
        const nextFiles = replaceInPlace && prevFile
          ? baseProfile.files.map((f) => (f.id === prevFile.id ? tagged : f))
          : [...baseProfile.files, tagged];
        onProfileChange({ ...baseProfile, files: nextFiles });
        onUpdateRoleRules(active.id, { ...extraRoleDefPatch, resumeId: tagged.id });
        toast.success(`Saved — set as ${active.label}'s resume.`);
      } else {
        onProfileChange({ ...baseProfile, files: [...baseProfile.files, tagged] });
        if (Object.keys(extraRoleDefPatch).length > 0) onUpdateRoleRules(active.id, extraRoleDefPatch);
        toast.success(`Saved "${trimmed}" to your Library.`);
      }
      setDirtyRoles((prev) => ({ ...prev, [active.id]: false }));
    } catch (e: any) {
      toast.error(e?.message || "Failed to save the resume.");
    }
  }

  // ---- Mode: "scratch" — today's ordinary builder, scoped to a role, no outside effects ----

  async function handleStartScratch() {
    if (!active) return;
    const saved = await onSave({ label: `${active.label} (from scratch)`, templateId: "modern", data: seedFromCandidate(candidateProfile) });
    if (saved) {
      onUpdateRoleRules(active.id, { scratchResumeProfileId: saved.id });
      toast.success("Resume started.");
    }
  }

  async function handleDeleteScratch() {
    if (!active || !scratchProfile) return;
    if (!window.confirm(`Delete "${scratchProfile.label}"? This can't be undone.`)) return;
    await onDelete(scratchProfile.id);
    onUpdateRoleRules(active.id, { scratchResumeProfileId: null });
    toast.success("Resume deleted.");
  }

  async function handleUseScratchAsResume() {
    if (!userId || !active || !scratchProfile) return;
    // Same block-and-ask name guard as profile mode's Save (2026-08-20) — this always appends a new
    // Attachment too, named from the "Resume name" field above (scratchLabel).
    if (isNameTaken(scratchLabel, candidateProfile.files, "scratch")) {
      setNameError(`"${scratchLabel.trim()}" is already used by another resume created from scratch — pick a different name.`);
      return;
    }
    setNameError(null);
    try {
      const attachment = await generateResumePdf(scratchProfile, userId);
      const tagged: Attachment = { ...attachment, sourceResumeProfileId: scratchProfile.id };
      onProfileChange({ ...candidateProfile, files: [...candidateProfile.files, tagged] });
      onUpdateRoleRules(active.id, { resumeId: tagged.id });
      toast.success(`Set as ${active.label}'s resume.`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to generate the resume PDF.");
    }
  }

  async function handleImport(file: File) {
    if (!ai.enabled) {
      toast.error("Enable AI Personalization on the AI tab first.");
      return;
    }
    setImporting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/resume-import", {
        method: "POST",
        headers: session ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        body: formData,
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Import failed.");
      setScratchDraft((d) => ({ ...d, ...json.data }));
      toast.success("Imported — review the fields below before saving.");
    } catch (e: any) {
      toast.error(e?.message || "Failed to import resume.");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // The empty-state's "✨ Import from an existing resume" (2026-08-20 — given equal billing next to
  // "+ Start a resume" instead of a small toolbar button only visible once a blank draft already exists).
  // No scratch ResumeProfile exists yet at this point, so this creates one seeded directly with the
  // imported fields in one step, rather than creating-then-merging (avoids racing the prop round-trip
  // that would otherwise decide when `scratchProfile` below reflects the new row).
  async function handleImportFromEmptyState(file: File) {
    if (!active) return;
    if (!ai.enabled) {
      toast.error("Enable AI Personalization on the AI tab first.");
      return;
    }
    setImporting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/resume-import", {
        method: "POST",
        headers: session ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        body: formData,
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Import failed.");
      const saved = await onSave({
        label: `${active.label} (from scratch)`,
        templateId: "modern",
        data: { ...seedFromCandidate(candidateProfile), ...json.data },
      });
      if (!saved) throw new Error("Failed to save the imported resume.");
      onUpdateRoleRules(active.id, { scratchResumeProfileId: saved.id });
      toast.success("Imported — review the fields below before saving.");
    } catch (e: any) {
      toast.error(e?.message || "Failed to import resume.");
    } finally {
      setImporting(false);
      if (emptyImportInputRef.current) emptyImportInputRef.current.value = "";
    }
  }

  function handleDownload() {
    window.print();
  }

  // `previewFooterExtra` (2026-08-25, operator ask — "the download PDF button should be at the bottom of
  // the resume... the same goes with the delete button") — Download PDF used to live in `extraControls`
  // (profile mode) or the toolbar `header` (scratch mode), both inside the *editor* column; Delete lived in
  // that same scratch-mode toolbar. Both read as scattered next to unrelated controls (name field, template
  // picker) rather than acting on the resume itself. Now Download PDF is always rendered here, directly
  // under the preview's page window (the right column, i.e. "the resume"); `previewFooterExtra` lets a
  // caller add a mode-specific action beside it — only scratch mode has one (Delete).
  // `previewHeaderExtra` (2026-08-25, same-day follow-up, operator ask — "put the save button at the top
  // of the [resume] and alongside the arrow that are shifting the page") — same idea, mirrored to the top:
  // profile mode's "Save" button used to live in `extraControls`, at the bottom of the *editor* column, far
  // from the ‹ Page X of Y › nav that already sits at the top of the preview column. Now it renders in that
  // same top row, beside the page-nav arrows. Scratch mode has no equivalent here — its primary action
  // ("Use as X's resume") stays in the toolbar `header` (see the "useless button" clarification above; the
  // operator confirmed that one wasn't in scope for relocation).
  function renderFormAndPreview(header: React.ReactNode, extraControls: React.ReactNode, previewFooterExtra?: React.ReactNode, previewHeaderExtra?: React.ReactNode) {
    const PreviewTemplate = TEMPLATES[formTemplateId].Component;
    const pageCount = Math.max(pageBreaks.length, 1);
    const style = formData.style ?? defaultResumeStyle();
    const startPx = currentPage > 0 ? (pageBreaks[currentPage - 1] ?? 0) : 0;
    // How tall *this* page's actual content is (2026-08-20, second page-break bug fix) — not always a full
    // page: computePageBreaks may stop a page short of pageHeightPx when the next atom doesn't fit in the
    // remainder. The clip window below used to always clip at a constant full-page height regardless, which
    // meant that leftover remainder simply showed the *start* of the next page's content early (confirmed
    // via DOM measurement — a whole extra entry bleeding onto the "wrong" page, duplicated with what the
    // next page then also showed starting from the same break). Sizing the inner clip to this page's real
    // span, not a constant, is what actually makes the chosen break points take effect on screen.
    const endPx = pageBreaks[currentPage] ?? startPx;
    const thisPageContentPx = Math.max(endPx - startPx, 0);
    return (
      <div style={{ display: "flex", gap: "1.25rem", alignItems: "stretch", flexWrap: "nowrap", flex: "1 1 auto", minHeight: 0 }}>
        {/* The only scrolling pane now (2026-08-20 layout rewrite) — "the side where you edit information
            about the resume will be scrollable... I should be only able to scroll the content on the left
            side," operator ask. Scrolling this drives the preview's page via the scroll-sync effect above.
            `header` (resume name / import toolbar, moved in 2026-08-20 to reclaim height for the preview —
            "the resume is too small," operator report) scrolls away with everything else instead of sitting
            as fixed chrome above both columns. */}
        <div ref={editorScrollRef} className="no-print" style={{ flex: "1 1 420px", minWidth: "320px", minHeight: 0, overflowY: "auto", paddingRight: "0.25rem" }}>
          {header}
          {/* Content vs Style (2026-08-24) — see the formTab state comment above. Sticky (2026-08-24,
              second same-day follow-up, operator ask — "the content and style need to be sticky, same as
              the other options like from your profile") so it stays reachable while scrolling through a
              long form instead of scrolling away with the header above it; `top:0` pins it to the top of
              this pane's own scroll container (editorScrollRef), not the page. Needs an opaque background
              matching its surroundings (the cream `--bg`, not the white `--bg-panel` the panels below use)
              so content scrolling underneath doesn't show through. Style has no data-atom-key content of
              its own, so the scroll-sync effect simply finds nothing to sync while it's open, which is fine
              — there's no preview page it could correspond to. */}
          <div role="tablist" style={{ display: "flex", gap: "0.4rem", marginBottom: "0.7rem", position: "sticky", top: 0, zIndex: 1, background: "var(--bg)", paddingTop: "0.1rem", paddingBottom: "0.3rem" }}>
            <button type="button" role="tab" aria-selected={formTab === "content"} className={`btn ${formTab === "content" ? "primary" : "ghost"}`} style={{ fontSize: "0.8rem" }} onClick={() => setFormTab("content")}>Content</button>
            <button type="button" role="tab" aria-selected={formTab === "style"} className={`btn ${formTab === "style" ? "primary" : "ghost"}`} style={{ fontSize: "0.8rem" }} onClick={() => setFormTab("style")}>Style</button>
          </div>
          {formTab === "content" ? (
            <>
              <PersonalInfoSection data={formData} onChange={formOnChange} />
              <SummarySection data={formData} onChange={formOnChange} />
              <ExperienceSection data={formData} onChange={formOnChange} />
              <ProjectsSection data={formData} onChange={formOnChange} />
              <EducationSection data={formData} onChange={formOnChange} />
              <SkillsSection data={formData} onChange={formOnChange} />
              <CertificationsSection data={formData} onChange={formOnChange} />
              <LanguagesSection data={formData} onChange={formOnChange} />
            </>
          ) : (
            <StyleSection
              style={style}
              onChange={(patch) => formOnChange({ style: { ...style, ...patch } })}
              templateId={formTemplateId}
              onTemplateChange={formTemplateOnChange}
            />
          )}
          {extraControls}
        </div>

        {/* Never scrolls in the normal case (2026-08-20 layout rewrite) — "the resume page should always be
            visible in front of me. It should not be scrollable. One page should be visible at a time,"
            operator ask. `flex: "0 1 480px"` (2026-08-24, bug fix — was "1 1 480px", growing equally with
            the editor column) — the page's own fixed A4 aspect ratio means it can only ever use extra
            *width* up to what its available *height* already limits it to, so on a wide/short viewport the
            old equal-grow gave this column far more width than the page could ever use, reading as dead
            space beside it ("there is a lot of space on the right side... not being used," operator report)
            instead of going to the editor column, which can always use more room for its form fields. */}
        <div style={{ flex: "0 1 480px", minWidth: "320px", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* Top-of-the-resume bar (2026-08-25) — see renderFormAndPreview's previewHeaderExtra comment
              above. Renders whenever there's something to show: previewHeaderExtra (profile mode's Save),
              the page-nav arrows (only once there's more than one page), or both together. */}
          {(previewHeaderExtra || pageCount > 1) && (
            <div className="no-print" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem", fontSize: "0.8rem" }}>
              {previewHeaderExtra}
              {pageCount > 1 && (
                <>
                  <button type="button" className="btn ghost" style={{ padding: "0.15rem 0.55rem" }} disabled={currentPage === 0} onClick={() => goToPage(currentPage - 1)}>‹</button>
                  <span className="hint compact" style={{ margin: 0 }}>Page {currentPage + 1} of {pageCount}</span>
                  <button type="button" className="btn ghost" style={{ padding: "0.15rem 0.55rem" }} disabled={currentPage >= pageCount - 1} onClick={() => goToPage(currentPage + 1)}>›</button>
                </>
              )}
            </div>
          )}
          {/* The available space this fixed-size page window fits itself into — see the fitScale effect
              above (ResizeObserver on this element, compared against the page window's own constant native
              size). `overflowY: "auto"` (2026-08-24, defensive fix — operator report: "the resume page
              itself is being cut from the bottom, I am unable to scroll it") — fitScale is *meant* to always
              shrink the page to fit inside here with room to spare, so in the normal case nothing overflows
              and this is a no-op; if it's ever wrong (a stale scale from before a real window resize, a
              measurement race, anything), the page becomes reachable by scrolling instead of being silently
              clipped and stuck with no way to see the rest. */}
          <div ref={previewViewportRef} style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflowY: "auto", overflowX: "hidden" }}>
            {/* The page window — real A4 size, overflow:hidden, shrunk via `zoom` to fit the space above.
                No more dashed-line markers: this window IS the page boundary now. */}
            <div
              ref={printAreaRef}
              className="resume-print-area"
              style={{ width: "210mm", height: "297mm", overflow: "hidden", display: "flex", flexDirection: "column", zoom: fitScale } as React.CSSProperties}
            >
              {/* Top/bottom padding as fixed spacer divs, NOT as padding on the clipping/sliding element
                  itself (2026-08-20, page-break bug fix) — CSS padding doesn't clip an overflowing sibling,
                  it only reserves space for content that fits within it, so when padding lived on this same
                  element as the translateY + overflow:hidden below, the tail end of the *previous* page's
                  content (whatever fell within the last paddingMm of it) kept bleeding into — and repainting
                  over — what was supposed to be this page's blank top margin (confirmed via DOM measurement:
                  the last two bullets of one entry were visibly duplicated at the top of the next page).
                  These spacers sit outside the clipped region, so nothing can ever render into them. */}
              <div style={{ height: `${style.pagePaddingMm}mm`, flexShrink: 0 }} />
              <div className="resume-print-clip" style={{ flex: "1 1 auto", minHeight: 0, overflow: "hidden", paddingLeft: `${style.pagePaddingMm}mm`, paddingRight: `${style.pagePaddingMm}mm` }}>
                {/* Clipped to this page's *actual* content height, not the full page height (see the
                    thisPageContentPx comment above) — leaves genuine blank space for a short page instead
                    of peeking into the next page's content. className is a print-only hook (globals.css
                    resets both this and the outer clip for "Download PDF"). */}
                <div className="resume-print-page-slice" style={{ height: `${thisPageContentPx}px`, overflow: "hidden" }}>
                  {/* Shifted up to reveal only the current page — pageBreaks is native-space px (see
                      lib/resumePaginate.ts), safe to reuse directly as a local translateY under `zoom`. */}
                  <div ref={previewContentRef} className="resume-print-content" style={{ transform: `translateY(-${startPx}px)` }}>
                    <PreviewTemplate data={formData} />
                  </div>
                </div>
              </div>
              <div style={{ height: `${style.pagePaddingMm}mm`, flexShrink: 0 }} />
            </div>
          </div>
          {/* Bottom-of-the-resume action bar (2026-08-25) — see renderFormAndPreview's previewFooterExtra
              comment above. "Preview as PDF" (same day, operator ask) sits right beside Download PDF — opens
              instantly (see handlePreviewPdf above), no loading state needed on this button itself. */}
          <div className="no-print" style={{ display: "flex", gap: "0.5rem", justifyContent: "center", marginTop: "0.6rem" }}>
            <button type="button" className="btn ghost" style={{ fontSize: "0.85rem" }} onClick={handlePreviewPdf}>Preview as PDF</button>
            <button type="button" className="btn ghost" style={{ fontSize: "0.85rem" }} onClick={handleDownload}>Download PDF</button>
            {previewFooterExtra}
          </div>
        </div>
      </div>
    );
  }

  if (roleDefs.length === 0) {
    return <p className="hint compact">No roles yet — add one on the Roles tab first.</p>;
  }
  if (!active) return null;

  return (
    // Fixed-height chain (2026-08-20 layout rewrite) — flex:1/minHeight:0/height:100% all the way down
    // from page.tsx's Resumes-tab wrapper through here to the two-pane row is what lets the editor column
    // scroll independently and the preview column fit-without-scrolling, instead of .main-content scrolling
    // the whole builder view as one piece. A single missed link in this chain breaks it silently (content
    // just grows past the viewport again) — see docs/architecture.md's dated follow-up for the full chain.
    <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, height: "100%" }}>
      {/* Three flat tabs (2026-08-24 UI pass) — replaces the old two-row "Builder"/"Library" pair stacked
          above a separate "From your profile"/"Start from scratch" pill row (see the resumeSubTab/formTab
          state comments above for the full rationale). Picking either builder mode both switches this row
          and writes the role's own resumeMode, same as the old pills did; "Library" is role-agnostic. */}
      <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
        <div role="tablist" style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
          {MODE_PILLS.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={resumeSubTab === "builder" && activeMode === m}
              className={`btn ${resumeSubTab === "builder" && activeMode === m ? "primary" : "ghost"}`}
              onClick={() => { setResumeSubTab("builder"); onUpdateRoleRules(active.id, { resumeMode: m }); }}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={resumeSubTab === "library"}
            className={`btn ${resumeSubTab === "library" ? "primary" : "ghost"}`}
            onClick={() => setResumeSubTab("library")}
          >
            Library
          </button>
          {resumeSubTab === "builder" && activeMode === "profile" && dirtyRoles[active.id] && (
            <span className="badge warn" style={{ fontSize: "0.68rem" }}>Unsaved changes</span>
          )}
        </div>
        {/* Role switcher (2026-08-24) — was its own full-width tab row above; moved beside the tabs above
            to reclaim height. Always a real, visibly-interactive dropdown now (2026-08-24, second same-day
            follow-up, operator ask — "AI Automation is not a title, it's like a drop-down... it should be
            visible, same as the other buttons") — reverses the first pass's "collapses to plain static text
            with only one role" choice: styled with the same `.btn` treatment as the tabs beside it (border,
            padding, weight) instead of native/unstyled, so it always reads as a control, one-option case
            included. Hidden for Library, which shows every role's resumes together, not just this one's.
            "Import from a resume" (2026-08-25, operator ask — "the import from resume button should be on
            the left side of AI automation") moved here from the scratch-mode toolbar, right of the tabs and
            directly left of this dropdown; only meaningful in scratch mode with a resume already started
            (the empty state has its own dedicated import CTA — handleImportFromEmptyState — this one
            (handleImport) only ever targets an existing scratchDraft). */}
        {resumeSubTab === "builder" && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {activeMode === "scratch" && scratchProfile && (
              <>
                <input ref={fileInputRef} type="file" accept="application/pdf" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImport(f); }} />
                <button
                  type="button"
                  className="btn ghost"
                  style={{ fontSize: "0.85rem", color: "var(--accent)" }}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing || !ai.enabled}
                  title={ai.enabled ? "Import from an existing PDF resume (AI-powered)" : "Enable AI Personalization on the AI tab first"}
                >
                  {importing ? "Importing…" : "✨ Import from a resume"}
                </button>
              </>
            )}
            <select value={activeRole} onChange={(e) => onActiveRoleChange(e.target.value as Role)} className="btn ghost" style={{ fontSize: "0.85rem" }}>
              {roleDefs.map((def) => <option key={def.key} value={def.key}>{def.label}</option>)}
            </select>
          </div>
        )}
      </div>

      {resumeSubTab === "builder" && activeMode === "profile" && (
        renderFormAndPreview(
          <>
            <p className="hint compact no-print" style={{ marginTop: 0, marginBottom: "0.7rem" }}>
              Composed from {active.label}&apos;s selection on the <strong>Roles</strong> tab — edit anything
              below, then Save. No AI involved; it&apos;s only ever what&apos;s already selected there.
            </p>
            <label className="field no-print" style={{ maxWidth: "360px", marginBottom: nameError ? "0.3rem" : "0.9rem" }}>
              <span>Resume name</span>
              <input
                type="text"
                value={profileResumeName}
                onChange={(e) => setProfileResumeName(e.target.value)}
                placeholder={defaultProfileResumeName}
              />
            </label>
            {nameError && <p className="hint compact no-print" style={{ color: "var(--danger)", marginBottom: "0.9rem" }}>{nameError}</p>}
          </>,
          null,
          undefined,
          <button type="button" className="btn primary" style={{ fontSize: "0.85rem" }} disabled={pdfBusy} onClick={handleSaveProfileResume}>
            {pdfBusy ? "Saving…" : "Save"}
          </button>
        )
      )}

      {resumeSubTab === "builder" && activeMode === "scratch" && (
        !scratchProfile ? (
          <div style={{ padding: "2rem", textAlign: "center" }}>
            <p className="hint" style={{ marginBottom: "1rem" }}>No resume started from scratch yet for {active.label}.</p>
            <div style={{ display: "flex", gap: "0.6rem", justifyContent: "center", flexWrap: "wrap" }}>
              <button type="button" className="btn primary" onClick={handleStartScratch}>+ Start a resume</button>
              <input
                ref={emptyImportInputRef}
                type="file"
                accept="application/pdf"
                className="sr-only"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFromEmptyState(f); }}
              />
              <button
                type="button"
                className="btn"
                style={{ color: "var(--accent)" }}
                onClick={() => emptyImportInputRef.current?.click()}
                disabled={importing || !ai.enabled}
                title={ai.enabled ? "Import from an existing PDF resume (AI-powered)" : "Enable AI Personalization on the AI tab first"}
              >
                {importing ? "Importing…" : "✨ Import from an existing resume"}
              </button>
            </div>
          </div>
        ) : (
          renderFormAndPreview(
            <>
              {/* Trimmed down (2026-08-25, operator ask) — the template picker moved into the Style tab
                  (see StyleSection), and Import/Delete/Download PDF moved out of this toolbar entirely:
                  Import sits beside the role dropdown above ("on the left side of AI automation"), Delete
                  and Download PDF sit below the preview ("at the bottom of the resume") — see
                  renderFormAndPreview's previewFooterExtra param and the outer role-switcher block above.
                  What's left here is just the resume's own name and the primary "commit this as the role's
                  resume" action. */}
              <div className="no-print" style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap", marginBottom: nameError ? "0.3rem" : "0.9rem" }}>
                <input
                  type="text"
                  value={scratchLabel}
                  onChange={(e) => { setNameError(null); setScratchLabel(e.target.value); }}
                  placeholder="Resume name"
                  style={{ fontSize: "0.85rem", width: "160px" }}
                />
                <span style={{ marginLeft: "auto", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <button type="button" className="btn primary" style={{ fontSize: "0.8rem" }} disabled={pdfBusy} onClick={handleUseScratchAsResume}>
                    {pdfBusy ? "Generating…" : `Use as ${active.label}'s resume`}
                  </button>
                </span>
              </div>
              {nameError && <p className="hint compact no-print" style={{ marginTop: "-0.6rem", marginBottom: "0.9rem", color: "var(--danger)" }}>{nameError}</p>}
            </>,
            null,
            <button type="button" className="btn ghost danger" style={{ fontSize: "0.85rem" }} onClick={handleDeleteScratch}>Delete</button>
          )
        )
      )}

      {/* "Library" (2026-08-24) — was rendered by page.tsx as a sibling of this whole component, switched
          by a separate resumeSubTab state living there; moved in here so it's just the third tab of the one
          unified row above instead of two components coordinating through a prop page.tsx had to own. */}
      {resumeSubTab === "library" && (
        <ResumeConfigTab userId={userId} profile={candidateProfile} onProfileChange={onProfileChange} />
      )}

      {syncPromptFor && active && (
        <SyncResumeModal
          diff={syncPromptFor.diff}
          roleLabel={active.label}
          defaultSyncName={profileResumeName}
          // Both choices here always create a brand-new Library entry now (2026-08-20) — never a
          // replace-in-place — so the check is against every existing file, no exclusion. Scoped to the
          // "profile" source category (2026-08-25) — both of this modal's choices always produce a
          // sourceRoleId-tagged instance, same as finalizeProfileResumeSave's own check.
          isNameTaken={(name) => isNameTaken(name, candidateProfile.files, "profile")}
          onSaveToProfile={(name) => handleSyncChoice("sync", name)}
          onSaveThisOnly={(name) => handleSyncChoice("local", name)}
          onCancel={() => setSyncPromptFor(null)}
        />
      )}
      {previewPdf && (
        <PdfPreviewModal
          data={previewPdf.data}
          templateId={previewPdf.templateId}
          fileName={previewPdf.fileName}
          pageBreaks={previewPdf.pageBreaks}
          onRequestDownload={requestPdfDownload}
          onClose={() => setPreviewPdf(null)}
        />
      )}
      {resumePdfPortal}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form sections — each a thin controlled-input layer over `draft`/`onChange`.
// ---------------------------------------------------------------------------

// Experience/Education/Projects/Certifications/Languages below are exported (2026-08-19) so ProfileTab.tsx
// can reuse them verbatim for the candidate's permanent profile — same item shapes (ResumeExperience etc.),
// same controlled data/onChange contract, just fed a synthetic ResumeData-shaped view over CandidateProfile
// instead of a resume draft. Skills isn't reused — CandidateProfile's skills carry an id (ProfileSkill),
// unlike ResumeData's plain string[], since a role now selects a *subset* of them.
export type SectionProps = { data: ResumeData; onChange: (patch: Partial<ResumeData>) => void };

// `atomKey` (2026-08-20) — when set, tags this section's own wrapper with `data-atom-key`, the same stable
// key the corresponding preview-template atom uses (see ModernTemplate.tsx's header comment). Only the
// single-block sections (Personal Info/Summary/Skills/Languages) pass one directly to FormSection, since
// they render exactly one atom; Experience/Projects/Education/Certifications tag each entry's own wrapper
// individually instead (one FormSection, many atoms). Scroll position over these elements is how the
// editor drives which page the preview shows — see ResumeBuilder's scroll-sync effect.
export function FormSection({ title, children, atomKey }: { title: string; children: React.ReactNode; atomKey?: string }) {
  return (
    <div className="panel" style={{ marginBottom: "0.75rem", padding: "0.7rem 0.8rem" }} data-atom-key={atomKey}>
      <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.85rem" }}>{title}</h3>
      {children}
    </div>
  );
}

function PersonalInfoSection({ data, onChange }: SectionProps) {
  const p = data.personalInfo;
  function set(patch: Partial<ResumeData["personalInfo"]>) {
    onChange({ personalInfo: { ...p, ...patch } });
  }
  return (
    <FormSection title="Personal Info" atomKey="header">
      <div className="grid-2">
        <label className="field"><span>Full name</span><input type="text" value={p.fullName} onChange={(e) => set({ fullName: e.target.value })} /></label>
        <label className="field"><span>Title / headline</span><input type="text" value={p.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Backend Developer" /></label>
        <label className="field"><span>Email</span><input type="email" value={p.email} onChange={(e) => set({ email: e.target.value })} /></label>
        <label className="field"><span>Phone</span><input type="text" value={p.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
        <label className="field"><span>Location</span><input type="text" value={p.location} onChange={(e) => set({ location: e.target.value })} placeholder="City, Country" /></label>
        <label className="field"><span>Portfolio</span><input type="text" value={p.portfolioUrl} onChange={(e) => set({ portfolioUrl: e.target.value })} /></label>
        <label className="field"><span>LinkedIn</span><input type="text" value={p.linkedinUrl} onChange={(e) => set({ linkedinUrl: e.target.value })} /></label>
      </div>
    </FormSection>
  );
}

function SummarySection({ data, onChange }: SectionProps) {
  return (
    <FormSection title="Summary" atomKey="summary">
      <AutoGrowTextarea value={data.summary} maxHeight={160} onChange={(e) => onChange({ summary: e.target.value })} placeholder="A few sentences about you…" />
    </FormSection>
  );
}

// A markdown-lite text block (2026-08-19) — replaces the old bullets-as-separate-inputs editor
// (BulletsEditor). One open AutoGrowTextarea instead: start a line with "- " for a bullet point, wrap
// text in "**...**" for bold. A HoverHint next to the label shows the syntax on hover instead of taking
// up permanent space — see lib/markdownLite.tsx's renderMarkdownLite for how this renders in the preview.
export function MarkdownLiteField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="field" style={{ marginTop: "0.4rem" }}>
      <span>
        {label}
        <HoverHint
          content={
            <>
              <p style={{ margin: "0 0 0.4rem", fontWeight: 600 }}>Formatting</p>
              <p style={{ margin: "0 0 0.3rem" }}>Start a line with <code>- </code> for a bullet point:</p>
              <p style={{ margin: "0 0 0.5rem", paddingLeft: "0.7rem", opacity: 0.85 }}>- Led a team of 5 engineers</p>
              <p style={{ margin: 0 }}>Wrap text in <code>**like this**</code> to make it <strong>bold</strong>.</p>
            </>
          }
        />
      </span>
      <AutoGrowTextarea
        value={value}
        maxHeight={220}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

export function ExperienceSection({ data, onChange }: SectionProps) {
  const items = data.experience;
  function set(items2: ResumeExperience[]) { onChange({ experience: items2 }); }
  function add() {
    const e: ResumeExperience = { id: uid(), company: "", title: "", location: "", startDate: "", endDate: "", current: false, description: "" };
    set([...items, e]);
  }
  function update(id: string, patch: Partial<ResumeExperience>) { set(items.map((i) => (i.id === id ? { ...i, ...patch } : i))); }
  function remove(id: string) { set(items.filter((i) => i.id !== id)); }

  return (
    <FormSection title="Experience">
      {items.map((e) => (
        <div key={e.id} data-atom-key={e.id} style={{ border: "1px solid var(--line)", borderRadius: "8px", padding: "0.5rem 0.6rem", marginBottom: "0.5rem" }}>
          <div className="grid-2">
            <label className="field"><span>Company</span><input type="text" value={e.company} onChange={(ev) => update(e.id, { company: ev.target.value })} /></label>
            <label className="field"><span>Title</span><input type="text" value={e.title} onChange={(ev) => update(e.id, { title: ev.target.value })} /></label>
            <label className="field"><span>Location</span><input type="text" value={e.location} onChange={(ev) => update(e.id, { location: ev.target.value })} /></label>
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
              <label className="field" style={{ flex: 1 }}><span>Start</span><input type="text" value={e.startDate} onChange={(ev) => update(e.id, { startDate: ev.target.value })} placeholder="Jan 2022" /></label>
              <label className="field" style={{ flex: 1 }}><span>End</span><input type="text" value={e.endDate} onChange={(ev) => update(e.id, { endDate: ev.target.value })} placeholder="Present" disabled={e.current} /></label>
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.78rem", marginTop: "0.3rem" }}>
            <input type="checkbox" checked={e.current} onChange={(ev) => update(e.id, { current: ev.target.checked, endDate: ev.target.checked ? "" : e.endDate })} />
            I currently work here
          </label>
          <MarkdownLiteField
            label="Description"
            value={e.description}
            onChange={(v) => update(e.id, { description: v })}
            placeholder={"- Led a team of 5 engineers shipping the core platform\n- Cut deploy time by 40% via CI pipeline rework"}
          />
          <button type="button" className="btn ghost danger" style={{ fontSize: "0.72rem", marginTop: "0.4rem" }} onClick={() => remove(e.id)}>Remove entry</button>
        </div>
      ))}
      <button type="button" className="btn" style={{ fontSize: "0.78rem" }} onClick={add}>+ Add experience</button>
    </FormSection>
  );
}

export function EducationSection({ data, onChange }: SectionProps) {
  const items = data.education;
  function set(items2: ResumeEducation[]) { onChange({ education: items2 }); }
  function add() { set([...items, { id: uid(), school: "", degree: "", field: "", startDate: "", endDate: "", notes: "" }]); }
  function update(id: string, patch: Partial<ResumeEducation>) { set(items.map((i) => (i.id === id ? { ...i, ...patch } : i))); }
  function remove(id: string) { set(items.filter((i) => i.id !== id)); }

  return (
    <FormSection title="Education">
      {items.map((ed) => (
        <div key={ed.id} data-atom-key={ed.id} style={{ border: "1px solid var(--line)", borderRadius: "8px", padding: "0.5rem 0.6rem", marginBottom: "0.5rem" }}>
          <div className="grid-2">
            <label className="field"><span>School</span><input type="text" value={ed.school} onChange={(e) => update(ed.id, { school: e.target.value })} /></label>
            <label className="field"><span>Degree</span><input type="text" value={ed.degree} onChange={(e) => update(ed.id, { degree: e.target.value })} /></label>
            <label className="field"><span>Field</span><input type="text" value={ed.field} onChange={(e) => update(ed.id, { field: e.target.value })} /></label>
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <label className="field" style={{ flex: 1 }}><span>Start</span><input type="text" value={ed.startDate} onChange={(e) => update(ed.id, { startDate: e.target.value })} /></label>
              <label className="field" style={{ flex: 1 }}><span>End</span><input type="text" value={ed.endDate} onChange={(e) => update(ed.id, { endDate: e.target.value })} /></label>
            </div>
          </div>
          <MarkdownLiteField
            label="Notes (optional)"
            value={ed.notes}
            onChange={(v) => update(ed.id, { notes: v })}
            placeholder={"- Graduated with honors\n- Relevant coursework: ..."}
          />
          <button type="button" className="btn ghost danger" style={{ fontSize: "0.72rem", marginTop: "0.3rem" }} onClick={() => remove(ed.id)}>Remove entry</button>
        </div>
      ))}
      <button type="button" className="btn" style={{ fontSize: "0.78rem" }} onClick={add}>+ Add education</button>
    </FormSection>
  );
}

export function ProjectsSection({ data, onChange }: SectionProps) {
  const items = data.projects;
  function set(items2: ResumeProject[]) { onChange({ projects: items2 }); }
  function add() { set([...items, { id: uid(), name: "", description: "", link: "" }]); }
  function update(id: string, patch: Partial<ResumeProject>) { set(items.map((i) => (i.id === id ? { ...i, ...patch } : i))); }
  function remove(id: string) { set(items.filter((i) => i.id !== id)); }

  return (
    <FormSection title="Projects">
      {items.map((pr) => (
        <div key={pr.id} data-atom-key={pr.id} style={{ border: "1px solid var(--line)", borderRadius: "8px", padding: "0.5rem 0.6rem", marginBottom: "0.5rem" }}>
          <div className="grid-2">
            <label className="field"><span>Name</span><input type="text" value={pr.name} onChange={(e) => update(pr.id, { name: e.target.value })} /></label>
            <label className="field"><span>Link (optional)</span><input type="text" value={pr.link} onChange={(e) => update(pr.id, { link: e.target.value })} /></label>
          </div>
          <MarkdownLiteField
            label="Description"
            value={pr.description}
            onChange={(v) => update(pr.id, { description: v })}
            placeholder={"A short pitch, then:\n- Built with React and Postgres\n- 500+ active users"}
          />
          <button type="button" className="btn ghost danger" style={{ fontSize: "0.72rem", marginTop: "0.3rem" }} onClick={() => remove(pr.id)}>Remove entry</button>
        </div>
      ))}
      <button type="button" className="btn" style={{ fontSize: "0.78rem" }} onClick={add}>+ Add project</button>
    </FormSection>
  );
}

function SkillsSection({ data, onChange }: SectionProps) {
  const [input, setInput] = useState("");
  // Comma-separated ("React, Node.js, PostgreSQL") adds each as its own chip — same as ProfileTab's
  // skill adder (2026-08-19).
  function add() {
    const existingLower = new Set(data.skills.map((s) => s.toLowerCase()));
    const seen = new Set<string>();
    const names = input
      .split(",")
      .map((s) => s.trim())
      .filter((s) => {
        if (!s || existingLower.has(s.toLowerCase())) return false;
        const key = s.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (names.length === 0) return;
    onChange({ skills: [...data.skills, ...names] });
    setInput("");
  }
  function remove(s: string) { onChange({ skills: data.skills.filter((x) => x !== s) }); }

  return (
    <FormSection title="Skills" atomKey="skills">
      <div style={{ display: "flex", gap: "0.4rem" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="e.g. TypeScript"
        />
        <button type="button" className="btn" style={{ fontSize: "0.78rem" }} onClick={add}>Add</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginTop: "0.5rem" }}>
        {data.skills.map((s) => (
          <span key={s} className="chip" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
            {s}
            <button type="button" onClick={() => remove(s)} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--muted)" }}>×</button>
          </span>
        ))}
      </div>
    </FormSection>
  );
}

export function CertificationsSection({ data, onChange }: SectionProps) {
  const items = data.certifications;
  function set(items2: ResumeCertification[]) { onChange({ certifications: items2 }); }
  function add() { set([...items, { id: uid(), name: "", issuer: "", date: "" }]); }
  function update(id: string, patch: Partial<ResumeCertification>) { set(items.map((i) => (i.id === id ? { ...i, ...patch } : i))); }
  function remove(id: string) { set(items.filter((i) => i.id !== id)); }

  return (
    <FormSection title="Certifications">
      {items.map((c) => (
        <div key={c.id} data-atom-key={c.id} style={{ display: "flex", gap: "0.4rem", marginBottom: "0.4rem", alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 2 }}><span>Name</span><input type="text" value={c.name} onChange={(e) => update(c.id, { name: e.target.value })} /></label>
          <label className="field" style={{ flex: 2 }}><span>Issuer</span><input type="text" value={c.issuer} onChange={(e) => update(c.id, { issuer: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}><span>Date</span><input type="text" value={c.date} onChange={(e) => update(c.id, { date: e.target.value })} /></label>
          <button type="button" className="btn ghost danger" onClick={() => remove(c.id)}>×</button>
        </div>
      ))}
      <button type="button" className="btn" style={{ fontSize: "0.78rem" }} onClick={add}>+ Add certification</button>
    </FormSection>
  );
}

export function LanguagesSection({ data, onChange }: SectionProps) {
  const items = data.languages;
  function set(items2: ResumeLanguage[]) { onChange({ languages: items2 }); }
  function add() { set([...items, { id: uid(), name: "", level: "" }]); }
  function update(id: string, patch: Partial<ResumeLanguage>) { set(items.map((i) => (i.id === id ? { ...i, ...patch } : i))); }
  function remove(id: string) { set(items.filter((i) => i.id !== id)); }

  return (
    // atomKey lives on the whole section (like Skills), not per-row — the preview renders every language
    // joined into one paragraph atom ("languages"), not one atom per entry.
    <FormSection title="Languages" atomKey="languages">
      {items.map((l) => (
        <div key={l.id} style={{ display: "flex", gap: "0.4rem", marginBottom: "0.4rem", alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 2 }}><span>Language</span><input type="text" value={l.name} onChange={(e) => update(l.id, { name: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}><span>Level</span><input type="text" value={l.level} onChange={(e) => update(l.id, { level: e.target.value })} placeholder="Fluent" /></label>
          <button type="button" className="btn ghost danger" onClick={() => remove(l.id)}>×</button>
        </div>
      ))}
      <button type="button" className="btn" style={{ fontSize: "0.78rem" }} onClick={add}>+ Add language</button>
    </FormSection>
  );
}

// Typography controls (2026-08-20, operator ask — "I should be able to control the text size and the
// font... the padding of the page, the distance between the lines, the distance between the characters").
// No atomKey — this doesn't correspond to anything in the preview, it's controls, not content.
// Template picker moved in here (2026-08-25, operator ask — "the style of the resume should be like the
// Modern or Classic [template]... it should be in this style tab, both from the profile and start from
// scratch") — used to be its own inline <select> in the "Start from scratch" toolbar, disconnected from
// every other visual-style control and entirely absent from "From your profile" mode (always hardcoded
// "modern" — see ResumeBuilder's profileTemplateId). `templateId`/`onTemplateChange` are separate from
// `style`/`onChange` since ResumeTemplateId isn't part of ResumeStyleSettings — it lives on the
// ResumeProfile row (scratch mode) or ResumeBuilder's own profileTemplateIds state (profile mode), not on
// ResumeData itself.
function StyleSection({ style, onChange, templateId, onTemplateChange }: {
  style: ResumeStyleSettings;
  onChange: (patch: Partial<ResumeStyleSettings>) => void;
  templateId: ResumeTemplateId;
  onTemplateChange: (id: ResumeTemplateId) => void;
}) {
  return (
    <FormSection title="Style">
      <label className="field">
        <span>Template</span>
        <select value={templateId} onChange={(e) => onTemplateChange(e.target.value as ResumeTemplateId)}>
          {RESUME_TEMPLATE_IDS.map((t) => <option key={t} value={t}>{TEMPLATES[t].label}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Font</span>
        <select value={style.fontFamily} onChange={(e) => onChange({ fontFamily: e.target.value })}>
          {RESUME_FONT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </label>
      <StyleSlider label="Text size" value={style.fontSizePt} min={9} max={13} step={0.5} unit="pt" onChange={(v) => onChange({ fontSizePt: v })} />
      <StyleSlider label="Line spacing" value={style.lineHeight} min={1.1} max={1.8} step={0.05} onChange={(v) => onChange({ lineHeight: v })} />
      <StyleSlider label="Letter spacing" value={style.letterSpacingEm} min={-0.02} max={0.08} step={0.005} unit="em" onChange={(v) => onChange({ letterSpacingEm: v })} />
      <StyleSlider label="Page padding" value={style.pagePaddingMm} min={8} max={25} step={1} unit="mm" onChange={(v) => onChange({ pagePaddingMm: v })} />
    </FormSection>
  );
}

function StyleSlider({ label, value, min, max, step, unit = "", onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void;
}) {
  return (
    <label className="field" style={{ marginTop: "0.4rem" }}>
      <span>{label} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({value}{unit})</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </label>
  );
}
