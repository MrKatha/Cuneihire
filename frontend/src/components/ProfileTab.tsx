"use client";

import { useState } from "react";
import { type AutomailConfig, type CandidateProfile, type ResumeData, emptyResumeData } from "@/lib/types";
import { HelpTooltip } from "./HelpTooltip";
import { AutoGrowTextarea } from "./AutoGrowTextarea";
import {
  CertificationsSection,
  EducationSection,
  ExperienceSection,
  FormSection,
  LanguagesSection,
  ProjectsSection,
  uid,
} from "./ResumeBuilder";

type Props = {
  profile: CandidateProfile;
  onProfileChange: (profile: CandidateProfile) => void;
  automail: AutomailConfig;
  onAutomailChange: (automail: AutomailConfig) => void;
};

// The fixed, documented set of {{candidate_*}} template variables this page fills — kept in sync with
// ai.service.js's applyPlaceholders and RoleTemplates.tsx's variable hint.
const CANDIDATE_FIELDS: { key: "name" | "email" | "phone" | "portfolioUrl" | "resumeUrl"; label: string; token: string; placeholder: string; type: string }[] = [
  { key: "name", label: "Full Name", token: "{{candidate_name}}", placeholder: "Sohaib Amin", type: "text" },
  { key: "email", label: "Contact Email", token: "{{candidate_email}}", placeholder: "you@example.com", type: "email" },
  { key: "phone", label: "Phone", token: "{{candidate_phone}}", placeholder: "+92 300 1234567", type: "text" },
  { key: "portfolioUrl", label: "Portfolio / Website", token: "{{candidate_portfolio}}", placeholder: "https://yoursite.com", type: "url" },
  { key: "resumeUrl", label: "Resume Link", token: "{{candidate_resume_link}}", placeholder: "Link to a hosted resume", type: "url" },
];

// ResumeBuilder.tsx's section editors (Experience/Education/Projects/Certifications/Languages) are
// controlled purely by a `data: ResumeData` / `onChange: (patch) => void` pair — same item shapes this
// profile uses for those five sections — so this view lets them be reused verbatim instead of rewritten.
// Skills is the one exception: CandidateProfile.skills carries a stable `id` (ProfileSkill) since a role
// now selects a *subset* of them, a shape ResumeData.skills (plain string[]) has no room for, so it gets
// its own small editor below rather than going through this adapter.
function asResumeDataView(profile: CandidateProfile): ResumeData {
  return {
    ...emptyResumeData(),
    experience: profile.experience,
    education: profile.education,
    projects: profile.projects,
    certifications: profile.certifications,
    languages: profile.languages,
  };
}

// The permanent knowledge base (2026-08-19) — was a 5-field contact card, now everything that stays true
// regardless of which role you're targeting: identity, bio, and every experience/education/project/
// certification/skill you've ever had. A role only ever references a hand-picked subset of these by id
// (see the Roles sub-tab's "Modules for this role" and lib/resumeCompose.ts) — it never copies or forks
// them, so keeping this page current is what keeps every role's composed resume current too.
export function ProfileTab({ profile, onProfileChange, automail, onAutomailChange }: Props) {
  const [skillInput, setSkillInput] = useState("");

  function updateField(key: (typeof CANDIDATE_FIELDS)[number]["key"] | "address" | "bio", value: string) {
    onProfileChange({ ...profile, [key]: value });
  }

  const resumeView = asResumeDataView(profile);
  function patchSections(patch: Partial<ResumeData>) {
    onProfileChange({
      ...profile,
      ...(patch.experience !== undefined ? { experience: patch.experience } : {}),
      ...(patch.education !== undefined ? { education: patch.education } : {}),
      ...(patch.projects !== undefined ? { projects: patch.projects } : {}),
      ...(patch.certifications !== undefined ? { certifications: patch.certifications } : {}),
      ...(patch.languages !== undefined ? { languages: patch.languages } : {}),
    });
  }

  // Comma-separated paste/type ("React, Node.js, PostgreSQL") adds each as its own skill instead of one
  // literal chip containing commas — the common case when someone's copying a skill list from elsewhere.
  function addSkill() {
    const existingLower = new Set(profile.skills.map((s) => s.name.toLowerCase()));
    const names = skillInput
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !existingLower.has(s.toLowerCase()));
    if (names.length === 0) return;
    // Dedupe within the typed batch too, case-insensitively — "React, react" shouldn't add twice.
    const seen = new Set<string>();
    const uniqueNames = names.filter((n) => {
      const key = n.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    onProfileChange({ ...profile, skills: [...profile.skills, ...uniqueNames.map((n) => ({ id: uid(), name: n }))] });
    setSkillInput("");
  }
  function removeSkill(id: string) {
    onProfileChange({ ...profile, skills: profile.skills.filter((s) => s.id !== id) });
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>My Profile</h2>
        <span className="hint compact">Built once, kept current, reused across every role</span>
      </div>
      <div className="panel-body">
        <div className="grid-2">
          {CANDIDATE_FIELDS.map((f) => (
            <label className="field" key={f.key}>
              <span>
                {f.label}
                <HelpTooltip
                  title={f.label}
                  content={<p>Fills <code>{f.token}</code>. Left out entirely if blank — never guessed.</p>}
                />
              </span>
              <input
                type={f.type}
                value={profile[f.key]}
                onChange={(e) => updateField(f.key, e.target.value)}
                placeholder={f.placeholder}
              />
            </label>
          ))}
          <label className="field">
            <span>Address / Location</span>
            <input
              type="text"
              value={profile.address}
              onChange={(e) => updateField("address", e.target.value)}
              placeholder="City, Country"
            />
          </label>
        </div>

        <label className="field stretch" style={{ marginTop: "0.75rem" }}>
          <span>
            Bio
            <HelpTooltip
              title="Bio"
              content={<p>A few sentences about you — also used as the summary on any resume Easy Apply or the Resume Builder composes from your roles.</p>}
            />
          </span>
          <AutoGrowTextarea
            value={profile.bio}
            maxHeight={200}
            onChange={(e) => updateField("bio", e.target.value)}
            placeholder="Full-stack developer with 4 years in React, Node.js, and PostgreSQL…"
          />
        </label>

        <hr style={{ border: "0", borderTop: "1px solid var(--line)", margin: "1rem 0" }} />

        <ExperienceSection data={resumeView} onChange={patchSections} />
        <ProjectsSection data={resumeView} onChange={patchSections} />
        <EducationSection data={resumeView} onChange={patchSections} />

        <FormSection title="Skills">
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <input
              type="text"
              value={skillInput}
              onChange={(e) => setSkillInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSkill(); } }}
              placeholder="e.g. TypeScript"
            />
            <button type="button" className="btn" style={{ fontSize: "0.78rem" }} onClick={addSkill}>Add</button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginTop: "0.5rem" }}>
            {profile.skills.map((s) => (
              <span key={s.id} className="chip" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                {s.name}
                <button type="button" onClick={() => removeSkill(s.id)} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--muted)" }}>×</button>
              </span>
            ))}
          </div>
        </FormSection>

        <CertificationsSection data={resumeView} onChange={patchSections} />
        <LanguagesSection data={resumeView} onChange={patchSections} />

        <hr style={{ border: "0", borderTop: "1px solid var(--line)", margin: "1rem 0" }} />

        <label className="field">
          <span>
            Candidate Info
            <HelpTooltip
              title="Candidate Info"
              content={<p>A short blurb feeding AI-personalized outreach emails specifically — separate from your bio above, which feeds resumes instead.</p>}
            />
          </span>
          <textarea
            rows={5}
            placeholder="Full-stack developer with 4 years in React, Node.js, and PostgreSQL. Looking for remote roles."
            value={automail.candidateInfo}
            onChange={(e) => onAutomailChange({ ...automail, candidateInfo: e.target.value })}
          />
        </label>

        <p className="hint compact" style={{ marginTop: "0.75rem" }}>
          Your resumes live on the <strong>Resumes</strong> tab — build one per role on{" "}
          <strong>Builder</strong>, or manage your files and default resume on <strong>Library</strong>.
        </p>
      </div>
    </section>
  );
}
