"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import type { AutoFetchConfig, RoleDef } from "@/lib/types";
import { HelpTooltip } from "./HelpTooltip";

type Props = {
  config: AutoFetchConfig;
  roleDefs: RoleDef[];
  onSave: (newConfig: AutoFetchConfig) => void;
  onClose: () => void;
};

// Candidate-facing config, simplified (2026-08-25, operator ask — "the client does not need to know
// these things"). Pagination limit/delay and the raw cookie/header plumbing are real settings the
// scraper worker still needs, but they're now fixed sane defaults (DEFAULT_PAGINATION_LIMIT/DELAY below)
// rather than something a candidate tunes — only "how often" (interval) and the post-age filter stay
// user-facing. li_at/JSESSIONID/rawHeaders are no longer hand-entered at all: they only ever come from a
// real extension extraction (handleConnect), which also auto-saves immediately on success — no separate
// "Save" step for connecting, matching "the user will only see LinkedIn connected, active or inactive."
const DEFAULT_PAGINATION_LIMIT = 3;
const DEFAULT_PAGINATION_DELAY_SEC = 10;

export function AutoFetchModal({ config, roleDefs, onSave, onClose }: Props) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [intervalMin, setIntervalMin] = useState(config.intervalMin || 180);
  const [postAgeFilter, setPostAgeFilter] = useState<AutoFetchConfig["postAgeFilter"]>(config.postAgeFilter || "any");

  // Connection state — never hand-edited, only ever set by a real extraction (handleConnect) or carried
  // forward unchanged from the existing config.
  const [liAt, setLiAt] = useState(config.liAt);
  const [jsessionid, setJsessionid] = useState(config.jsessionid || "");
  const [rawHeaders, setRawHeaders] = useState(config.rawHeaders || "{}");
  const [connectedUsername, setConnectedUsername] = useState<string | null>(null);

  const [mounted, setMounted] = useState(false);
  const [extensionInstalled, setExtensionInstalled] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMounted(true);
    const checkExtension = () => {
      if (document.querySelector('meta[name="automail-extension-installed"]')) setExtensionInstalled(true);
    };
    // Check now, then keep polling — covers "installed the extension, came back to this open tab"
    // without needing a manual refresh nudge every time.
    checkExtension();
    const interval = setInterval(checkExtension, 1000);
    return () => clearInterval(interval);
  }, []);

  const isConnected = liAt.trim().length > 0 && jsessionid.trim().length > 0;

  const totalKeywords = roleDefs.reduce((sum, d) => sum + d.keywords.length, 0);
  const rolesWithKeywords = roleDefs.filter((d) => d.keywords.length > 0).length;
  const hasKeywords = totalKeywords > 0;

  const canEnable = isConnected && hasKeywords;

  function buildConfig(overrides: Partial<AutoFetchConfig> = {}): AutoFetchConfig {
    const nextEnabled = overrides.enabled ?? enabled;
    return {
      enabled: nextEnabled && canEnable,
      intervalMin: Math.max(180, intervalMin || 180),
      paginationLimit: config.paginationLimit || DEFAULT_PAGINATION_LIMIT,
      paginationDelaySec: config.paginationDelaySec || DEFAULT_PAGINATION_DELAY_SEC,
      liAt: liAt.trim(),
      jsessionid: jsessionid.trim(),
      rawHeaders,
      postAgeFilter,
      ...overrides,
    };
  }

  async function handleSave() {
    const finalConfig = buildConfig();
    if (finalConfig.enabled) {
      setSaving(true);
      try {
        const res = await fetch("/api/verify-linkedin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ liAt: finalConfig.liAt, jsessionid: finalConfig.jsessionid, rawHeaders: finalConfig.rawHeaders }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          toast.error(data.error || "LinkedIn validation failed");
          setSaving(false);
          return;
        }
      } catch {
        toast.error("Network error validating your LinkedIn connection");
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    onSave(finalConfig);
    toast.success("Auto-fetch settings saved!");
    onClose();
  }

  function handleConnect() {
    const isInstalledNow = !!document.querySelector('meta[name="automail-extension-installed"]');
    if (!isInstalledNow) {
      toast.error("Extension not detected — install it below, then come back here.");
      return;
    }
    setConnecting(true);

    const handleResponse = (e: any) => {
      window.removeEventListener("AUTOMAILEXT_RECEIVE_COOKIE", handleResponse);
      setConnecting(false);
      const data = e.detail;
      if (!data?.success || !data.jsessionid || !data.li_at) {
        toast.error(data?.error || "Couldn't connect — make sure you're logged into LinkedIn in this browser.");
        return;
      }

      const cleanJsession = data.jsessionid.startsWith("ajax:") ? data.jsessionid : `ajax:${data.jsessionid}`;
      const perfectHeaders = {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: "https://www.linkedin.com",
        Referer: "https://www.linkedin.com/preload/?_bprMode=vanilla",
        "User-Agent": navigator.userAgent,
        "x-restli-protocol-version": "2.0.0",
        "csrf-token": cleanJsession,
        Cookie: `li_at=${data.li_at}; JSESSIONID="${cleanJsession}";`,
      };
      const headersJson = JSON.stringify(perfectHeaders, null, 2);

      setLiAt(data.li_at);
      setJsessionid(cleanJsession);
      setRawHeaders(headersJson);
      setConnectedUsername(data.username && data.username !== "LinkedIn User" ? data.username : null);

      // Auto-save immediately — connecting IS the action here, no separate "Save" step (operator ask:
      // "automatically fills that information into the database... will automatically be updated").
      onSave(
        buildConfig({
          liAt: data.li_at,
          jsessionid: cleanJsession,
          rawHeaders: headersJson,
          enabled: hasKeywords, // auto-activate once connected, same as before, still gated on keywords existing
        })
      );
      toast.success(data.username && data.username !== "LinkedIn User" ? `LinkedIn connected — welcome, ${data.username}!` : "LinkedIn connected!");
    };

    window.addEventListener("AUTOMAILEXT_RECEIVE_COOKIE", handleResponse);
    window.dispatchEvent(new CustomEvent("AUTOMAILEXT_REQUEST_COOKIE"));
  }

  function handleDisconnect() {
    setLiAt("");
    setJsessionid("");
    setRawHeaders("{}");
    setConnectedUsername(null);
    setEnabled(false);
    onSave(buildConfig({ liAt: "", jsessionid: "", rawHeaders: "{}", enabled: false }));
    toast.success("LinkedIn disconnected.");
  }

  if (!mounted) return null;

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onClose} style={{ zIndex: 99999 }}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="autofetch-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 id="autofetch-modal-title">LinkedIn Auto-Fetch</h2>
            <p className="hint compact">Background workers automatically fetch matching posts based on your role keywords.</p>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </div>

        <div className="modal-body">
          {/* Connection status — the one thing candidates need to see: connected or not, active or not. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0.85rem 1rem",
              borderRadius: "10px",
              border: `1px solid ${isConnected ? "var(--ok)" : "var(--line)"}`,
              background: isConnected ? "color-mix(in srgb, var(--ok) 8%, transparent)" : "var(--bg-card)",
              marginBottom: "1rem",
            }}
          >
            <div>
              <div style={{ fontWeight: 650, display: "flex", alignItems: "center", gap: "0.4rem" }}>
                {isConnected ? "✅ LinkedIn Connected" : "⚪ LinkedIn Not Connected"}
              </div>
              <p className="hint compact" style={{ margin: "0.15rem 0 0" }}>
                {isConnected
                  ? connectedUsername
                    ? `Connected as ${connectedUsername}`
                    : "Ready to search LinkedIn for matching posts."
                  : "Connect your LinkedIn account to start auto-fetching."}
              </p>
            </div>
            {isConnected && (
              <button type="button" className="btn ghost small" onClick={handleDisconnect}>Disconnect</button>
            )}
          </div>

          {!extensionInstalled ? (
            <div style={{ border: "1px solid var(--line)", borderRadius: "10px", padding: "1rem", marginBottom: "1rem" }}>
              <h3 style={{ fontSize: "0.9rem", margin: "0 0 0.5rem" }}>Install the Cuneihire extension</h3>
              <ol style={{ margin: "0 0 0.85rem", paddingLeft: "1.2rem", fontSize: "0.85rem", color: "var(--muted)", lineHeight: 1.7 }}>
                <li>Download the extension below and unzip it.</li>
                <li>Open <code>chrome://extensions</code> in a new tab.</li>
                <li>Turn on <strong>Developer mode</strong> (top-right toggle).</li>
                <li>Click <strong>Load unpacked</strong> and select the unzipped folder.</li>
                <li>Come back to this tab (refresh if needed) and click <strong>Connect LinkedIn</strong> below.</li>
              </ol>
              <a
                href="/cuneihire-extension.zip"
                download="cuneihire-extension.zip"
                className="btn small"
                style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
                Download Extension
              </a>
            </div>
          ) : (
            <button
              type="button"
              className="btn primary large"
              onClick={handleConnect}
              disabled={connecting}
              style={{ width: "100%", marginBottom: "1rem" }}
            >
              {connecting ? "Connecting…" : isConnected ? "Reconnect LinkedIn" : "Connect LinkedIn"}
            </button>
          )}

          <p className="hint compact" style={{ display: "flex", alignItems: "center", gap: "0.3rem", marginBottom: "0.75rem" }}>
            {hasKeywords
              ? `${totalKeywords} keyword(s) across ${rolesWithKeywords} role(s) — manage on Jobs & Roles`
              : "No keywords configured yet — add some on Jobs & Roles before connecting"}
            <HelpTooltip
              title="Search Keywords"
              content={<p>Keywords live on each role, on the <strong>Jobs & Roles</strong> page — the scraper searches every keyword across every role and tags results with that role automatically.</p>}
            />
          </p>

          <hr style={{ border: "0", borderTop: "1px solid var(--line)", margin: "0.5rem 0 1rem" }} />

          <label className="field">
            <span>
              Enabled
              {!canEnable && <span className="hint" style={{ marginLeft: "0.5rem", color: "var(--err)" }}>(Connect LinkedIn and add keywords first)</span>}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.25rem" }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                disabled={!canEnable}
                style={{ width: "1.2rem", height: "1.2rem" }}
              />
              <span style={{ fontSize: "0.85rem", color: enabled ? "var(--ok)" : "var(--muted)" }}>{enabled ? "Active" : "Inactive"}</span>
            </div>
          </label>

          <label className="field" style={{ marginTop: "0.75rem" }}>
            <span>
              Run interval (minutes)
              <HelpTooltip
                title="Fetch Interval"
                content={
                  <>
                    <p>How often should we check LinkedIn for new posts?</p>
                    <p><strong>Recommendation:</strong> 5–10 minutes. Too low and LinkedIn may temporarily block your account.</p>
                  </>
                }
              />
            </span>
            <input
              id="tour-autofetch-interval"
              type="number"
              min={180}
              max={1440}
              value={intervalMin}
              onChange={(e) => setIntervalMin(Number(e.target.value) || 180)}
            />
          </label>

          <label className="field" style={{ marginTop: "0.75rem", marginBottom: "1rem" }}>
            <span>
              Post Age Filter
              <HelpTooltip
                title="Post Age Filter"
                content={
                  <>
                    <p>Only fetch LinkedIn posts published within this timeframe.</p>
                    <p><strong>Past 24 hours</strong> keeps you reaching out to fresh, active leads.</p>
                  </>
                }
              />
            </span>
            <select
              id="tour-autofetch-postage"
              value={postAgeFilter}
              onChange={(e) => setPostAgeFilter(e.target.value as any)}
              style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--line)", background: "var(--bg-panel)", color: "var(--fg)" }}
            >
              <option value="24h">Past 24 hours (Recommended)</option>
              <option value="1w">Past 1 week</option>
              <option value="1m">Past 1 month</option>
              <option value="all">Any time</option>
            </select>
          </label>

          <button type="button" className="btn primary large" onClick={handleSave} disabled={saving} style={{ marginTop: "0.5rem" }}>
            {saving ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
