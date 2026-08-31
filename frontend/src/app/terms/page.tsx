import type { Metadata } from "next";
import LegalPageShell from "@/components/LegalPageShell";

export const metadata: Metadata = {
  title: "Terms of Service — Cuneihire",
  description: "The terms that govern use of Cuneihire.",
};

const LAST_UPDATED = "August 31, 2026";
const SUPPORT_EMAIL = "help@cuneihive.com";

export default function TermsPage() {
  return (
    <LegalPageShell title="Terms of Service" lastUpdated={LAST_UPDATED} activeHref="/terms">
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of Cuneihire (the
        &ldquo;Service&rdquo;), operated by Muhammad Sohaib Amin, trading as Cuneihive (&ldquo;Cuneihive,&rdquo;
        &ldquo;we,&rdquo; &ldquo;us&rdquo;). By creating an account or otherwise using the Service, you agree
        to these Terms. If you don&rsquo;t agree, don&rsquo;t use the Service.
      </p>

      <h2>1. What Cuneihire does</h2>
      <p>
        Cuneihire helps you find and reach out to relevant job posts and candidates. Depending on the
        features you enable, it can: search job posts on LinkedIn using a session you connect yourself
        (via our browser extension) or from open job boards; extract publicly visible contact details from
        those posts; score how well a post matches roles you define, optionally using AI; send outreach
        emails through an email account you connect; and monitor that inbox for replies. You control what
        gets searched, who gets contacted, and what&rsquo;s sent — Cuneihire is a tool you operate, not an
        autonomous service acting on our own judgment.
      </p>

      <h2>2. Your account</h2>
      <p>
        You need an account to use the Service. You&rsquo;re responsible for keeping your login credentials
        and any account you connect to Cuneihire (LinkedIn session, email account) secure, and for
        everything that happens under your account. Tell us immediately at{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> if you suspect unauthorized access.
      </p>

      <h2>3. Connecting third-party accounts — your responsibility, not ours</h2>
      <p>
        Cuneihire only acts through accounts and credentials you voluntarily connect — your LinkedIn
        session, your email account. We don&rsquo;t create, control, or have any relationship with those
        third-party services. In particular:
      </p>
      <ul>
        <li>
          You must be the authorized holder of any LinkedIn account and email account you connect, and your
          use of those accounts through Cuneihire must comply with that provider&rsquo;s own terms of
          service. LinkedIn&rsquo;s terms restrict automated access to their platform — connecting your
          session to Cuneihire is your decision and at your own risk, including the risk of rate-limiting,
          restriction, or suspension of that account by LinkedIn. We take reasonable steps (pacing,
          human-like send timing) to reduce that risk, but we cannot eliminate it and we don&rsquo;t
          guarantee any outcome with LinkedIn or any other third-party platform.
        </li>
        <li>
          Outreach emails send through the email account you connect, using your name and address as the
          sender of record. You&rsquo;re responsible for complying with applicable email and marketing law
          in the jurisdictions you send to and from (e.g. the CAN-SPAM Act, CASL, GDPR/PECR, or your local
          equivalent) — including having a lawful basis to contact each recipient, honoring opt-outs, and
          not sending unlawful, deceptive, or unsolicited bulk content.
        </li>
      </ul>

      <h2>4. Acceptable use</h2>
      <p>You agree not to use the Service to:</p>
      <ul>
        <li>Access, scrape, or attempt to access any account or data you&rsquo;re not authorized to access;</li>
        <li>
          Send unlawful, harassing, deceptive, or unsolicited content, or contact anyone who has asked not
          to be contacted;
        </li>
        <li>
          Use contact information extracted through the Service for any purpose other than the outreach
          you configure it for — reselling, republishing, or otherwise trading extracted contact data is
          not permitted;
        </li>
        <li>Interfere with or attempt to disrupt the Service&rsquo;s infrastructure or other users&rsquo; use of it;</li>
        <li>Circumvent any usage limits, credit system, or plan restriction; or</li>
        <li>Use the Service for any unlawful purpose.</li>
      </ul>
      <p>
        We may suspend or terminate accounts that violate this section, with or without notice, particularly
        where continued access risks harm to other users, third parties, or the Service itself.
      </p>

      <h2>5. Subscriptions and billing</h2>
      <p>
        Paid plans are billed as recurring subscriptions. Payments are processed by{" "}
        <a href="https://www.lemonsqueezy.com" target="_blank" rel="noopener noreferrer">
          Lemon Squeezy
        </a>
        , our Merchant of Record — Lemon Squeezy, not Cuneihive, is the seller of record for your purchase,
        handles your payment details, and its own{" "}
        <a href="https://www.lemonsqueezy.com/buyer-terms" target="_blank" rel="noopener noreferrer">
          Buyer Terms &amp; Conditions
        </a>{" "}
        govern the transaction itself. We never see or store your full card details. You can manage or
        cancel your subscription at any time from your account&rsquo;s Billing settings. See our{" "}
        <a href="/refund-policy">Refund Policy</a> for how refunds work.
      </p>

      <h2>6. Your content and data</h2>
      <p>
        You keep ownership of the content you upload (resumes, templates, role definitions) and the data
        you connect. You grant us a license to use it solely to operate the Service on your behalf — to
        search, score, send, and store on your account&rsquo;s instruction. We don&rsquo;t use your content
        to train third-party AI models, and we don&rsquo;t sell your data. See our{" "}
        <a href="/privacy">Privacy Policy</a> for how we handle it.
      </p>

      <h2>7. Intellectual property</h2>
      <p>
        The Service itself — its software, design, and branding — belongs to Cuneihive. These Terms
        don&rsquo;t grant you any rights to it beyond what&rsquo;s needed to use the Service as intended.
      </p>

      <h2>8. Disclaimer of warranties</h2>
      <p>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranties of
        any kind, express or implied — including any warranty that job matches, AI scoring, or email
        deliverability will be accurate, complete, or achieve any particular result. Automated messaging and
        sending carries inherent risk (spam-filtering, platform restriction, recipient response, or lack
        thereof); use of the Service for automated outreach is at your own risk.
      </p>

      <h2>9. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, Cuneihive isn&rsquo;t liable for any indirect, incidental,
        or consequential damages arising from your use of the Service — including account bans or
        restrictions imposed by third-party platforms, data loss, or lost business — and our total liability
        for any claim arising from these Terms or the Service is limited to the amount you paid us in the
        12 months before the claim arose.
      </p>

      <h2>10. Termination</h2>
      <p>
        You can stop using the Service and delete your account at any time. We may suspend or terminate
        your access for violating these Terms, non-payment, or where required by law. Sections that by
        their nature should survive termination (ownership, disclaimers, limitation of liability) will.
      </p>

      <h2>11. Changes to these Terms</h2>
      <p>
        We may update these Terms as the Service evolves. We&rsquo;ll update the &ldquo;Last updated&rdquo;
        date above when we do; continued use after a change means you accept the update. For material
        changes, we&rsquo;ll make a reasonable effort to notify you directly.
      </p>

      <h2>12. Governing law</h2>
      <p>
        These Terms are governed by the laws of Pakistan, without regard to conflict-of-law principles.
      </p>

      <h2>13. Contact</h2>
      <p>
        Questions about these Terms? Reach us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </LegalPageShell>
  );
}
