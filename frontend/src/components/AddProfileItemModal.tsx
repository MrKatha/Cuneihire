"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import type { ProfileSkill, ResumeCertification, ResumeEducation, ResumeExperience, ResumeProject } from "@/lib/types";
import { MarkdownLiteField } from "./ResumeBuilder";

export type AddableSection = "experience" | "education" | "projects" | "certifications" | "skills";

function uid() {
  return crypto.randomUUID();
}

const SECTION_LABELS: Record<AddableSection, string> = {
  experience: "experience",
  education: "education",
  projects: "project",
  certifications: "certification",
  skills: "skill",
};

type Props = {
  section: AddableSection;
  onClose: () => void;
  onAdd: (item: ResumeExperience | ResumeEducation | ResumeProject | ResumeCertification | ProfileSkill[]) => void;
  // Skills only — for case-insensitive dedup against what's already on the profile (same names shown
  // there aren't offered again). Every other section is free-form (duplicate titles/schools are fine).
  existingSkillNames?: string[];
};

// A quick, single-item "I forgot to add this to my profile" form (2026-08-19) — lives on the Roles tab so
// a candidate never has to leave what they're doing to update My Profile. Saves straight into the same
// canonical CandidateProfile (via the caller's onAdd, which also auto-selects the new item for whichever
// role is currently active — see JobsRolesTab.tsx), so it's the exact same data everywhere else in the app
// reads from, not a separate copy. Same field set as ResumeBuilder.tsx's section editors, one entry at a
// time rather than a full list manager — a floating modal, not a new page. Skills is the one section that
// can add several at once (comma-separated), since a single skill name is a much smaller ask than a whole
// experience/education entry (2026-08-20 — moved here from its own inline adder, same pop-up pattern as
// every other section now).
export function AddProfileItemModal({ section, onClose, onAdd, existingSkillNames = [] }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Experience
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [current, setCurrent] = useState(false);
  const [description, setDescription] = useState("");

  // Education
  const [school, setSchool] = useState("");
  const [degree, setDegree] = useState("");
  const [field, setField] = useState("");
  const [notes, setNotes] = useState("");

  // Project
  const [name, setName] = useState("");
  const [link, setLink] = useState("");

  // Certification
  const [issuer, setIssuer] = useState("");
  const [date, setDate] = useState("");

  // Skill(s) — comma-separated, so "React, Node.js, PostgreSQL" adds three at once instead of one at a
  // time.
  const [skillInput, setSkillInput] = useState("");

  function handleAdd() {
    if (section === "experience") {
      if (!company.trim() && !title.trim()) { toast.error("Add at least a company or title."); return; }
      const item: ResumeExperience = { id: uid(), company: company.trim(), title: title.trim(), location: location.trim(), startDate, endDate, current, description };
      onAdd(item);
    } else if (section === "education") {
      if (!school.trim() && !degree.trim()) { toast.error("Add at least a school or degree."); return; }
      const item: ResumeEducation = { id: uid(), school: school.trim(), degree: degree.trim(), field: field.trim(), startDate, endDate, notes };
      onAdd(item);
    } else if (section === "projects") {
      if (!name.trim()) { toast.error("Give the project a name."); return; }
      const item: ResumeProject = { id: uid(), name: name.trim(), description, link: link.trim() };
      onAdd(item);
    } else if (section === "certifications") {
      if (!name.trim()) { toast.error("Give the certification a name."); return; }
      const item: ResumeCertification = { id: uid(), name: name.trim(), issuer: issuer.trim(), date };
      onAdd(item);
    } else {
      const existingLower = new Set(existingSkillNames.map((n) => n.toLowerCase()));
      const seen = new Set<string>();
      const names = skillInput
        .split(",")
        .map((s) => s.trim())
        .filter((s) => {
          if (!s || existingLower.has(s.toLowerCase())) return false;
          const key = s.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      if (names.length === 0) { toast.error("Add at least one new skill."); return; }
      const items: ProfileSkill[] = names.map((n) => ({ id: uid(), name: n }));
      onAdd(items);
    }
    toast.success("Added to your profile — and to this role.");
    onClose();
  }

  if (!mounted) return null;

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onClose} style={{ zIndex: 99999 }}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Add {SECTION_LABELS[section]}</h2>
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
          <p className="hint compact">
            Saved to your profile and auto-selected for this role — edit or remove it later on My Profile.
          </p>

          {section === "experience" && (
            <>
              <div className="grid-2">
                <label className="field"><span>Company</span><input type="text" value={company} onChange={(e) => setCompany(e.target.value)} autoFocus /></label>
                <label className="field"><span>Title</span><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
                <label className="field"><span>Location</span><input type="text" value={location} onChange={(e) => setLocation(e.target.value)} /></label>
                <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
                  <label className="field" style={{ flex: 1 }}><span>Start</span><input type="text" value={startDate} onChange={(e) => setStartDate(e.target.value)} placeholder="Jan 2022" /></label>
                  <label className="field" style={{ flex: 1 }}><span>End</span><input type="text" value={endDate} onChange={(e) => setEndDate(e.target.value)} placeholder="Present" disabled={current} /></label>
                </div>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.78rem" }}>
                <input type="checkbox" checked={current} onChange={(e) => { setCurrent(e.target.checked); if (e.target.checked) setEndDate(""); }} />
                I currently work here
              </label>
              <MarkdownLiteField label="Description" value={description} onChange={setDescription} placeholder={"- Led a team of 5 engineers"} />
            </>
          )}

          {section === "education" && (
            <>
              <div className="grid-2">
                <label className="field"><span>School</span><input type="text" value={school} onChange={(e) => setSchool(e.target.value)} autoFocus /></label>
                <label className="field"><span>Degree</span><input type="text" value={degree} onChange={(e) => setDegree(e.target.value)} /></label>
                <label className="field"><span>Field</span><input type="text" value={field} onChange={(e) => setField(e.target.value)} /></label>
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  <label className="field" style={{ flex: 1 }}><span>Start</span><input type="text" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
                  <label className="field" style={{ flex: 1 }}><span>End</span><input type="text" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
                </div>
              </div>
              <MarkdownLiteField label="Notes (optional)" value={notes} onChange={setNotes} placeholder={"- Graduated with honors"} />
            </>
          )}

          {section === "projects" && (
            <>
              <div className="grid-2">
                <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
                <label className="field"><span>Link (optional)</span><input type="text" value={link} onChange={(e) => setLink(e.target.value)} /></label>
              </div>
              <MarkdownLiteField label="Description" value={description} onChange={setDescription} placeholder={"- Built with React and Postgres"} />
            </>
          )}

          {section === "certifications" && (
            <div className="grid-2">
              <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
              <label className="field"><span>Issuer</span><input type="text" value={issuer} onChange={(e) => setIssuer(e.target.value)} /></label>
              <label className="field"><span>Date</span><input type="text" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            </div>
          )}

          {section === "skills" && (
            <label className="field">
              <span>Skill(s)</span>
              <input
                type="text"
                value={skillInput}
                onChange={(e) => setSkillInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
                placeholder="e.g. TypeScript, React, Node.js"
                autoFocus
              />
            </label>
          )}

          <button type="button" className="btn primary" onClick={handleAdd}>Add to profile</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
