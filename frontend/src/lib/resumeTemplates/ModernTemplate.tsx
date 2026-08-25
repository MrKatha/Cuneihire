import type { ResumeData } from "@/lib/types";
import { defaultResumeStyle } from "@/lib/types";
import { renderMarkdownLite, renderPlainLines } from "@/lib/markdownLite";

// One of two "1–2 clean, functional layouts" for v1 (design pass deferred, per the operator's own
// standing direction this session) — a plain sans-serif, single-column, ATS-friendly layout. Safe system
// font stack (not the app's webfonts) so print output never depends on a font-load race.
//
// `data-page-atom="true"` (2026-08-20; granularity changed 2026-08-20, operator ask — "we do not break the
// whole section... it's better to break just the line") marks every block that pagination must never cut
// through. That's no longer one atom per whole entry: each entry's *heading* (company/title/dates/location)
// is its own atom, and each line of its description is its own separate atom (see markdownLite.tsx's
// renderMarkdownLite/renderPlainLines) — so a long entry spills only its overflow lines onto the next page
// instead of dragging the whole entry along, while a single line/bullet is still never cut mid-line.
// Deliberately never nested (an atom's own children never carry the attribute) so lib/resumePaginate.ts's
// computePageBreaks can measure them with a flat query. See lib/resumePdf.tsx (PDF generation) and
// ResumeBuilder.tsx (live preview) for the two consumers.
//
// `data-atom-key` (2026-08-20) pairs each atom with the same stable key (an entry's `.id`, or a fixed
// string for the single-block sections) used on the corresponding editor-side block in ResumeBuilder.tsx —
// computePageBreaks reports which page each key lands on, which is how the editor's scroll position gets
// translated into "which page should the preview show."
//
// Typography (2026-08-20, operator ask) — every font-size below is an em multiple of the root's own
// fontSize (10.5pt was the previous hardcoded base, kept as the ratio denominator), so changing
// data.style.fontSizePt scales the whole document proportionally rather than just the body text. Only the
// root sets lineHeight/fontFamily directly (everything else inherits). Letter-spacing is different: h1 and
// Section's h2 already hardcode their own tracking as a *design* choice (tight for the name, wide for
// section labels) — a literal inline letterSpacing on those would override rather than add to the root's
// inherited value, silently ignoring the operator's control, so both compose the user's setting via the
// `--rf-tracking` custom property instead of hardcoding a fresh value.
export function ModernTemplate({ data }: { data: ResumeData }) {
  const { personalInfo: p, summary, experience, education, skills, projects, certifications, languages } = data;
  const s = data.style ?? defaultResumeStyle();
  const contactLine = [p.location, p.email, p.phone, p.portfolioUrl, p.linkedinUrl].filter(Boolean).join("  ·  ");

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
      <div data-page-atom="true" data-atom-key="header" style={{ marginBottom: "1.33em" }}>
        <h1 style={{ margin: 0, fontSize: "2.1em", fontWeight: 700, letterSpacing: "calc(var(--rf-tracking) + -0.01em)" }}>{p.fullName || "Your Name"}</h1>
        {p.title && <p style={{ margin: "0.19em 0 0", fontSize: "1.14em", color: "#c9520e", fontWeight: 600 }}>{p.title}</p>}
        {contactLine && <p style={{ margin: "0.48em 0 0", fontSize: "0.86em", color: "#555" }}>{contactLine}</p>}
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
                  <strong style={{ fontSize: "1em" }}>{e.title}{e.company ? ` · ${e.company}` : ""}</strong>
                  <span style={{ fontSize: "0.86em", color: "#666", whiteSpace: "nowrap" }}>
                    {e.startDate}{(e.startDate || e.endDate || e.current) && " – "}{e.current ? "Present" : e.endDate}
                  </span>
                </div>
                {e.location && <div style={{ fontSize: "0.86em", color: "#666" }}>{e.location}</div>}
              </div>
              {renderMarkdownLite(e.description, e.id)}
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
                {pr.link && <span style={{ fontSize: "0.86em", color: "#666" }}> — {pr.link}</span>}
              </div>
              {renderMarkdownLite(pr.description, pr.id)}
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
                  <strong style={{ fontSize: "1em" }}>{ed.degree}{ed.field ? `, ${ed.field}` : ""}</strong>
                  <span style={{ fontSize: "0.86em", color: "#666", whiteSpace: "nowrap" }}>{ed.startDate}{(ed.startDate || ed.endDate) && " – "}{ed.endDate}</span>
                </div>
                <div style={{ fontSize: "0.9em" }}>{ed.school}</div>
              </div>
              <div style={{ fontSize: "0.9em", color: "#555" }}>{renderMarkdownLite(ed.notes, ed.id)}</div>
            </div>
          ))}
        </Section>
      )}

      {skills.length > 0 && (
        <Section title="Skills">
          <div data-page-atom="true" data-atom-key="skills" style={{ display: "flex", flexWrap: "wrap", gap: "0.48em" }}>
            {skills.map((sk, i) => (
              <span key={i} style={{ fontSize: "0.86em", background: "#f3f1ec", border: "1px solid #ddd", borderRadius: "999px", padding: "0.14em 0.76em" }}>{sk}</span>
            ))}
          </div>
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
            {languages.map((l) => `${l.name}${l.level ? ` (${l.level})` : ""}`).join("  ·  ")}
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
        fontSize: "0.9em",
        fontWeight: 700,
        letterSpacing: "calc(var(--rf-tracking) + 0.06em)",
        textTransform: "uppercase",
        color: "#c9520e",
        borderBottom: "1px solid #e5e1d6",
        paddingBottom: "0.29em",
      }}>
        {title}
      </h2>
      {children}
    </div>
  );
}
