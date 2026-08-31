import type { Metadata } from "next";
import LegalPageShell from "@/components/LegalPageShell";

export const metadata: Metadata = {
  title: "Privacy Policy — Cuneihire",
  description: "What data Cuneihire collects, why, and how it's protected.",
};

const LAST_UPDATED = "August 31, 2026";
const SUPPORT_EMAIL = "help@cuneihive.com";

export default function PrivacyPage() {
  return (
    <LegalPageShell title="Privacy Policy" lastUpdated={LAST_UPDATED} activeHref="/privacy">
      <p>
        This policy explains what data Cuneihire (operated by Muhammad Sohaib Amin, trading as Cuneihive)
        collects when you use the Service, why, and how it&rsquo;s protected. It applies to Cuneihire
        account holders and, where relevant, to the third parties whose public contact details pass through
        the Service as part of the outreach feature you configure.
      </p>

      <h2>1. Data we collect</h2>
      <h3>Account data</h3>
      <p>
        Your email address and authentication data (managed by Supabase Auth — we never see your raw
        password), plus any two-factor authentication you enroll.
      </p>
      <h3>Connected credentials</h3>
      <p>
        If you enable LinkedIn search, the browser extension reads your LinkedIn session cookie so the
        Service can search on your behalf; if you enable outreach or reply monitoring, you connect an email
        account. Both are stored <strong>encrypted at rest</strong> (AES-256-GCM) and are never sent
        anywhere other than the third-party service they belong to.
      </p>
      <h3>Role and search configuration</h3>
      <p>Keywords, locations, matching criteria, and outreach templates you set up.</p>
      <h3>Contact data extracted through the Service</h3>
      <p>
        When a search finds a public job post or listing, the Service may extract publicly visible contact
        details (name, email, phone) from that post to enable the outreach you&rsquo;ve configured. This is
        data about third parties, not our users — we hold it only as long as needed to serve your outreach,
        and only use it for the purpose you directed.
      </p>
      <h3>Uploaded content</h3>
      <p>Resumes and other documents you upload to the Service.</p>
      <h3>Billing data</h3>
      <p>
        Your subscription plan and status. Payment details (card numbers, billing address) are collected
        and stored by <strong>Lemon Squeezy</strong>, our payment processor and Merchant of Record — we
        never receive or store your full payment details ourselves.
      </p>
      <h3>Usage and log data</h3>
      <p>
        Technical logs (execution history, error logs, IP address at sign-in) used for reliability,
        debugging, and abuse prevention.
      </p>

      <h2>2. Why we collect it</h2>
      <ul>
        <li>To operate the Service: run your configured searches, matching, sends, and reply monitoring;</li>
        <li>To secure your account and detect abuse;</li>
        <li>To bill your subscription and provide support;</li>
        <li>To maintain and improve the Service&rsquo;s reliability.</li>
      </ul>
      <p>We don&rsquo;t use your data to train third-party AI models, and we don&rsquo;t sell it to anyone.</p>

      <h2>3. Who we share it with</h2>
      <p>
        We use a small set of service providers (&ldquo;subprocessors&rdquo;) to run Cuneihire. Each only
        receives what it needs to do its job:
      </p>
      <ul>
        <li><strong>Supabase</strong> — database hosting and authentication for all account and application data;</li>
        <li><strong>Lemon Squeezy</strong> — payment processing and subscription billing (Merchant of Record);</li>
        <li><strong>Vercel</strong> — hosting for the web application;</li>
        <li>Our backend server host — runs the search/send/matching worker processes;</li>
        <li>
          <strong>Google (Gemini API)</strong> — when AI-assisted match scoring is enabled on your account,
          the relevant job-post text is sent to Google&rsquo;s API to generate a score;
        </li>
        <li>
          <strong>LinkedIn, Indeed, and other job platforms</strong> — the Service interacts with these
          using the credentials or public data you&rsquo;ve directed it to use.
        </li>
      </ul>
      <p>
        We don&rsquo;t share your data with advertisers, and we don&rsquo;t use third-party advertising or
        tracking cookies on the Service. We may disclose data if required by law.
      </p>

      <h2>4. How we protect it</h2>
      <p>
        Sensitive credentials (LinkedIn session, email account credentials) are encrypted at rest with
        AES-256-GCM. Application data is isolated per account with database-level row security, so one
        account&rsquo;s data isn&rsquo;t reachable from another&rsquo;s. Optional two-factor authentication
        is available on every account.
      </p>

      <h2>5. How long we keep it</h2>
      <p>
        We keep your data for as long as your account is active. If you delete your account, we delete or
        anonymize your data within a reasonable period, except where we&rsquo;re required to retain records
        (e.g. billing records) for legal or accounting purposes.
      </p>

      <h2>6. Your rights</h2>
      <p>
        You can access, correct, export, or delete your data at any time from your account settings, or by
        emailing <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. If you&rsquo;re a third party whose
        contact details were extracted through another user&rsquo;s outreach configuration and you&rsquo;d
        like that data removed, contact us at the same address and we&rsquo;ll act on it.
      </p>

      <h2>7. Children</h2>
      <p>
        The Service isn&rsquo;t directed at anyone under 18, and we don&rsquo;t knowingly collect data from
        children.
      </p>

      <h2>8. Changes to this policy</h2>
      <p>
        We may update this policy as the Service evolves. We&rsquo;ll update the &ldquo;Last updated&rdquo;
        date above when we do, and for material changes we&rsquo;ll make a reasonable effort to notify you
        directly.
      </p>

      <h2>9. Contact</h2>
      <p>
        Questions about this policy, or a request about your data? Reach us at{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </LegalPageShell>
  );
}
