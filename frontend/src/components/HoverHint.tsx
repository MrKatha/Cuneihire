"use client";

import type { ReactNode } from "react";

// A pure-CSS hover popover (2026-08-19) — deliberately distinct from HelpTooltip.tsx's click-to-open
// modal: this is for a quick reference glance (e.g. "what syntax do I type here") that shouldn't demand a
// click, mid-typing, to see. Reuses the same round "?" badge styling (.help-tooltip-btn) for visual
// consistency with HelpTooltip, just swaps the trigger/behavior.
export function HoverHint({ content }: { content: ReactNode }) {
  return (
    <span className="hover-hint" tabIndex={0}>
      <span className="help-tooltip-btn" aria-hidden="true">?</span>
      <span className="hover-hint-panel" role="tooltip">{content}</span>
    </span>
  );
}
