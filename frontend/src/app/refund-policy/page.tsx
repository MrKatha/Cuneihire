import type { Metadata } from "next";
import LegalPageShell from "@/components/LegalPageShell";

export const metadata: Metadata = {
  title: "Refund Policy — Cuneihire",
  description: "How refunds and cancellations work for Cuneihire subscriptions.",
};

const LAST_UPDATED = "August 31, 2026";
const SUPPORT_EMAIL = "help@cuneihive.com";

export default function RefundPolicyPage() {
  return (
    <LegalPageShell title="Refund Policy" lastUpdated={LAST_UPDATED} activeHref="/refund-policy">
      <p>
        This policy covers refunds and cancellations for paid Cuneihire subscriptions (Free plan usage has
        nothing to refund). Payments are processed by{" "}
        <a href="https://www.lemonsqueezy.com" target="_blank" rel="noopener noreferrer">
          Lemon Squeezy
        </a>
        , our Merchant of Record — refunds are issued through Lemon Squeezy, subject to their own{" "}
        <a href="https://docs.lemonsqueezy.com/help/payments/refunds-chargebacks" target="_blank" rel="noopener noreferrer">
          refund handling
        </a>{" "}
        and{" "}
        <a href="https://www.lemonsqueezy.com/buyer-terms" target="_blank" rel="noopener noreferrer">
          Buyer Terms
        </a>
        , alongside the policy below that we apply as the seller.
      </p>

      <h2>1. First-purchase guarantee</h2>
      <p>
        If you&rsquo;re not happy with a paid plan, email us within <strong>14 days of your first payment</strong>{" "}
        on that plan and we&rsquo;ll refund it — no detailed justification needed.
      </p>

      <h2>2. Renewals</h2>
      <p>
        Recurring renewal charges after your first payment are generally non-refundable, since you&rsquo;ve
        already had the billing period to use the plan. We make exceptions at our discretion for billing
        errors (e.g. a duplicate charge) or extended Service outages that materially prevented you from
        using your plan.
      </p>

      <h2>3. Cancelling</h2>
      <p>
        You can cancel anytime from your account&rsquo;s Billing settings — cancellation stops future
        renewals and takes effect at the end of your current billing period; you keep access until then.
        There&rsquo;s no cancellation fee, and you don&rsquo;t need to contact us to cancel.
      </p>

      <h2>4. Plan changes</h2>
      <p>
        Switching between paid plans (upgrade or downgrade) is handled through your Billing settings and is
        prorated by Lemon Squeezy&rsquo;s billing system.
      </p>

      <h2>5. How to request a refund</h2>
      <p>
        Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with the email address on your
        account and the reason for your request. We aim to respond within 2 business days.
      </p>
    </LegalPageShell>
  );
}
