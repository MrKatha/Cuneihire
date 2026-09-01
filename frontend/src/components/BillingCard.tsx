"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { supabase } from "@/lib/supabase";

type PaidTier = "starter" | "pro" | "elite";

type Props = {
  planTier: "free" | PaidTier;
  subscriptionStatus: string | null;
  currentPeriodEndsAt: string | null;
};

const TIER_LABEL: Record<Props["planTier"], string> = { free: "Free", starter: "Starter", pro: "Pro", elite: "Elite" };
// Ordered so "Upgrade to X" only ever offers tiers above the current one.
const TIER_ORDER: Props["planTier"][] = ["free", "starter", "pro", "elite"];

// Module-scope helper (2026-08-31) rather than an inline `window.location.href = url` assignment inside
// handleUpgrade below — the React Compiler's eslint rule (react-hooks/immutability) mis-flagged that
// inline form as "modifying a variable defined outside a component," seemingly specific to handleUpgrade
// being invoked from the higherTiers.map() callback in the JSX below (handleManage's identical inline
// assignment, called directly rather than via .map(), wasn't flagged). Same fix shape either way.
function redirectTo(url: string) {
  window.location.href = url;
}

// Self-contained (mirrors TwoFactorSettings.tsx's pattern) — SettingsTab.tsx wraps this in its own
// <Card title="Billing">. planTier/subscriptionStatus/currentPeriodEndsAt come from the app's own state
// (webhook-granted, read-only — see storage.ts), not fetched separately here. Deliberately minimal UI per
// the operator's own "even the UI is less of a priority" MVP-push stance — a plan badge and upgrade buttons.
export function BillingCard({ planTier, subscriptionStatus, currentPeriodEndsAt }: Props) {
  const [busy, setBusy] = useState<PaidTier | "portal" | null>(null);

  async function authedFetch(path: string, init: RequestInit = {}) {
    const { data: { session } } = await supabase.auth.getSession();
    return fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        ...(init.headers || {}),
      },
    });
  }

  async function handleUpgrade(tier: PaidTier) {
    setBusy(tier);
    try {
      const res = await authedFetch("/api/billing/checkout", { method: "POST", body: JSON.stringify({ tier }) });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.error || "Couldn't start checkout");
        setBusy(null);
        return;
      }
      redirectTo(data.url);
    } catch {
      toast.error("Network error starting checkout");
      setBusy(null);
    }
  }

  async function handleManage() {
    setBusy("portal");
    try {
      const res = await authedFetch("/api/billing/portal");
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.error || "Couldn't open your billing portal");
        setBusy(null);
        return;
      }
      redirectTo(data.url);
    } catch {
      toast.error("Network error opening your billing portal");
      setBusy(null);
    }
  }

  const isCancelled = subscriptionStatus === "cancelled";
  const periodLabel = currentPeriodEndsAt ? new Date(currentPeriodEndsAt).toLocaleDateString() : null;
  const higherTiers = TIER_ORDER.slice(TIER_ORDER.indexOf(planTier) + 1) as PaidTier[];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.6rem" }}>
        <span className={planTier === "free" ? "badge warn" : "badge ok"}>{TIER_LABEL[planTier]}</span>
        {isCancelled && periodLabel && (
          <span className="hint compact">Cancelled — access continues until {periodLabel}</span>
        )}
        {!isCancelled && planTier !== "free" && periodLabel && (
          <span className="hint compact">Renews {periodLabel}</span>
        )}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {higherTiers.map((t, i) => (
          <button
            key={t}
            type="button"
            className={i === 0 ? "btn primary small" : "btn ghost small"}
            onClick={() => handleUpgrade(t)}
            disabled={busy !== null}
          >
            {busy === t ? "Starting…" : `Upgrade to ${TIER_LABEL[t]}`}
          </button>
        ))}
        {planTier !== "free" && (
          <button type="button" className="btn ghost small" onClick={handleManage} disabled={busy !== null}>
            {busy === "portal" ? "Opening…" : "Manage subscription"}
          </button>
        )}
      </div>
    </div>
  );
}
