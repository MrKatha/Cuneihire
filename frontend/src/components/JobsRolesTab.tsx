"use client";

import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import {
  AVAILABILITY_OPTIONS,
  SALARY_CURRENCIES,
  type AvailabilityOption,
  type CandidateProfile,
  type CompanySize,
  type EmploymentType,
  type ProfileSkill,
  type Recipient,
  type ResumeCertification,
  type ResumeEducation,
  type ResumeExperience,
  type ResumeProject,
  type Role,
  type RoleDef,
  type SalaryPeriod,
  type VisaSponsorship,
  type WorkMode,
} from "@/lib/types";
import { groupRecipientsByJobPost } from "@/lib/jobPosts";
import { JobPostCard } from "./JobPostCard";
import { AddProfileItemModal, type AddableSection } from "./AddProfileItemModal";

const MAX_CHIPS = 15;
const STRICTNESS_KEY = "cuneihire_match_min_score";

type ModuleKey = "experience" | "education" | "projects" | "certifications" | "skills";

type Props = {
  roleDefs: RoleDef[];
  recipients: Recipient[];
  // The permanent knowledge base a role's module selection draws from (2026-08-19) — see
  // lib/resumeCompose.ts and RoleDef's comment in types.ts.
  profile: CandidateProfile;
  // Writes straight back to the same canonical profile state page.tsx passes to ProfileTab — the "+ Add"
  // quick-add flow below and the skills quick-add both go through this, so it's never a separate copy.
  onProfileChange: (profile: CandidateProfile) => void;
  // Same role-key selection used by the Templates tab (RoleTemplates.tsx) — shared state in page.tsx so
  // both pages stay in sync on "which role am I working on."
  activeRole: Role;
  onActiveRoleChange: (role: Role) => void;
  onAddRole: (label: string) => void;
  onRenameRole: (id: string, newLabel: string) => void;
  onDeleteRole: (id: string) => void;
  onUpdateRoleRules: (id: string, patch: Partial<RoleDef>) => void;
  onUpdateStatus?: (id: string, field: "status" | "phone_status", newStatus: string) => Promise<void>;
};

const WORK_MODES: { value: WorkMode; label: string }[] = [
  { value: "any", label: "Doesn't matter" },
  { value: "remote", label: "Remote" },
  { value: "onsite", label: "On-site" },
  { value: "hybrid", label: "Hybrid" },
];

const SALARY_PERIODS: { value: SalaryPeriod; label: string }[] = [
  { value: "annual", label: "/ year" },
  { value: "monthly", label: "/ month" },
  { value: "hourly", label: "/ hour" },
];

const EMPLOYMENT_TYPES: { value: EmploymentType; label: string }[] = [
  { value: "any", label: "Doesn't matter" },
  { value: "full-time", label: "Full-time" },
  { value: "part-time", label: "Part-time" },
  { value: "contract", label: "Contract" },
  { value: "internship", label: "Internship" },
];

const COMPANY_SIZES: { value: CompanySize; label: string }[] = [
  { value: "any", label: "Doesn't matter" },
  { value: "startup", label: "Startup" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "enterprise", label: "Enterprise" },
];

const VISA_OPTIONS: { value: VisaSponsorship; label: string }[] = [
  { value: "any", label: "Doesn't matter" },
  { value: "required", label: "Required" },
  { value: "not-required", label: "Not required" },
];

// Shared add/remove chip-list UI — used for both search keywords and preferred locations, the two
// deliberately-still-free-text fields (everything else with a fixed set of choices is a dropdown).
function ChipListField({
  label,
  placeholder,
  values,
  emptyHint,
  onAdd,
  onRemove,
}: {
  label: string;
  placeholder: string;
  values: string[];
  emptyHint: string;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [input, setInput] = useState("");

  function submit() {
    const v = input.trim();
    if (!v) return;
    if (values.length >= MAX_CHIPS) {
      toast.error(`Up to ${MAX_CHIPS}.`);
      return;
    }
    if (!values.includes(v)) onAdd(v);
    setInput("");
  }

  return (
    <label className="field">
      <span>{label}</span>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder={placeholder}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn" onClick={submit}>Add</button>
      </div>
      {values.length === 0 ? (
        <p className="hint compact">{emptyHint}</p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.4rem" }}>
          {values.map((v) => (
            <span key={v} className="chip" style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
              {v}
              <button type="button" onClick={() => onRemove(v)} style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 0 }}>×</button>
            </span>
          ))}
        </div>
      )}
    </label>
  );
}

// A role selects a subset of the candidate's profile items by id — one collapsible checklist per
// section, generic over the item shape since experience/education/projects/certifications/skills only
// differ in what label to show. Collapsed by default (a full profile can be long); the button always
// shows the "N of M selected" count so nothing needs expanding just to check the current state.
// Accordion, not independent toggles (2026-08-20, operator UI feedback: "if the experience tab is open
// and I open education, the first one should [collapse] automatically") — expanded/onToggleExpand are
// controlled by the parent's single `expandedModule` key instead of local state, so opening one section
// closes whatever else was open; clicking the open section's own header still collapses it.
// Select all/none (2026-08-19) restores/clears the whole section in one click — mainly useful after
// trimming a role down, or after adding several new items via "+ Add" and wanting them all included at
// once. "+ Add" (optional) opens AddProfileItemModal without leaving this page — every section passes it
// now, including Skills (2026-08-20: dropped its separate always-visible inline adder for the same
// pop-up pattern as the rest).
function ModuleChecklist<T extends { id: string }>({
  title,
  items,
  selectedIds,
  getLabel,
  onToggle,
  onSelectAll,
  onSelectNone,
  onAddOther,
  emptyHint,
  expanded,
  onToggleExpand,
}: {
  title: string;
  items: T[];
  selectedIds: string[];
  getLabel: (item: T) => string;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onAddOther?: () => void;
  emptyHint: string;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  if (items.length === 0) {
    return (
      <p className="hint compact" style={{ margin: "0 0 0.35rem", display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
        <span><strong>{title}:</strong> {emptyHint}</span>
        {onAddOther && (
          <button type="button" className="btn ghost" style={{ fontSize: "0.72rem", padding: "0.1rem 0.4rem" }} onClick={onAddOther}>
            + Add {title.toLowerCase()}
          </button>
        )}
      </p>
    );
  }
  const selectedCount = items.filter((i) => selectedIds.includes(i.id)).length;
  return (
    <div style={{ marginBottom: "0.35rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn ghost"
          style={{ fontSize: "0.78rem", padding: "0.2rem 0.4rem" }}
          onClick={onToggleExpand}
        >
          {expanded ? "▾" : "▸"} {title} ({selectedCount} of {items.length} selected)
        </button>
        {expanded && (
          <>
            <button type="button" className="btn ghost" style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem" }} onClick={onSelectAll} disabled={selectedCount === items.length}>
              Select all
            </button>
            <button type="button" className="btn ghost" style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem" }} onClick={onSelectNone} disabled={selectedCount === 0}>
              Select none
            </button>
            {onAddOther && (
              <button type="button" className="btn ghost" style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem" }} onClick={onAddOther}>
                + Add {title.toLowerCase()}
              </button>
            )}
          </>
        )}
      </div>
      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.4rem", paddingLeft: "0.6rem" }}>
          {items.map((item) => (
            <label key={item.id} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.8rem" }}>
              <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => onToggle(item.id)} />
              {getLabel(item)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function JobsRolesTab({
  roleDefs,
  recipients,
  profile,
  onProfileChange,
  activeRole,
  onActiveRoleChange,
  onAddRole,
  onRenameRole,
  onDeleteRole,
  onUpdateRoleRules,
  onUpdateStatus,
}: Props) {
  const [showAddRole, setShowAddRole] = useState(false);
  const [newRoleLabel, setNewRoleLabel] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [addingSection, setAddingSection] = useState<AddableSection | null>(null);
  // Which of the five module checklists is open — accordion, not five independent toggles (2026-08-20).
  const [expandedModule, setExpandedModule] = useState<ModuleKey | null>(null);
  function toggleExpanded(key: ModuleKey) {
    setExpandedModule((cur) => (cur === key ? null : key));
  }

  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(STRICTNESS_KEY) : null;
    if (saved !== null) setMinScore(Number(saved) || 0);
  }, []);

  function handleMinScoreChange(v: number) {
    setMinScore(v);
    if (typeof window !== "undefined") window.localStorage.setItem(STRICTNESS_KEY, String(v));
  }

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    recipients.forEach((r) => { map[r.role] = (map[r.role] || 0) + 1; });
    return map;
  }, [recipients]);

  const active = roleDefs.find((d) => d.key === activeRole) || roleDefs[0];

  // Matching happens before you'd ever reach out — it's a "does this fit what I'm looking for" check
  // against this role's own criteria, so it lives here with the criteria, not in the outreach tracker
  // (JamsTab). See docs/memory.md.
  const { matchedPosts, hiddenByStrictness } = useMemo(() => {
    if (!active) return { matchedPosts: [], hiddenByStrictness: 0 };
    const forRole = groupRecipientsByJobPost(recipients).filter((g) => g.role === active.key);
    const visible = forRole.filter((g) => g.matchScore === null || g.matchScore >= minScore);
    visible.sort((a, b) => {
      if (a.matchScore === null && b.matchScore === null) return (b.scrapedAt || "").localeCompare(a.scrapedAt || "");
      if (a.matchScore === null) return 1;
      if (b.matchScore === null) return -1;
      return b.matchScore - a.matchScore;
    });
    return { matchedPosts: visible, hiddenByStrictness: forRole.length - visible.length };
  }, [recipients, active, minScore]);

  type SelectionField = "selectedExperienceIds" | "selectedEducationIds" | "selectedProjectIds" | "selectedCertificationIds" | "selectedSkillIds";
  function toggleModule(field: SelectionField, id: string) {
    if (!active) return;
    const current = active[field];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    onUpdateRoleRules(active.id, { [field]: next });
  }
  function selectAllModule(field: SelectionField, allIds: string[]) {
    if (!active) return;
    onUpdateRoleRules(active.id, { [field]: allIds });
  }
  function selectNoneModule(field: SelectionField) {
    if (!active) return;
    onUpdateRoleRules(active.id, { [field]: [] });
  }

  // "+ Add" quick-add (2026-08-19) — writes the new item straight into the canonical profile (so it's
  // immediately available to every other role too, not just this one) and auto-selects it for the role
  // currently being edited, since that's the whole reason to add it from here rather than My Profile.
  function addExperience(item: ResumeExperience) {
    onProfileChange({ ...profile, experience: [...profile.experience, item] });
    if (active) onUpdateRoleRules(active.id, { selectedExperienceIds: [...active.selectedExperienceIds, item.id] });
  }
  function addEducation(item: ResumeEducation) {
    onProfileChange({ ...profile, education: [...profile.education, item] });
    if (active) onUpdateRoleRules(active.id, { selectedEducationIds: [...active.selectedEducationIds, item.id] });
  }
  function addProject(item: ResumeProject) {
    onProfileChange({ ...profile, projects: [...profile.projects, item] });
    if (active) onUpdateRoleRules(active.id, { selectedProjectIds: [...active.selectedProjectIds, item.id] });
  }
  function addCertification(item: ResumeCertification) {
    onProfileChange({ ...profile, certifications: [...profile.certifications, item] });
    if (active) onUpdateRoleRules(active.id, { selectedCertificationIds: [...active.selectedCertificationIds, item.id] });
  }
  // Skills quick-add (2026-08-20: moved into the same AddProfileItemModal pop-up as the other four
  // sections — dedup against existing names happens in the modal itself, via existingSkillNames below).
  function addSkillsFromModal(newSkills: ProfileSkill[]) {
    onProfileChange({ ...profile, skills: [...profile.skills, ...newSkills] });
    if (active) onUpdateRoleRules(active.id, { selectedSkillIds: [...active.selectedSkillIds, ...newSkills.map((s) => s.id)] });
  }

  function handleModalAdd(item: ResumeExperience | ResumeEducation | ResumeProject | ResumeCertification | ProfileSkill[]) {
    if (addingSection === "experience") addExperience(item as ResumeExperience);
    else if (addingSection === "education") addEducation(item as ResumeEducation);
    else if (addingSection === "projects") addProject(item as ResumeProject);
    else if (addingSection === "certifications") addCertification(item as ResumeCertification);
    else if (addingSection === "skills") addSkillsFromModal(item as ProfileSkill[]);
  }

  function handleAddRoleSubmit() {
    if (!newRoleLabel.trim()) return;
    onAddRole(newRoleLabel.trim());
    setNewRoleLabel("");
    setShowAddRole(false);
  }

  function handleRename() {
    if (!active) return;
    const next = prompt("Rename this role", active.label);
    if (next && next.trim() && next.trim() !== active.label) {
      onRenameRole(active.id, next.trim());
    }
  }

  function handleDelete() {
    if (!active) return;
    if (roleDefs.length <= 1) {
      toast.error("You need at least one role.");
      return;
    }
    if (confirm(`Delete "${active.label}"? Existing recipients tagged with it are unaffected.`)) {
      const remaining = roleDefs.filter((d) => d.id !== active.id);
      onDeleteRole(active.id);
      if (remaining.length > 0) onActiveRoleChange(remaining[0].key);
    }
  }

  if (!active) {
    return (
      <section className="panel">
        <div className="panel-head"><h2>Roles</h2></div>
        <div className="panel-body"><p className="hint">No roles yet — add one to get started.</p></div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Roles</h2>
        <span className="hint compact">What you&apos;re targeting — search keywords, job requirements, and which of your profile&apos;s items apply, per role</span>
      </div>
      <div className="panel-body">
        <div className="role-tabs" role="tablist">
          {roleDefs.map((def) => (
            <button
              key={def.id}
              type="button"
              role="tab"
              aria-selected={active.key === def.key}
              className={`role-tab${active.key === def.key ? " active" : ""}${counts[def.key] > 0 ? " has-recipients" : ""}`}
              onClick={() => onActiveRoleChange(def.key)}
            >
              <span>{def.label}</span>
              <span className="role-tab-count">{counts[def.key] || 0}</span>
            </button>
          ))}
          {showAddRole ? (
            <span style={{ display: "inline-flex", gap: "0.35rem", alignItems: "center" }}>
              <input
                type="text"
                autoFocus
                value={newRoleLabel}
                onChange={(e) => setNewRoleLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); handleAddRoleSubmit(); }
                  if (e.key === "Escape") { setShowAddRole(false); setNewRoleLabel(""); }
                }}
                placeholder="e.g. Senior Rust Engineer"
                style={{ padding: "0.3rem 0.5rem", fontSize: "0.85rem", width: "180px" }}
              />
              <button type="button" className="btn" onClick={handleAddRoleSubmit} style={{ padding: "0.3rem 0.6rem" }}>Add</button>
            </span>
          ) : (
            <button type="button" className="role-tab" onClick={() => setShowAddRole(true)}>+ Add title</button>
          )}
        </div>

        <div className="template-card single" style={{ marginTop: "1rem" }}>
          <div className="template-head">
            <h3>{active.label}</h3>
            <span className="chip">{counts[active.key] || 0} recipient{(counts[active.key] || 0) === 1 ? "" : "s"}</span>
            <span style={{ display: "flex", gap: "0.4rem", marginLeft: "auto" }}>
              <button type="button" className="btn ghost" onClick={handleRename} style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }}>Rename</button>
              <button type="button" className="btn ghost danger" onClick={handleDelete} style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }}>Delete</button>
            </span>
          </div>

          <ChipListField
            label="Search keywords / aliases"
            placeholder="e.g. automation engineer"
            values={active.keywords}
            emptyHint="No keywords yet — this role won't be searched until you add at least one."
            onAdd={(v) => onUpdateRoleRules(active.id, { keywords: [...active.keywords, v] })}
            onRemove={(v) => onUpdateRoleRules(active.id, { keywords: active.keywords.filter((k) => k !== v) })}
          />

          <div className="grid-2" style={{ marginTop: "1rem" }}>
            <label className="field">
              <span>Work mode</span>
              <select
                value={active.workMode}
                onChange={(e) => onUpdateRoleRules(active.id, { workMode: e.target.value as WorkMode })}
              >
                {WORK_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Employment type</span>
              <select
                value={active.employmentType}
                onChange={(e) => onUpdateRoleRules(active.id, { employmentType: e.target.value as EmploymentType })}
              >
                {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
          </div>

          <label className="field" style={{ marginTop: "0.75rem" }}>
            <span>Salary expectation</span>
            <div className="grid-2" style={{ gridTemplateColumns: "auto auto 1fr 1fr", gap: "0.5rem" }}>
              <select
                value={active.salaryCurrency}
                onChange={(e) => onUpdateRoleRules(active.id, { salaryCurrency: e.target.value })}
                style={{ width: "90px" }}
              >
                {SALARY_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select
                value={active.salaryPeriod}
                onChange={(e) => onUpdateRoleRules(active.id, { salaryPeriod: e.target.value as SalaryPeriod })}
                style={{ width: "100px" }}
              >
                {SALARY_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              <input
                type="number"
                min={0}
                value={active.salaryMin ?? ""}
                onChange={(e) => onUpdateRoleRules(active.id, { salaryMin: e.target.value === "" ? null : Number(e.target.value) })}
                placeholder="Min"
              />
              <input
                type="number"
                min={0}
                value={active.salaryMax ?? ""}
                onChange={(e) => onUpdateRoleRules(active.id, { salaryMax: e.target.value === "" ? null : Number(e.target.value) })}
                placeholder="Max"
              />
            </div>
          </label>

          <div className="grid-2" style={{ marginTop: "0.75rem" }}>
            <label className="field">
              <span>Company size</span>
              <select
                value={active.companySize}
                onChange={(e) => onUpdateRoleRules(active.id, { companySize: e.target.value as CompanySize })}
              >
                {COMPANY_SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Visa sponsorship</span>
              <select
                value={active.visaSponsorship}
                onChange={(e) => onUpdateRoleRules(active.id, { visaSponsorship: e.target.value as VisaSponsorship })}
              >
                {VISA_OPTIONS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Availability</span>
              <select
                value={active.availability}
                onChange={(e) => onUpdateRoleRules(active.id, { availability: e.target.value as AvailabilityOption })}
              >
                {AVAILABILITY_OPTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
          </div>

          <div style={{ marginTop: "0.75rem" }}>
            <ChipListField
              label="Preferred countries / locations"
              placeholder="e.g. Pakistan"
              values={active.preferredLocations}
              emptyHint="No preference — any location."
              onAdd={(v) => onUpdateRoleRules(active.id, { preferredLocations: [...active.preferredLocations, v] })}
              onRemove={(v) => onUpdateRoleRules(active.id, { preferredLocations: active.preferredLocations.filter((l) => l !== v) })}
            />
          </div>

          <label className="field stretch" style={{ marginTop: "0.75rem" }}>
            <span>Other notes</span>
            <textarea
              rows={3}
              value={active.otherNotes}
              onChange={(e) => onUpdateRoleRules(active.id, { otherNotes: e.target.value })}
              placeholder="Anything else worth noting for this role, not covered above"
            />
          </label>

          <div style={{ marginTop: "0.9rem" }}>
            <span className="hint compact" style={{ display: "block", marginBottom: "0.4rem" }}>
              Modules for {active.label} — which of your profile&apos;s items go into a resume Easy Apply
              composes for this role. New roles start with everything selected; trim what doesn&apos;t fit.
            </span>
            <ModuleChecklist
              title="Experience"
              items={profile.experience}
              selectedIds={active.selectedExperienceIds}
              getLabel={(e) => `${e.title || "Untitled"} — ${e.company || "?"}`}
              onToggle={(id) => toggleModule("selectedExperienceIds", id)}
              onSelectAll={() => selectAllModule("selectedExperienceIds", profile.experience.map((e) => e.id))}
              onSelectNone={() => selectNoneModule("selectedExperienceIds")}
              onAddOther={() => setAddingSection("experience")}
              emptyHint="none on your profile yet."
              expanded={expandedModule === "experience"}
              onToggleExpand={() => toggleExpanded("experience")}
            />
            <ModuleChecklist
              title="Education"
              items={profile.education}
              selectedIds={active.selectedEducationIds}
              getLabel={(e) => `${e.degree || "Untitled"} — ${e.school || "?"}`}
              onToggle={(id) => toggleModule("selectedEducationIds", id)}
              onSelectAll={() => selectAllModule("selectedEducationIds", profile.education.map((e) => e.id))}
              onSelectNone={() => selectNoneModule("selectedEducationIds")}
              onAddOther={() => setAddingSection("education")}
              emptyHint="none on your profile yet."
              expanded={expandedModule === "education"}
              onToggleExpand={() => toggleExpanded("education")}
            />
            <ModuleChecklist
              title="Projects"
              items={profile.projects}
              selectedIds={active.selectedProjectIds}
              getLabel={(p) => p.name || "Untitled"}
              onToggle={(id) => toggleModule("selectedProjectIds", id)}
              onSelectAll={() => selectAllModule("selectedProjectIds", profile.projects.map((p) => p.id))}
              onSelectNone={() => selectNoneModule("selectedProjectIds")}
              onAddOther={() => setAddingSection("projects")}
              emptyHint="none on your profile yet."
              expanded={expandedModule === "projects"}
              onToggleExpand={() => toggleExpanded("projects")}
            />
            <ModuleChecklist
              title="Certifications"
              items={profile.certifications}
              selectedIds={active.selectedCertificationIds}
              getLabel={(c) => c.name || "Untitled"}
              onToggle={(id) => toggleModule("selectedCertificationIds", id)}
              onSelectAll={() => selectAllModule("selectedCertificationIds", profile.certifications.map((c) => c.id))}
              onSelectNone={() => selectNoneModule("selectedCertificationIds")}
              onAddOther={() => setAddingSection("certifications")}
              emptyHint="none on your profile yet."
              expanded={expandedModule === "certifications"}
              onToggleExpand={() => toggleExpanded("certifications")}
            />
            <ModuleChecklist
              title="Skills"
              items={profile.skills}
              selectedIds={active.selectedSkillIds}
              getLabel={(s) => s.name || "Untitled"}
              onToggle={(id) => toggleModule("selectedSkillIds", id)}
              onSelectAll={() => selectAllModule("selectedSkillIds", profile.skills.map((s) => s.id))}
              onSelectNone={() => selectNoneModule("selectedSkillIds")}
              onAddOther={() => setAddingSection("skills")}
              emptyHint="none on your profile yet."
              expanded={expandedModule === "skills"}
              onToggleExpand={() => toggleExpanded("skills")}
            />
            <p className="hint compact" style={{ margin: "0.4rem 0 0" }}>
              This role&apos;s resume is set on the <strong>Resumes</strong> tab&apos;s Builder sub-tab.
            </p>
          </div>
        </div>

        {addingSection && (
          <AddProfileItemModal
            section={addingSection}
            onClose={() => setAddingSection(null)}
            onAdd={handleModalAdd}
            existingSkillNames={profile.skills.map((s) => s.name)}
          />
        )}

        <div style={{ marginTop: "1.25rem" }}>
          <div className="panel-head" style={{ marginBottom: "0.35rem" }}>
            <h2 style={{ fontSize: "0.82rem" }}>Matched job posts</h2>
            <span className="hint compact">Scraped posts checked against {active.label}&apos;s criteria above</span>
          </div>
          <label className="field" style={{ maxWidth: "360px", marginBottom: "0.5rem" }}>
            <span>Match strictness — hide anything scored below {minScore}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={minScore}
              onChange={(e) => handleMinScoreChange(Number(e.target.value))}
            />
          </label>
          {hiddenByStrictness > 0 && (
            <p className="hint" style={{ margin: "0 0 0.5rem" }}>{hiddenByStrictness} post(s) hidden below the strictness threshold.</p>
          )}
          {matchedPosts.length === 0 ? (
            <p className="hint" style={{ margin: 0 }}>
              No scraped posts for this role yet — turn on AutoFetch, or lower the strictness slider.
            </p>
          ) : (
            <div className="templates">
              {matchedPosts.map((g) => (
                <JobPostCard key={g.jobPostId} group={g} roleDefs={roleDefs} onUpdateStatus={onUpdateStatus} showRole={false} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
