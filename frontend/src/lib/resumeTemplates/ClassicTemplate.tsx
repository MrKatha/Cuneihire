import type { ResumeData } from "@/lib/types";
import { defaultResumeStyle } from "@/lib/types";
import { renderMarkdownLite, renderPlainLines } from "@/lib/markdownLite";

// The second of two "1–2 clean, functional layouts" for v1 — a traditional, centered, serif, black-and-
// white layout (no color accents) for a more conservative/ATS-conventional look. Safe system font stack.
//
// `data-page-atom="true"` / `data-atom-key` (2026-08-20; granularity changed 2026-08-20, operator ask) —
// see ModernTemplate.tsx's header comment for both conventions and the line-level-breaking rationale; same
// here. Typography (font/size/line-height/letter-spacing) also follows the same em-relative-to-root-
// fontSize scheme documented there — 10.5pt was this template's own previous hardcoded base, kept as the
// ratio denominator so existing proportions are preserved exactly at the default settings.
export function ClassicTemplate({ data }: { data: ResumeData }) {
  const { personalInfo: p, summary, experience, education, skills, projects, certifications, languages } = data;
  const s = data.style ?? defaultResumeStyle();
  const contactLine = [p.location, p.email, p.phone, p.portfolioUrl, p.linkedinUrl].filter(Boolean).join("  |  ");

  return (
    <div
      style={{
        fontFamily: s.fontFamily,
        color: "#1a1a1a",
        fontSize: `${s.fontSizePt}pt`,
        lineHeight: s.lineHeight,
        letterSpacing: `${s.letterSpacingEm}em`,
        ["--rf-tracking" as string]: `${s.letterSpacingEm}em`,
      }}
    >
      <div data-page-atom="true" data-atom-key="header" style={{ textAlign: "center", marginBottom: "1.33em" }}>
        <h1 style={{ margin: 0, fontSize: "1.9em", fontWeight: 700, letterSpacing: "calc(var(--rf-tracking) + 0.03em)" }}>
          {(p.fullName || "Your Name").toUpperCase()}
        </h1>
        {p.title && <p style={{ margin: "0.29em 0 0", fontSize: "1.05em", fontStyle: "italic" }}>{p.title}</p>}
        {contactLine && <p style={{ margin: "0.48em 0 0", fontSize: "0.86em", color: "#444" }}>{contactLine}</p>}
      </div>

      {summary && (
        <Section title="Summary">
          <div style={{ margin: 0 }}>{renderPlainLines(summary, "summary")}</div>
        </Section>
      )}

      {experience.length > 0 && (
        <Section title="Experience">
          {experience.map((e) => (
            <div key={e.id} style={{ marginBottom: "0.86em" }}>
              <div data-page-atom="true" data-atom-key={e.id} style={{ breakInside: "avoid" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.76em" }}>
                  <strong style={{ fontSize: "1em" }}>{e.company}</strong>
                  <span style={{ fontSize: "0.86em", whiteSpace: "nowrap" }}>
                    {e.startDate}{(e.startDate || e.endDate || e.current) && " – "}{e.current ? "Present" : e.endDate}
                  </span>
                </div>
                <div style={{ fontStyle: "italic", fontSize: "0.95em" }}>{e.title}{e.location ? `, ${e.location}` : ""}</div>
              </div>
              {renderMarkdownLite(e.description, e.id)}
            </div>
          ))}
        </Section>
      )}

      {education.length > 0 && (
        <Section title="Education">
          {education.map((ed) => (
            <div key={ed.id} style={{ marginBottom: "0.67em" }}>
              <div data-page-atom="true" data-atom-key={ed.id} style={{ breakInside: "avoid" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.76em" }}>
                  <strong style={{ fontSize: "1em" }}>{ed.school}</strong>
                  <span style={{ fontSize: "0.86em", whiteSpace: "nowrap" }}>{ed.startDate}{(ed.startDate || ed.endDate) && " – "}{ed.endDate}</span>
                </div>
                <div style={{ fontStyle: "italic", fontSize: "0.95em" }}>{ed.degree}{ed.field ? `, ${ed.field}` : ""}</div>
              </div>
              <div style={{ fontSize: "0.9em" }}>{renderMarkdownLite(ed.notes, ed.id)}</div>
            </div>
          ))}
        </Section>
      )}

      {projects.length > 0 && (
        <Section title="Projects">
          {projects.map((pr) => (
            <div key={pr.id} style={{ marginBottom: "0.76em" }}>
              <div data-page-atom="true" data-atom-key={pr.id} style={{ breakInside: "avoid" }}>
                <strong style={{ fontSize: "1em" }}>{pr.name}</strong>
                {pr.link && <span style={{ fontSize: "0.86em" }}> — {pr.link}</span>}
              </div>
              {renderMarkdownLite(pr.description, pr.id)}
            </div>
          ))}
        </Section>
      )}

      {skills.length > 0 && (
        <Section title="Skills">
          <p data-page-atom="true" data-atom-key="skills" style={{ margin: 0 }}>{skills.join(", ")}</p>
        </Section>
      )}

      {certifications.length > 0 && (
        <Section title="Certifications">
          {certifications.map((c) => (
            <div key={c.id} data-page-atom="true" data-atom-key={c.id} style={{ fontSize: "0.9em", marginBottom: "0.19em", breakInside: "avoid" }}>
              <strong>{c.name}</strong>{c.issuer && ` — ${c.issuer}`}{c.date && ` (${c.date})`}
            </div>
          ))}
        </Section>
      )}

      {languages.length > 0 && (
        <Section title="Languages">
          <p data-page-atom="true" data-atom-key="languages" style={{ margin: 0, fontSize: "0.9em" }}>
            {languages.map((l) => `${l.name}${l.level ? ` (${l.level})` : ""}`).join(", ")}
          </p>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "1.14em", breakInside: "avoid" }}>
      <h2 style={{
        margin: "0 0 0.48em",
        fontSize: "1em",
        fontWeight: 700,
        letterSpacing: "calc(var(--rf-tracking) + 0.08em)",
        textTransform: "uppercase",
        textAlign: "center",
        borderBottom: "1.5px solid #1a1a1a",
        paddingBottom: "0.29em",
      }}>
        {title}
      </h2>
      {children}
    </div>
  );
}
