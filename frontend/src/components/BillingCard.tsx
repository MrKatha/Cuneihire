"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { supabase } from "@/lib/supabase";

type Props = {
  planTier: "free" | "pro" | "premium";
  subscriptionStatus: string | null;
  currentPeriodEndsAt: string | null;
};

const TIER_LABEL: Record<Props["planTier"], string> = { free: "Free", pro: "Pro", premium: "Premium" };

// Self-contained (mirrors TwoFactorSettings.tsx's pattern) — SettingsTab.tsx wraps this in its own
// <Card title="Billing">. planTier/subscriptionStatus/currentPeriodEndsAt come from the app's own state
// (webhook-granted, read-only — see storage.ts), not fetched separately here. Deliberately minimal UI per
// the operator's own "even the UI is less of a priority" MVP-push stance — a plan badge and two buttons.
export function BillingCard({ planTier, subscriptionStatus, currentPeriodEndsAt }: Props) {
  const [busy, setBusy] = useState<"pro" | "premium" | "portal" | null>(null);

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

  async function handleUpgrade(tier: "pro" | "premium") {
    setBusy(tier);
    try {
      const res = await authedFetch("/api/billing/checkout", { method: "POST", body: JSON.stringify({ tier }) });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.error || "Couldn't start checkout");
        setBusy(null);
        return;
      }
      window.location.href = data.url;
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
      window.location.href = data.url;
    } catch {
      toast.error("Network error opening your billing portal");
      setBusy(null);
    }
  }

  const isCancelled = subscriptionStatus === "cancelled";
  const periodLabel = currentPeriodEndsAt ? new Date(currentPeriodEndsAt).toLocaleDateString() : null;

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

      {planTier === "free" && (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" className="btn primary small" onClick={() => handleUpgrade("pro")} disabled={busy !== null}>
            {busy === "pro" ? "Starting…" : "Upgrade to Pro"}
          </button>
          <button type="button" className="btn ghost small" onClick={() => handleUpgrade("premium")} disabled={busy !== null}>
            {busy === "premium" ? "Starting…" : "Upgrade to Premium"}
          </button>
        </div>
      )}

      {planTier === "pro" && (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" className="btn primary small" onClick={() => handleUpgrade("premium")} disabled={busy !== null}>
            {busy === "premium" ? "Starting…" : "Upgrade to Premium"}
          </button>
          <button type="button" className="btn ghost small" onClick={handleManage} disabled={busy !== null}>
            {busy === "portal" ? "Opening…" : "Manage subscription"}
          </button>
        </div>
      )}

      {planTier === "premium" && (
        <button type="button" className="btn ghost small" onClick={handleManage} disabled={busy !== null}>
          {busy === "portal" ? "Opening…" : "Manage subscription"}
        </button>
      )}
    </div>
  );
}
