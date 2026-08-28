"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import type { AiConfig } from "@/lib/types";
import { HelpTooltip } from "./HelpTooltip";

type Props = {
  ai: AiConfig;
  // Admin-granted, read-only here — set via the Admin Portal, never by the user themselves.
  aiCredits: number;
  onSave: (ai: AiConfig) => void;
};

// The AI tab (2026-08-18) — everything AI-related in one place, its own page rather than a sub-section of
// Automail: on/off, credits, and the two behavior knobs (temperature, job-match strictness). Explicit
// "Save" button, same as every other settings form in this app — not debounced autosave, this is a
// handful of fields someone sets occasionally, not typed continuously.
export function AITab({ ai, aiCredits, onSave }: Props) {
  const [enabled, setEnabled] = useState(ai.enabled);
  const [temperature, setTemperature] = useState(ai.temperature);
  const [matchStrictness, setMatchStrictness] = useState(ai.matchStrictness);
  const [saving, setSaving] = useState(false);

  const dirty = enabled !== ai.enabled || temperature !== ai.temperature || matchStrictness !== ai.matchStrictness;

  function handleSave() {
    setSaving(true);
    onSave({ enabled, temperature, matchStrictness });
    toast.success("AI settings saved!");
    setSaving(false);
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>AI</h2>
        <span className="hint compact">
          Powered by Cuneihire's own Gemini key — no API key needed from you, just an admin-granted credit
          balance.
        </span>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: "480px" }}>
        <label className="field">
          <span>
            Enable AI Personalization
            <HelpTooltip
              title="AI Personalization"
              content={
                <>
                  <p>When on, Automail's AI reads the actual LinkedIn post and writes a unique, relevant email to the author before sending — and scores how well each scraped post matches your role criteria on Jobs &amp; Roles.</p>
                  <p>It also powers Quick Send's "Enhance with AI" and the Resume Builder's "Import from a resume."</p>
                  <p>Off just uses your static email templates as-is, and disables the AI-powered buttons elsewhere.</p>
                </>
              }
            />
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.25rem" }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: "1.2rem", height: "1.2rem" }}
            />
            <span style={{ fontSize: "0.85rem", color: enabled ? "var(--ok)" : "var(--muted)" }}>
              {enabled ? "Active" : "Inactive"}
            </span>
          </div>
        </label>

        <p className="hint compact">
          <strong>Credits remaining: {aiCredits}</strong> — each AI-personalized email, job-match score, or
          AI-assisted action spends one. Out of credits? Ask an admin to grant more.
        </p>

        <div style={{ opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? "auto" : "none", transition: "opacity 0.2s", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <hr style={{ border: "0", borderTop: "1px solid var(--line)", margin: 0 }} />

          <label className="field">
            <span>
              Temperature — {temperature.toFixed(1)}
              <HelpTooltip
                title="Temperature"
                content={
                  <>
                    <p>How much the AI varies its wording run to run. Low (0.0–0.3) stays close, consistent, and predictable. High (0.7–1.0) is more creative and varied, at some cost to consistency.</p>
                    <p>Applies to every AI call — personalized emails, job-match scoring, Quick Send's enhance, and resume import.</p>
                  </>
                }
              />
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
            />
            <span className="hint compact">Focused &amp; consistent ↔ Creative &amp; varied</span>
          </label>

          <label className="field">
            <span>
              Job-Match Strictness — {matchStrictness === 0 ? "Off" : matchStrictness}
              <HelpTooltip
                title="Job-Match Strictness"
                content={
                  <>
                    <p>Scraping now checks this too: a post scored below this against a role's criteria on Jobs &amp; Roles is never saved as a contact in the first place — it's judged and skipped, not left "not analyzed."</p>
                    <p>Automail's fully-automated background sends still also check it as a second safety net — skipping a recipient entirely (no template, no AI, no send, no credit spent) if an older, already-saved one scores below this.</p>
                    <p>A post that hasn't been scored yet is <strong>never</strong> skipped by either — only ones that were actually scored low.</p>
                    <p>This has no effect on JAMS's manual or bulk sends — those go out exactly as you asked, regardless of score.</p>
                  </>
                }
              />
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={matchStrictness}
              onChange={(e) => setMatchStrictness(Number(e.target.value))}
            />
            <span className="hint compact">0 = off, send to everyone regardless of match score</span>
          </label>
        </div>

        <p className="hint compact">Your info is set on the <strong>Profile</strong> page.</p>

        <div>
          <button type="button" className="btn primary" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save AI Settings"}
          </button>
        </div>
      </div>
    </section>
  );
}
