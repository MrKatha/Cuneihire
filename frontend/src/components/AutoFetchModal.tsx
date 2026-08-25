"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import type { AutoFetchConfig, RoleDef } from "@/lib/types";
import { HelpTooltip } from "./HelpTooltip";
import { CookieHelpModal } from "./CookieHelpModal";

type Props = {
  config: AutoFetchConfig;
  roleDefs: RoleDef[];
  onSave: (newConfig: AutoFetchConfig) => void;
  onClose: () => void;
};

export function AutoFetchModal({ config, roleDefs, onSave, onClose }: Props) {
  const [enabled, setEnabled] = useState(config.enabled);

  const [intervalMin, setIntervalMin] = useState(config.intervalMin || 180);
  const [paginationLimit, setPaginationLimit] = useState(config.paginationLimit || 3);
  const [paginationDelaySec, setPaginationDelaySec] = useState(config.paginationDelaySec || 10);
  const [liAt, setLiAt] = useState(config.liAt);
  const [jsessionid, setJsessionid] = useState(config.jsessionid || "ajax:");
  const [rawHeaders, setRawHeaders] = useState(config.rawHeaders || "{}");
  const [postAgeFilter, setPostAgeFilter] = useState<AutoFetchConfig["postAgeFilter"]>(config.postAgeFilter || "any");
  const [showTokens, setShowTokens] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  
  const [manualKey, setManualKey] = useState<string>("");
  const [manualValue, setManualValue] = useState<string>("");

  const [mounted, setMounted] = useState(false);
  const [extensionInstalled, setExtensionInstalled] = useState(false);
  
  useEffect(() => {
    setMounted(true);
    
    const checkExtension = () => {
      const hasMarker = document.querySelector('meta[name="automail-extension-installed"]');
      if (hasMarker) {
        setExtensionInstalled(true);
      }
    };
    
    // Check initially and then poll every second in case they install it while the modal is open
    checkExtension();
    const interval = setInterval(checkExtension, 1000);
    
    return () => clearInterval(interval);
  }, []);

  // Regex validation
  const isJsessionValid = jsessionid === "" || /^ajax:\d+$/.test(jsessionid);
  const isLiAtValid = liAt === "" || /^[a-zA-Z0-9_-]{20,}$/.test(liAt);

  // Keywords now live per-role (see the Jobs & Roles page) — enabling requires at least one role to
  // have at least one keyword configured there.
  const totalKeywords = roleDefs.reduce((sum, d) => sum + d.keywords.length, 0);
  const rolesWithKeywords = roleDefs.filter((d) => d.keywords.length > 0).length;
  const hasKeywords = totalKeywords > 0;

  // Attempt to parse rawHeaders to display what was found
  let parsedHeaders: Record<string, string> | null = null;
  try {
    if (rawHeaders.trim().startsWith('{')) {
      parsedHeaders = JSON.parse(rawHeaders);
      const keys = Object.keys(parsedHeaders!).map(k => k.toLowerCase());
      if (!keys.includes('csrf-token') && jsessionid && jsessionid !== "ajax:") {
         parsedHeaders!['csrf-token'] = jsessionid.trim().replace(/"/g, '');
      }
    }
  } catch {
    // Ignore parsing errors for display
  }

  const REQUIRED_HEADERS = [
    "Cookie",
    "Accept",
    "Content-Type",
    "Origin",
    "Referer",
    "User-Agent",
    "csrf-token",
    "x-restli-protocol-version"
  ];

  let missingHeaders: string[] = [];
  if (parsedHeaders) {
    const keys = Object.keys(parsedHeaders).map(k => k.toLowerCase());
    missingHeaders = REQUIRED_HEADERS.filter(h => !keys.includes(h.toLowerCase()));
  } else {
    missingHeaders = [...REQUIRED_HEADERS];
  }

  const hasAllHeaders = missingHeaders.length === 0;

  // Validate before enabling
  const canEnable = 
    liAt.trim().length > 0 && 
    jsessionid.trim().length > 0 && 
    isJsessionValid && 
    isLiAtValid &&
    hasKeywords &&
    hasAllHeaders;

  async function handleSave() {
    // Force disable if tokens are missing when saving
    const finalEnabled = enabled && canEnable;
    // Enforce minimum interval
    const finalInterval = Math.max(180, intervalMin || 180);

    if (finalEnabled) {
      setIsVerifying(true);
      try {
        const res = await fetch("/api/verify-linkedin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            liAt: liAt.trim(),
            jsessionid: jsessionid.trim(),
            rawHeaders,
          }),
        });
        
        const data = await res.json();
        if (!res.ok || !data.success) {
          toast.error(data.error || "LinkedIn validation failed");
          setIsVerifying(false);
          return;
        }
      } catch {
        toast.error("Network error validating cookies");
        setIsVerifying(false);
        return;
      }
      setIsVerifying(false);
    }

    let finalRawHeaders = rawHeaders;
    try {
      if (rawHeaders.trim().startsWith('{')) {
        const parsed = JSON.parse(rawHeaders);
        const keys = Object.keys(parsed).map(k => k.toLowerCase());
        if (!keys.includes('csrf-token') && jsessionid && jsessionid !== "ajax:") {
           parsed['csrf-token'] = jsessionid.trim().replace(/"/g, '');
        }

        // Strictly keep ONLY required headers
        const sanitized: Record<string, string> = {};
        const allowedKeys = REQUIRED_HEADERS.map(h => h.toLowerCase());
        for (const [k, v] of Object.entries(parsed)) {
          const lowerK = k.toLowerCase();
          if (allowedKeys.includes(lowerK)) {
            const properKey = REQUIRED_HEADERS.find(r => r.toLowerCase() === lowerK) || k;
            sanitized[properKey] = v as string;
          }
        }
        finalRawHeaders = JSON.stringify(sanitized, null, 2);
      }
    } catch {}

      onSave({
        enabled: finalEnabled,
        intervalMin: finalInterval,
        paginationLimit: Math.max(3, paginationLimit || 3),
        paginationDelaySec: Math.max(1, paginationDelaySec || 10),
        liAt: liAt.trim(),
        jsessionid: jsessionid.trim(),
        rawHeaders: finalRawHeaders,
        postAgeFilter,
      });
    
    toast.success("Auto-fetch configuration saved!");
    onClose();
  }
  
  function handleAutoDetect() {
    const isInstalledNow = !!document.querySelector('meta[name="automail-extension-installed"]');
    if (isInstalledNow && !extensionInstalled) {
      setExtensionInstalled(true);
    }
    
    if (!isInstalledNow) {
      toast.error("Extension not detected. Please install the Automail LinkedIn Cookie Extractor first.");
      return;
    }
    
    // Listen for the response once
    const handleResponse = (e: any) => {
      window.removeEventListener("AUTOMAILEXT_RECEIVE_COOKIE", handleResponse);
      const data = e.detail;
      if (data && data.success && data.jsessionid && data.li_at) {
        // Ensure we don't double up on 'ajax:'
        const cleanJsession = data.jsessionid.startsWith('ajax:') ? data.jsessionid : `ajax:${data.jsessionid}`;
        
        setJsessionid(cleanJsession);
        setLiAt(data.li_at);
        
        // Construct the full perfect rawHeaders payload automatically!
        const perfectHeaders = {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Origin": "https://www.linkedin.com",
          "Referer": "https://www.linkedin.com/preload/?_bprMode=vanilla",
          "User-Agent": navigator.userAgent,
          "x-restli-protocol-version": "2.0.0",
          "csrf-token": cleanJsession,
          "Cookie": `li_at=${data.li_at}; JSESSIONID="${cleanJsession}";`
        };
        
        setRawHeaders(JSON.stringify(perfectHeaders, null, 2));
        
        if (data.username && data.username !== "LinkedIn User") {
          toast.success(`Welcome, ${data.username}! Tokens extracted.`);
        } else {
          toast.success("Successfully extracted ALL LinkedIn tokens!");
        }
      } else {
        toast.error(data?.error || "Failed to detect cookies. Make sure you are logged into LinkedIn.");
      }
    };
    
    window.addEventListener("AUTOMAILEXT_RECEIVE_COOKIE", handleResponse);
    window.dispatchEvent(new CustomEvent("AUTOMAILEXT_REQUEST_COOKIE"));
  }

  function handleSmartPaste(val: string) {
    let extracted = 0;

    function parseCustom(text: string) {
      const trimmed = text.trim();
      if (!trimmed) return null;

      try {
        if (trimmed.startsWith('{')) return JSON.parse(trimmed);
      } catch {
        // ignore
      }

      const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const res: Record<string, string> = {};
      let i = 0;
      
      while (i < lines.length) {
        const line = lines[i];
        
        if ((line.includes('li_at=') || line.includes('JSESSIONID=')) && !line.includes(': ')) {
          res['Cookie'] = line;
          i++;
          continue;
        }
        
        if (line.includes(': ')) {
          const idx = line.indexOf(': ');
          res[line.slice(0, idx).trim()] = line.slice(idx + 2).trim();
          i++;
          continue;
        }
        
        if (i + 1 < lines.length) {
          res[line] = lines[i + 1];
          i += 2;
        } else {
          i++;
        }
      }
      
      // Auto-fill csrf-token if missing
      const keys = Object.keys(res).map(k => k.toLowerCase());
      if (!keys.includes('csrf-token') && res['Cookie']) {
        const match = res['Cookie'].match(/ajax:\d+/);
        if (match) res['csrf-token'] = match[0];
      }
      
      return Object.keys(res).length > 0 ? res : null;
    }

    const parsed = parseCustom(val);
    if (parsed) {
      // Strictly keep ONLY required headers
      const sanitized: Record<string, string> = {};
      const allowedKeys = REQUIRED_HEADERS.map(h => h.toLowerCase());
      for (const [k, v] of Object.entries(parsed)) {
        const lowerK = k.toLowerCase();
        if (allowedKeys.includes(lowerK)) {
          const properKey = REQUIRED_HEADERS.find(r => r.toLowerCase() === lowerK) || k;
          sanitized[properKey] = v as string;
        }
      }
      setRawHeaders(JSON.stringify(sanitized, null, 2));
    } else {
      setRawHeaders(val);
    }

    // Extract JSESSIONID (ajax:\d+)
    const jsessionMatch = val.match(/ajax:\d+/);
    if (jsessionMatch) {
      setJsessionid(jsessionMatch[0]);
      extracted++;
    }

    // Extract li_at (li_at=VALUE)
    const liAtMatch = val.match(/li_at=([^;"\s]+)/);
    if (liAtMatch) {
      setLiAt(liAtMatch[1]);
      extracted++;
    }

    if (extracted > 0) {
      toast.success(`Auto-extracted ${extracted} token(s)!`);
    } else if (val.trim().length > 0) {
      toast.error("No valid tokens found in pasted text.");
    }
  }

  if (!mounted) return null;

  return createPortal(
    <>
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
            <h2 id="autofetch-modal-title">LinkedIn Auto-Fetch Setup</h2>
            <p className="hint compact">
              Background workers will automatically fetch emails based on keywords.
            </p>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>

        <div className="modal-body">
          <label className="field">
            <span>
              Enable Auto-Fetch
              {!canEnable && (
                <span className="hint" style={{ marginLeft: "0.5rem", color: "var(--err)" }}>
                  (Requires Cookies & Keywords)
                </span>
              )}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.25rem" }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                disabled={!canEnable}
                style={{ width: "1.2rem", height: "1.2rem" }}
              />
              <span style={{ fontSize: "0.85rem", color: enabled ? "var(--ok)" : "var(--muted)" }}>
                {enabled ? "Active" : "Inactive"}
              </span>
            </div>
          </label>

          <p className="hint compact" style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
            {hasKeywords
              ? `${totalKeywords} keyword(s) across ${rolesWithKeywords} role(s) — manage on Jobs & Roles`
              : "No keywords configured yet"}
            <HelpTooltip
              title="Search Keywords"
              content={<p>Keywords now live on each role, on the <strong>Jobs & Roles</strong> page — the scraper searches every keyword across every role and tags results with that role automatically.</p>}
            />
          </p>

          <div className="grid-2">
            <label className="field">
              <span>
                Run interval (minutes)
                <HelpTooltip 
                  title="Fetch Interval" 
                  content={
                    <>
                      <p>How often should the background worker wake up and search LinkedIn for new posts?</p>
                      <p><strong>Recommendation:</strong> Set this to <strong>5 or 10 minutes</strong>. If you set it too low (like 1 minute), LinkedIn might temporarily block your account for searching too quickly.</p>
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

            <label className="field">
              <span>
                Pagination Limit
                <HelpTooltip 
                  title="Pagination Limit" 
                  content={
                    <>
                      <p>How many pages of search results should the scraper look through during each interval?</p>
                      <p>If set to <strong>3</strong>, it will scrape Page 1, Page 2, and Page 3 of the LinkedIn search results.</p>
                    </>
                  } 
                />
              </span>
              <input
                id="tour-autofetch-limit"
                type="number"
                min={3}
                max={50}
                value={paginationLimit}
                onChange={(e) => setPaginationLimit(Number(e.target.value) || 3)}
              />
            </label>
          </div>

          <div className="grid-2">
            <label className="field">
              <span>
                Pagination Delay (Sec)
                <HelpTooltip 
                  title="Pagination Delay" 
                  content={
                    <>
                      <p>The amount of time (in seconds) to pause between scraping each page.</p>
                      <p>This is a safety measure to mimic human browsing behavior and prevent LinkedIn from detecting the scraper. <strong>10 to 15 seconds</strong> is highly recommended.</p>
                    </>
                  } 
                />
              </span>
              <input
                id="tour-autofetch-delay"
                type="number"
                min={1}
                max={60}
                value={paginationDelaySec}
                onChange={(e) => setPaginationDelaySec(Number(e.target.value) || 10)}
              />
            </label>
          </div>

          <label className="field" style={{ marginTop: "0.5rem" }}>
            <span>
              Post Age Filter
              <HelpTooltip 
                title="Post Age Filter" 
                content={
                  <>
                    <p>Only scrape LinkedIn posts published within this timeframe.</p>
                    <p><strong>Past 24 hours</strong> ensures you are only reaching out to fresh, active leads who just posted recently!</p>
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

          <hr style={{ border: "0", borderTop: "1px solid var(--line)", margin: "0.5rem 0" }} />

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem", margin: "0 0 0.5rem 0" }}>
              <h3 style={{ fontSize: "0.85rem", margin: 0, display: "flex", alignItems: "center" }}>
                LinkedIn Cookies
                <HelpTooltip 
                  title="LinkedIn Cookies" 
                  content={
                    <>
                      <p>To search LinkedIn automatically, the background worker needs your temporary session credentials (called "Cookies").</p>
                      <p>We do not store your LinkedIn password.</p>
                    </>
                  } 
                />
              </h3>
              <button 
                id="tour-autofetch-cookie"
                type="button" 
                onClick={() => setShowHelpModal(true)}
                className="btn small ghost" 
                style={{ padding: "0.1rem 0.5rem", fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "0.25rem", color: "var(--ok)", borderColor: "var(--ok)" }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
                How to set cookies?
              </button>
            </div>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => setShowTokens(!showTokens)}
              style={{ fontSize: "0.7rem", padding: "0.2rem 0.5rem" }}
            >
              {showTokens ? "Hide" : "Show"} Values
            </button>
          </div>
          
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.5rem", gap: "0.5rem" }}>
            {!extensionInstalled && (
              <a 
                href="data:application/zip;base64,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" 
                download="automail-extension.zip"
                className="btn small ghost"
                style={{ display: "flex", gap: "0.5rem", alignItems: "center", border: "1px solid var(--line)" }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                </svg>
                Download Extension (.zip)
              </a>
            )}
            <button
              type="button"
              className="btn small"
              style={{ background: extensionInstalled ? "var(--bg-accent)" : "var(--bg-elevated)", display: "flex", gap: "0.5rem", alignItems: "center" }}
              onClick={handleAutoDetect}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
              </svg>
              Auto-Detect JSESSIONID
            </button>
          </div>

          <label className="field" style={{ marginBottom: "1rem" }}>
            <span className="hint compact" style={{ marginBottom: "0.25rem" }}>
              <strong>Smart Paste:</strong> Paste raw headers or cookie string here to auto-fill
            </span>
            <textarea
              rows={4}
              style={{ fontSize: "0.8rem", fontFamily: "monospace", width: "100%", padding: "0.5rem" }}
              placeholder='e.g. {"Cookie": "...", "csrf-token": "..."}'
              value={rawHeaders}
              onChange={(e) => handleSmartPaste(e.target.value)}
            />
            {parsedHeaders && Object.keys(parsedHeaders).length > 0 && (
              <div style={{ marginTop: "0.5rem", fontSize: "0.75rem", background: "var(--bg-card)", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--line)", maxHeight: "250px", overflowY: "auto" }}>
                <strong style={{ display: "block", marginBottom: "0.25rem", color: "var(--ok)" }}>✅ Extracted Headers:</strong>
                {Object.entries(parsedHeaders).map(([key, value]) => (
                  <div key={key} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.25rem" }}>
                    <span style={{ fontWeight: "bold", minWidth: "120px", color: "var(--fg)" }}>{key}:</span>
                    <span style={{ color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={value as string}>
                      {value as string}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {!parsedHeaders && (liAt || (jsessionid && jsessionid !== "ajax:")) && (
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
                {liAt && liAt.length > 0 && (
                  <span className="badge ok" style={{ fontSize: "0.65rem", padding: "0.1rem 0.4rem" }}>✅ li_at</span>
                )}
                {jsessionid && jsessionid !== "ajax:" && jsessionid.length > 0 && (
                  <span className="badge ok" style={{ fontSize: "0.65rem", padding: "0.1rem 0.4rem" }}>✅ JSESSIONID</span>
                )}
              </div>
            )}
            {missingHeaders.length > 0 && rawHeaders.trim().length > 0 && (
              <div style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "var(--err)", padding: "0.5rem", background: "rgba(255,0,0,0.1)", borderRadius: "4px" }}>
                <strong>❌ Missing required headers:</strong><br />
                {missingHeaders.join(", ")}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem", alignItems: "center" }}>
                  <select 
                    value={manualKey || missingHeaders[0]} 
                    onChange={(e) => setManualKey(e.target.value)}
                    style={{ flex: "1 1 120px", padding: "0.3rem", borderRadius: "4px", border: "1px solid var(--err)", background: "var(--bg)", color: "var(--fg)" }}
                  >
                    {missingHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <input 
                    type="text" 
                    placeholder="Value..." 
                    value={manualValue} 
                    onChange={(e) => setManualValue(e.target.value)} 
                    style={{ flex: "2 1 150px", minWidth: 0, padding: "0.3rem", borderRadius: "4px", border: "1px solid var(--err)", background: "var(--bg)", color: "var(--fg)" }}
                  />
                  <button 
                    type="button" 
                    className="btn primary small"
                    style={{ padding: "0.3rem 0.75rem" }}
                    onClick={() => {
                      const keyToAdd = manualKey || missingHeaders[0];
                      if (!manualValue.trim()) {
                         toast.error("Value cannot be empty");
                         return;
                      }
                      
                      let current: Record<string, string> = {};
                      try {
                        if (rawHeaders.trim().startsWith('{')) {
                           current = JSON.parse(rawHeaders);
                        }
                      } catch {
                        // ignore
                      }
                      
                      current[keyToAdd] = manualValue.trim();
                      setRawHeaders(JSON.stringify(current, null, 2));
                      setManualValue("");
                      setManualKey(""); // Reset to next missing
                      toast.success(`Added ${keyToAdd}!`);
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </label>

          <div className="grid-2">
            <label className="field">
              <span>
                li_at
                {!isLiAtValid && liAt.length > 0 && (
                  <span className="hint" style={{ marginLeft: "0.5rem", color: "var(--err)" }}>
                    (Invalid format)
                  </span>
                )}
              </span>
              <input
                type={showTokens ? "text" : "password"}
                value={liAt}
                onChange={(e) => {
                  setLiAt(e.target.value);
                  if (!e.target.value.trim() && enabled) setEnabled(false);
                }}
                style={{ borderColor: !isLiAtValid && liAt.length > 0 ? "var(--err)" : undefined }}
                placeholder="AQ..."
              />
            </label>
            <label className="field">
              <span>
                JSESSIONID
                {!isJsessionValid && jsessionid !== "ajax:" && jsessionid.length > 0 && (
                  <span className="hint" style={{ marginLeft: "0.5rem", color: "var(--err)" }}>
                    (Should be ajax: + digits)
                  </span>
                )}
              </span>
              <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                <span 
                  style={{ 
                    position: "absolute", 
                    left: "0.75rem", 
                    color: "var(--fg)", 
                    pointerEvents: "none",
                    fontFamily: "monospace",
                    fontSize: "0.9rem"
                  }}
                >
                  ajax:
                </span>
                <input
                  type={showTokens ? "text" : "password"}
                  value={jsessionid.replace(/^ajax:/, '')}
                  onChange={(e) => {
                    const val = e.target.value.replace(/^ajax:/, '');
                    setJsessionid("ajax:" + val);
                    if (!val.trim() && enabled) setEnabled(false);
                  }}
                  style={{ 
                    borderColor: !isJsessionValid && jsessionid !== "ajax:" && jsessionid.length > 0 ? "var(--err)" : undefined,
                    paddingLeft: "3.2rem" 
                  }}
                  placeholder="***"
                />
              </div>
            </label>
          </div>

          <button
            type="button"
            className="btn primary large"
            onClick={handleSave}
            disabled={isVerifying}
            style={{ marginTop: "0.5rem", position: "relative" }}
          >
            {isVerifying ? "Verifying Cookies..." : "Save Configuration"}
          </button>
        </div>
      </div>
    </div>
    {showHelpModal && <CookieHelpModal onClose={() => setShowHelpModal(false)} />}
  </>,
  document.body
);
}
