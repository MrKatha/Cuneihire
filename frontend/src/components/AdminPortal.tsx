import { useState, useEffect } from "react";
import toast from "react-hot-toast";
import { supabase } from "@/lib/supabase";

type UserState = {
  user_id: string;
  is_blocked: boolean;
  allowed_products: string[];
  config: any;
  auto_fetch: any;
  automail: any;
  // Platform-managed AI credits (2026-08-18) — admin-granted only, no self-serve purchase yet.
  ai_credits: number;
  // Recruiter portal (2026-08-19) — null means this user hasn't activated recruiter mode, distinct from
  // a recruiter with 0 credits. See automailsend_recruiter_profiles.
  ats_ai_credits: number | null;
  // Manual per-user plan overrides (2026-08-25) — the first lever toward real plan tiers ("later on we
  // will integrate it and turn it into a complete SaaS product" — operator). null = no override, this
  // account behaves exactly like every other one. See supabase_setup.sql's section for the full reasoning.
  max_keywords: number | null;
  min_fetch_interval_override: number | null;
  created_at: string;
};

type GlobalSettings = {
  min_fetch_interval: number;
  min_pagination_delay: number;
  max_pagination_limit: number;
  allow_signups: boolean;
  max_daily_send_limit: number;
};

export function AdminPortal() {
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
  const [users, setUsers] = useState<UserState[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Settings Form State
  const [minInterval, setMinInterval] = useState(5);
  const [minDelay, setMinDelay] = useState(5);
  const [maxLimit, setMaxLimit] = useState(10);
  const [allowSignups, setAllowSignups] = useState(true);
  // No billing/plan system yet (2026-08-25) — this one global ceiling stands in for it. A candidate's
  // Dashboard shows the smaller of this, their own daily_mail_limit, and their connected SMTP accounts'
  // pool (50/day each) — see automail.worker.js for the backend-enforced version of the same rule.
  const [maxDailySendLimit, setMaxDailySendLimit] = useState(100);
  
  // Navigation State
  const [activeTopTab, setActiveTopTab] = useState<"global" | "users">("users");
  const [viewUser, setViewUser] = useState<UserState | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = session ? { "Authorization": `Bearer ${session.access_token}` } : {};
      const [settingsRes, usersRes] = await Promise.all([
        fetch("/api/admin/global-settings", { headers }),
        fetch("/api/admin/users", { headers })
      ]);
      
      const settingsData = await settingsRes.json();
      const usersData = await usersRes.json();
      
      if (settingsData.success) {
        setGlobalSettings(settingsData.data);
        setMinInterval(settingsData.data.min_fetch_interval || 5);
        setMinDelay(settingsData.data.min_pagination_delay || 5);
        setMaxLimit(settingsData.data.max_pagination_limit || 10);
        setAllowSignups(settingsData.data.allow_signups !== false);
        setMaxDailySendLimit(settingsData.data.max_daily_send_limit || 100);
      }
      
      if (usersData.success) {
        setUsers(usersData.data);
      }
    } catch (err) {
      toast.error("Failed to fetch admin data");
    }
    setLoading(false);
  }

  async function saveGlobalSettings() {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = { 
        "Content-Type": "application/json",
        ...(session ? { "Authorization": `Bearer ${session.access_token}` } : {})
      };

      const res = await fetch("/api/admin/global-settings", {
        method: "POST",
        headers,
        body: JSON.stringify({
          min_fetch_interval: minInterval,
          min_pagination_delay: minDelay,
          max_pagination_limit: maxLimit,
          allow_signups: allowSignups,
          max_daily_send_limit: maxDailySendLimit
        })
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Global settings updated!");
        setGlobalSettings(data.data);
      } else {
        toast.error(data.error || "Failed to update global settings");
      }
    } catch (err) {
      toast.error("Network error");
    }
  }

  async function toggleBlock(userId: string, currentBlocked: boolean) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = { 
        "Content-Type": "application/json",
        ...(session ? { "Authorization": `Bearer ${session.access_token}` } : {})
      };

      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers,
        body: JSON.stringify({ user_id: userId, is_blocked: !currentBlocked })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(currentBlocked ? "User unblocked" : "User blocked");
        setUsers(users.map(u => u.user_id === userId ? { ...u, is_blocked: !currentBlocked } : u));
      } else {
        toast.error(data.error || "Failed to update user");
      }
    } catch (err) {
      toast.error("Network error");
    }
  }

  if (loading) {
    return <div style={{ padding: "2rem" }}>Loading admin data...</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div className="tabs" style={{ display: "flex", gap: "1rem", borderBottom: "1px solid var(--line)", paddingBottom: "0.5rem" }}>
        <button 
          className={`btn ${activeTopTab === "users" ? "primary" : "ghost"}`} 
          onClick={() => setActiveTopTab("users")}
        >
          User Management
        </button>
        <button 
          className={`btn ${activeTopTab === "global" ? "primary" : "ghost"}`} 
          onClick={() => setActiveTopTab("global")}
        >
          Global Settings
        </button>
      </div>

      {activeTopTab === "global" && (
        <section className="panel">
          <h2 className="panel-title">Global Limits & Settings (Backend Cache)</h2>
          <p className="hint">These settings apply to all users and are strictly enforced by the backend.</p>
          
          <div className="grid-2" style={{ marginTop: "1rem" }}>
            <label className="field">
              <span>Minimum Fetch Interval (Minutes)</span>
              <input 
                type="number" 
                value={minInterval} 
                onChange={e => setMinInterval(Number(e.target.value))} 
              />
            </label>
            <label className="field">
              <span>Minimum Pagination Delay (Seconds)</span>
              <input 
                type="number" 
                value={minDelay} 
                onChange={e => setMinDelay(Number(e.target.value))} 
              />
            </label>
            <label className="field">
              <span>Maximum Pagination Limit (Pages)</span>
              <input 
                type="number" 
                value={maxLimit} 
                onChange={e => setMaxLimit(Number(e.target.value))} 
              />
            </label>
            <label className="field">
              <span>Max Daily Send Limit (per candidate)</span>
              <input
                type="number"
                min={1}
                value={maxDailySendLimit}
                onChange={e => setMaxDailySendLimit(Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Allow New User Signups</span>
              <select 
                value={allowSignups ? "true" : "false"}
                onChange={e => setAllowSignups(e.target.value === "true")}
                style={{ width: "100%", padding: "0.75rem", borderRadius: "8px", border: "1px solid var(--line)", background: "var(--bg-input)" }}
              >
                <option value="true">Yes, signups are open</option>
                <option value="false">No, signups are closed</option>
              </select>
            </label>
          </div>
          <button className="btn primary" style={{ marginTop: "1rem" }} onClick={saveGlobalSettings}>
            Save Global Settings
          </button>
        </section>
      )}

      {activeTopTab === "users" && (
        <section className="panel">
          <h2 className="panel-title">User Management</h2>
          <p className="hint">Block users or view their detailed configurations and CRM data.</p>
          
          <div style={{ overflowX: "auto", marginTop: "1rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                  <th style={{ padding: "0.75rem 0.5rem" }}>User ID</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>Joined</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>Status</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>AI Credits</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>ATS Credits</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>Max Keywords</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>Min Fetch Interval</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.user_id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={{ padding: "0.75rem 0.5rem", fontFamily: "monospace" }}>{u.user_id}</td>
                    <td style={{ padding: "0.75rem 0.5rem" }}>{new Date(u.created_at).toLocaleDateString()}</td>
                    <td style={{ padding: "0.75rem 0.5rem" }}>
                      {u.is_blocked ? (
                        <span className="badge err">Blocked</span>
                      ) : (
                        <span className="badge ok">Active</span>
                      )}
                    </td>
                    <td style={{ padding: "0.75rem 0.5rem" }}>
                      <CreditsCell
                        userId={u.user_id}
                        field="ai_credits"
                        credits={u.ai_credits ?? 0}
                        onSaved={(userId, credits) => setUsers(users.map(x => x.user_id === userId ? { ...x, ai_credits: credits } : x))}
                      />
                    </td>
                    <td style={{ padding: "0.75rem 0.5rem" }}>
                      {u.ats_ai_credits === null ? (
                        <span className="hint compact">Not a recruiter</span>
                      ) : (
                        <CreditsCell
                          userId={u.user_id}
                          field="ats_ai_credits"
                          credits={u.ats_ai_credits}
                          onSaved={(userId, credits) => setUsers(users.map(x => x.user_id === userId ? { ...x, ats_ai_credits: credits } : x))}
                        />
                      )}
                    </td>
                    <td style={{ padding: "0.75rem 0.5rem" }}>
                      <OverrideCell
                        userId={u.user_id}
                        field="max_keywords"
                        value={u.max_keywords}
                        unit="keywords"
                        onSaved={(userId, value) => setUsers(users.map(x => x.user_id === userId ? { ...x, max_keywords: value } : x))}
                      />
                    </td>
                    <td style={{ padding: "0.75rem 0.5rem" }}>
                      <OverrideCell
                        userId={u.user_id}
                        field="min_fetch_interval_override"
                        value={u.min_fetch_interval_override}
                        unit="min"
                        onSaved={(userId, value) => setUsers(users.map(x => x.user_id === userId ? { ...x, min_fetch_interval_override: value } : x))}
                      />
                    </td>
                    <td style={{ padding: "0.75rem 0.5rem", display: "flex", gap: "0.5rem" }}>
                      <button
                        className={`btn small ${u.is_blocked ? "ok" : "danger"}`}
                        onClick={() => toggleBlock(u.user_id, u.is_blocked)}
                      >
                        {u.is_blocked ? "Unblock" : "Block"}
                      </button>
                      <button
                        className="btn small primary"
                        onClick={() => setViewUser(u)}
                      >
                        View Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {viewUser && (
        <UserDetailsModal user={viewUser} onClose={() => setViewUser(null)} />
      )}
    </div>
  );
}

// Platform-managed AI credits (2026-08-18) — the only way a user gets more, for this first version (no
// self-serve purchase flow exists yet). One small numeric input + "Set" per row, same table-row pattern
// as the Block/Unblock action next to it. `field` (2026-08-19) lets this same cell also drive
// ats_ai_credits (automailsend_recruiter_profiles) for the ATS Credits column.
function CreditsCell({ userId, field, credits, onSaved }: { userId: string; field: "ai_credits" | "ats_ai_credits"; credits: number; onSaved: (userId: string, credits: number) => void }) {
  const [value, setValue] = useState(String(credits));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(String(credits));
  }, [credits]);

  async function save() {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Enter a valid non-negative number.");
      return;
    }
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = {
        "Content-Type": "application/json",
        ...(session ? { "Authorization": `Bearer ${session.access_token}` } : {}),
      };
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers,
        body: JSON.stringify({ user_id: userId, [field]: n }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Credits updated.");
        onSaved(userId, n);
      } else {
        toast.error(data.error || "Failed to update credits");
      }
    } catch (err) {
      toast.error("Network error");
    }
    setSaving(false);
  }

  return (
    <span style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center" }}>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ width: "70px", padding: "0.2rem 0.4rem" }}
      />
      <button className="btn small" onClick={save} disabled={saving}>
        {saving ? "…" : "Set"}
      </button>
    </span>
  );
}

// Manual per-user plan overrides (2026-08-25) — "limit the number of keywords in a package... limit the
// interval searches on those packages" (operator ask), scoped for now to admin-set overrides rather than
// real self-serve billing tiers ("this is for now... later we will integrate it and turn it into a
// complete SaaS product" — operator). Unlike CreditsCell, `null` is a real, meaningful state here ("no
// override — this account behaves like everyone else"), not just "hasn't been set yet" — so this needs an
// explicit way back to null, not just a numeric input.
function OverrideCell({
  userId,
  field,
  value,
  unit,
  onSaved,
}: {
  userId: string;
  field: "max_keywords" | "min_fetch_interval_override";
  value: number | null;
  unit: string;
  onSaved: (userId: string, value: number | null) => void;
}) {
  const [input, setInput] = useState(value == null ? "" : String(value));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setInput(value == null ? "" : String(value));
  }, [value]);

  async function post(body: Record<string, unknown>) {
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = {
        "Content-Type": "application/json",
        ...(session ? { "Authorization": `Bearer ${session.access_token}` } : {}),
      };
      const res = await fetch("/api/admin/users", { method: "POST", headers, body: JSON.stringify({ user_id: userId, ...body }) });
      const data = await res.json();
      if (data.success) {
        toast.success("Updated.");
        onSaved(userId, (body[field] as number | null) ?? null);
      } else {
        toast.error(data.error || "Failed to update");
      }
    } catch {
      toast.error("Network error");
    }
    setSaving(false);
  }

  function save() {
    const trimmed = input.trim();
    if (!trimmed) { post({ [field]: null }); return; }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Enter a valid non-negative number, or clear it for no override.");
      return;
    }
    post({ [field]: n });
  }

  return (
    <span style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center" }}>
      <input
        type="number"
        min={0}
        placeholder="Default"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        style={{ width: "70px", padding: "0.2rem 0.4rem" }}
      />
      <span className="hint compact" style={{ margin: 0 }}>{unit}</span>
      <button className="btn small" onClick={save} disabled={saving}>
        {saving ? "…" : "Set"}
      </button>
      {value != null && (
        <button className="btn small ghost" onClick={() => post({ [field]: null })} disabled={saving} title="Clear override, back to default">
          Clear
        </button>
      )}
    </span>
  );
}

// ----------------------------------------------------
// New Detailed User Modal Component
// ----------------------------------------------------

function UserDetailsModal({ user, onClose }: { user: UserState; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview" | "keys" | "templates" | "crm" | "logs">("overview");
  const [details, setDetails] = useState<any>(null);

  useEffect(() => {
    fetchUserDetails();
  }, [user.user_id]);

  async function fetchUserDetails() {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = session ? { "Authorization": `Bearer ${session.access_token}` } : {};
      
      const res = await fetch(`/api/admin/users/${user.user_id}`, { headers });
      const json = await res.json();
      
      if (json.success) {
        setDetails(json.data);
      } else {
        toast.error("Failed to load user details: " + json.error);
      }
    } catch (err) {
      toast.error("Network error loading details");
    }
    setLoading(false);
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 9999 }}>
      <div 
        className="modal-card" 
        style={{ maxWidth: "1000px", width: "95vw", height: "90vh", display: "flex", flexDirection: "column" }} 
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: "1rem", borderBottom: "1px solid var(--line)" }}>
          <div>
            <h2 className="panel-title">User Details Dashboard</h2>
            <p className="hint compact" style={{ fontFamily: "monospace", marginTop: "0.25rem" }}>{user.user_id}</p>
          </div>
          <button className="btn ghost icon" onClick={onClose}>✕</button>
        </div>
        
        {loading ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <p>Loading deep data...</p>
          </div>
        ) : !details ? (
          <div style={{ flex: 1, padding: "2rem", color: "var(--err)" }}>Failed to load data.</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", borderBottom: "1px solid var(--line)", paddingBottom: "0.5rem" }}>
              {(["overview", "keys", "templates", "crm", "logs"] as const).map(tab => (
                <button
                  key={tab}
                  className={`btn small ${activeTab === tab ? "filled" : "ghost"}`}
                  onClick={() => setActiveTab(tab)}
                  style={{ textTransform: "capitalize" }}
                >
                  {tab === "crm" ? "Email CRM" : tab}
                </button>
              ))}
            </div>

            <div style={{ flex: 1, overflowY: "auto", marginTop: "1rem", paddingRight: "0.5rem" }}>
              {activeTab === "overview" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                  <div className="panel" style={{ background: "var(--bg-panel)" }}>
                    <p><strong>Status:</strong> {user.is_blocked ? "Blocked" : "Active"}</p>
                    <p><strong>Joined:</strong> {new Date(user.created_at).toLocaleString()}</p>
                    <p><strong>Total Scraped/Added Leads:</strong> {details.recipients.length}</p>
                    <p><strong>Total Emails Sent:</strong> {details.sent_logs.length}</p>
                  </div>
                </div>
              )}

              {activeTab === "keys" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                  <div style={{ background: "var(--bg-panel)", padding: "1rem", borderRadius: "8px" }}>
                    <strong style={{ color: "var(--accent)", display: "block", marginBottom: "0.5rem" }}>Auto-Fetch Config (LinkedIn)</strong>
                    <pre style={{ fontSize: "0.75rem", overflowX: "auto", margin: 0, whiteSpace: "pre-wrap" }}>
                      {JSON.stringify(details.app_state.auto_fetch, null, 2)}
                    </pre>
                  </div>
                  <div style={{ background: "var(--bg-panel)", padding: "1rem", borderRadius: "8px" }}>
                    <strong style={{ color: "var(--accent)", display: "block", marginBottom: "0.5rem" }}>Automail AI Config</strong>
                    <pre style={{ fontSize: "0.75rem", overflowX: "auto", margin: 0, whiteSpace: "pre-wrap" }}>
                      {JSON.stringify(details.app_state.automail, null, 2)}
                    </pre>
                  </div>
                  <div style={{ background: "var(--bg-panel)", padding: "1rem", borderRadius: "8px" }}>
                    <strong style={{ color: "var(--accent)", display: "block", marginBottom: "0.5rem" }}>SMTP Config (Hidden Password)</strong>
                    <pre style={{ fontSize: "0.75rem", overflowX: "auto", margin: 0 }}>
                      Configured: {details.app_state.config?.configured ? "Yes" : "No"}{"\n"}
                      Host: {details.app_state.config?.host}{"\n"}
                      User: {details.app_state.config?.user}
                    </pre>
                  </div>
                </div>
              )}

              {activeTab === "templates" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                  {details.templates.length === 0 ? <p className="hint">No custom templates saved.</p> : null}
                  {details.templates.map((tpl: any) => (
                    <div key={tpl.id} style={{ background: "var(--bg-panel)", padding: "1rem", borderRadius: "8px", border: "1px solid var(--line)" }}>
                      <h4 style={{ margin: "0 0 0.5rem 0", color: "var(--accent)", textTransform: "capitalize" }}>
                        Role: {tpl.role} — {tpl.label || "Default"}{tpl.is_default ? " (default)" : ""}
                      </h4>
                      <p style={{ margin: "0 0 0.25rem 0", fontWeight: 500 }}>Subject: {tpl.subject}</p>
                      <pre style={{ fontSize: "0.8rem", whiteSpace: "pre-wrap", background: "var(--bg-input)", padding: "0.5rem", borderRadius: "4px" }}>
                        {tpl.content}
                      </pre>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "crm" && (
                <div>
                  <p className="hint compact" style={{ marginBottom: "1rem" }}>Showing up to 200 recent leads.</p>
                  {details.recipients.length === 0 ? <p className="hint">No leads in CRM.</p> : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                          <th style={{ padding: "0.5rem" }}>Name</th>
                          <th style={{ padding: "0.5rem" }}>Email</th>
                          <th style={{ padding: "0.5rem" }}>Role</th>
                          <th style={{ padding: "0.5rem" }}>Status</th>
                          <th style={{ padding: "0.5rem" }}>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {details.recipients.map((r: any) => (
                          <tr key={r.id} style={{ borderBottom: "1px solid var(--line)" }}>
                            <td style={{ padding: "0.5rem" }}>{r.name}</td>
                            <td style={{ padding: "0.5rem" }}>{r.email}</td>
                            <td style={{ padding: "0.5rem" }}>{r.role}</td>
                            <td style={{ padding: "0.5rem" }}>
                              <span className={`badge ${r.status === 'sent' ? 'ok' : r.status === 'failed' ? 'err' : 'ghost'}`}>
                                {r.status}
                              </span>
                            </td>
                            <td style={{ padding: "0.5rem", color: "var(--muted)" }}>{r.source || 'manual'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === "logs" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
                  <div>
                    <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Email Sent Logs (Recent 200)</h3>
                    {details.sent_logs.length === 0 ? <p className="hint">No emails sent yet.</p> : (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                            <th style={{ padding: "0.5rem" }}>Time</th>
                            <th style={{ padding: "0.5rem" }}>To</th>
                            <th style={{ padding: "0.5rem" }}>Subject</th>
                          </tr>
                        </thead>
                        <tbody>
                          {details.sent_logs.map((log: any) => (
                            <tr key={log.id} style={{ borderBottom: "1px solid var(--line)" }}>
                              <td style={{ padding: "0.5rem", color: "var(--muted)" }}>{new Date(log.created_at).toLocaleString()}</td>
                              <td style={{ padding: "0.5rem" }}>{log.email}</td>
                              <td style={{ padding: "0.5rem" }}>{log.subject}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <div>
                    <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Background Worker Logs (Recent 200)</h3>
                    {details.execution_logs.length === 0 ? <p className="hint">No worker executions yet.</p> : (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                            <th style={{ padding: "0.5rem" }}>Time</th>
                            <th style={{ padding: "0.5rem" }}>Action</th>
                            <th style={{ padding: "0.5rem" }}>Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {details.execution_logs.map((log: any) => (
                            <tr key={log.id} style={{ borderBottom: "1px solid var(--line)" }}>
                              <td style={{ padding: "0.5rem", color: "var(--muted)", whiteSpace: "nowrap" }}>{new Date(log.created_at).toLocaleString()}</td>
                              <td style={{ padding: "0.5rem" }}>
                                <span className={`badge ${log.action_type === 'autofetch' ? 'ok' : 'ghost'}`}>
                                  {log.action_type}
                                </span>
                              </td>
                              <td style={{ padding: "0.5rem" }}>
                                <pre style={{ margin: 0, fontSize: "0.75rem", whiteSpace: "pre-wrap", background: "none" }}>
                                  {JSON.stringify(log.result, null, 2)}
                                </pre>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
