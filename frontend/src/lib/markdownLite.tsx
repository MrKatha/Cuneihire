import type { ReactNode } from "react";

// A deliberately tiny, non-CommonMark syntax for resume description fields (2026-08-19) — just what the
// operator asked for: bullet points and bold, nothing else. A line starting with "- " or "* " is a bullet
// point (consecutive bullet lines group into one block, each rendered as an explicit "•" glyph — not a
// native <ul>/<li>, see flushBullets below for why); "**text**" anywhere is bold. Everything else is a
// plain paragraph line. See ResumeBuilder.tsx's MarkdownLiteField for the editing side.
//
// Per-line pagination atoms (2026-08-20, operator ask) — "we do not break the whole section... it's better
// to break just the line. If the line is getting on the edge of the page, just take that line to the next
// page." Each bullet row and each plain paragraph gets its own `data-page-atom`/`data-atom-key` (see
// lib/resumeTemplates/ModernTemplate.tsx's header comment for the convention) when the caller passes an
// `atomKeyPrefix` — computePageBreaks then breaks between individual lines instead of only between whole
// entries, so a long description spills its overflow bullets onto the next page instead of dragging its
// entire entry along. The entry's own heading (company/title/dates) is marked as its own atom separately,
// by the template — see e.g. ModernTemplate.tsx's Experience block — so this only ever needs to cover the
// description's lines.

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== "");
  if (parts.length === 0) return [text];
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
      : <span key={`${keyPrefix}-${i}`}>{part}</span>
  );
}

export function renderMarkdownLite(text: string | undefined | null, atomKeyPrefix?: string): ReactNode {
  if (!text || !text.trim()) return null;
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let bulletBuffer: string[] = [];
  let atomCounter = 0;
  const nextAtomKey = () => (atomKeyPrefix ? `${atomKeyPrefix}-l${atomCounter++}` : undefined);

  // Bullets are rendered as an explicit "•" character in its own span, not a native <ul>/<li> with a
  // browser-drawn list-style marker (2026-08-20, bug fix) — html2canvas (the pipeline behind every
  // generated/emailed PDF, see lib/resumePdf.tsx) is unreliable about painting native list markers, so a
  // bullet that looked fine in the live DOM could vanish or misrender in the actual PDF. An explicit glyph
  // renders identically everywhere: the live preview, native print ("Download PDF"), and the html2canvas
  // snapshot.
  function flushBullets(key: string) {
    if (bulletBuffer.length === 0) return;
    const items = bulletBuffer;
    bulletBuffer = [];
    blocks.push(
      <div key={key} style={{ margin: "3pt 0" }}>
        {items.map((b, i) => {
          const atomKey = nextAtomKey();
          return (
            <div
              key={i}
              data-page-atom={atomKey ? "true" : undefined}
              data-atom-key={atomKey}
              style={{ display: "flex", gap: "5pt", margin: "1pt 0", breakInside: "avoid" }}
            >
              <span aria-hidden="true">•</span>
              <span style={{ flex: 1 }}>{renderInline(b, `${key}-li-${i}`)}</span>
            </div>
          );
        })}
      </div>
    );
  }

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // \s* not \s+ (2026-08-20, bug fix) — real content (especially AI-imported resume text) often has no
    // space after the marker at all ("-Led a team…" not "- Led a team…"); requiring one made every such
    // line fall through as a literal paragraph starting with a bare "-", which is exactly the "still shows
    // as minus" symptom. `.+` (not `.*`) so a lone "-" with nothing after it still isn't treated as a bullet.
    const bulletMatch = /^[-*]\s*(.+)$/.exec(trimmed);
    if (bulletMatch) {
      bulletBuffer.push(bulletMatch[1]);
      return;
    }
    flushBullets(`bl-${i}`);
    if (trimmed === "") return; // a blank line just separates paragraphs, not rendered itself
    const atomKey = nextAtomKey();
    blocks.push(
      <p key={`p-${i}`} data-page-atom={atomKey ? "true" : undefined} data-atom-key={atomKey} style={{ margin: "2pt 0", breakInside: "avoid" }}>
        {renderInline(trimmed, `p-${i}`)}
      </p>
    );
  });
  flushBullets("bl-end");

  return <>{blocks}</>;
}

// Splits plain, non-markdown multi-line text (Summary — preserves the operator's exact line breaks, never
// parsed for bullets/bold) into the same kind of per-line pagination atom as renderMarkdownLite above, for
// the same reason: a long summary shouldn't drag its entire block to the next page over one overflowing
// line. Renders one block per source line instead of a single `white-space:pre-wrap` block so each line is
// independently measurable/breakable; a blank source line still reserves its line-height so paragraph
// spacing looks identical to before.
export function renderPlainLines(text: string | undefined | null, atomKeyPrefix: string): ReactNode {
  if (!text || !text.trim()) return null;
  let counter = 0;
  return (
    <>
      {text.split("\n").map((line, i) =>
        line.trim() === "" ? (
          <div key={i} style={{ whiteSpace: "pre-wrap" }}>{" "}</div>
        ) : (
          <div key={i} data-page-atom="true" data-atom-key={`${atomKeyPrefix}-l${counter++}`} style={{ whiteSpace: "pre-wrap", breakInside: "avoid" }}>
            {line}
          </div>
        )
      )}
    </>
  );
}
