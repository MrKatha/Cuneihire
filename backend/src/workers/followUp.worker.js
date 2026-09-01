// Automated follow-up emails (2026-08-31, MVP push) — up to 3 per recipient, on a real per-role
// configurable interval, AI-written by default with an optional per-slot template override. See
// docs/architecture.md and the schema comment on automailsend_recipients.next_follow_up_at.
//
// Structurally mirrors automail.worker.js's outer-loop shape (per-user SMTP pool + daily-limit math,
// jittered anti-ban delay), but the inner query targets already-sent recipients instead of pending ones,
// and there's no per-user "enabled" toggle to check — automailsend_role_defs.follow_up_interval_days being
// set (which is what populates next_follow_up_at in the first place) is the only gate needed. Finding the
// set of users with anything due is therefore a single query against automailsend_recipients, not a scan of
// every user's app_state.
const pc = require("picocolors");
const { decryptPassword } = require("../lib/crypto");
const { ExecutionLogger } = require("../lib/logger");
const { generateFollowUpEmail, applyPlaceholders, hasUnresolvedPlaceholders } = require("../services/ai.service");
const { loadAccountPool, buildTransporter } = require("../lib/smtpPool");
const { resolveRoleAttachments, describeFiles } = require("../lib/emailResolve");
const { spendAiCredit } = require("../lib/aiCredits");
const { spendAppCredit } = require("../lib/appCredits");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStartOfDayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Per-tier cap now (2026-08-31, operator spec: Starter 0 / Pro 1 / Elite 3) — automailsend_app_state.
// max_follow_ups, read per-user below (`user.max_follow_ups`), replaces this as a flat constant. Kept only
// as the ceiling nothing should exceed regardless of tier — the 3 follow_up_template_N_id slots on
// automailsend_role_defs are hardcoded to 3 (see that table's schema comment), so a tier granting more
// than this would need new template slots too, not just a bigger number here.
const MAX_FOLLOW_UPS = 3;
// On an SMTP failure, don't leave next_follow_up_at "already due" forever (a broken address would get
// hammered every tick) — push it forward by a short fixed backoff instead. Distinct from the credit-
// exhaustion case, which retries every tick until an admin tops up (see the per-recipient loop below).
const FAILURE_BACKOFF_DAYS = 1;

async function runFollowUpJobs(supabase) {
  try {
    const nowIso = new Date().toISOString();

    // Which users have anything due right now — a single indexed query (idx_automailsend_recipients_
    // followup_due), not a per-user scan. next_follow_up_at is only ever set on a recipient whose role had
    // follow_up_interval_days configured, so this is also the whole "is this feature on for this role" gate.
    const { data: dueRows, error: dueErr } = await supabase
      .from("automailsend_recipients")
      .select("user_id")
      .eq("has_replied", false)
      .eq("status", "sent")
      .not("next_follow_up_at", "is", null)
      .lte("next_follow_up_at", nowIso);

    if (dueErr) throw dueErr;
    const userIds = [...new Set((dueRows || []).map((r) => r.user_id))];
    if (userIds.length === 0) return;

    const { data: globalSettings } = await supabase
      .from("automailsend_global_settings")
      .select("max_daily_send_limit")
      .eq("id", 1)
      .single();
    const globalDailyLimit = globalSettings?.max_daily_send_limit || 100;

    for (const userId of userIds) {
      const { data: user } = await supabase
        .from("automailsend_app_state")
        .select("*")
        .eq("user_id", userId)
        .single();
      if (!user || user.is_blocked) continue;

      // ai_email_writing_enabled (2026-08-31, operator spec) is the TIER's ceiling on AI-written content —
      // separate from ai_personalization_enabled, which is the user's own on/off preference and also gates
      // AI job-match scoring elsewhere (scraper.worker.js/jobspy.worker.js), unaffected by this. A Starter
      // account can have AI scoring on but still can't get AI-written follow-ups.
      const aiEnabled = !!user.ai_personalization_enabled && user.ai_email_writing_enabled !== false;
      const aiTemperature = typeof user.ai_temperature === "number" ? user.ai_temperature : 0.4;
      // Tier-driven cap (2026-08-31) — clamped against MAX_FOLLOW_UPS since only 3 template slots exist
      // regardless of what a future tier might claim; a Starter user's 0 means the query below matches
      // nothing, which is exactly "no follow-ups," not an error case.
      const maxFollowUpsForUser = Math.min(
        typeof user.max_follow_ups === "number" ? user.max_follow_ups : MAX_FOLLOW_UPS,
        MAX_FOLLOW_UPS
      );
      if (maxFollowUpsForUser <= 0) continue;

      const { data: candidateProfileRow } = await supabase
        .from("automailsend_candidate_profiles")
        .select("name, email, phone, portfolio_url, resume_url, global_files, global_resume_id")
        .eq("user_id", userId)
        .maybeSingle();
      const profile = {
        name: candidateProfileRow?.name || "",
        email: candidateProfileRow?.email || "",
        phone: candidateProfileRow?.phone || "",
        portfolioUrl: candidateProfileRow?.portfolio_url || "",
        resumeUrl: candidateProfileRow?.resume_url || "",
      };

      const pool = await loadAccountPool(supabase, userId, getStartOfDayUTC());
      if (pool.length === 0) continue;

      const poolRemaining = pool.reduce((sum, a) => sum + Math.max(0, a.remaining), 0);
      const totalSentToday = pool.reduce((sum, a) => sum + Math.max(0, (a.dailyLimit || 50) - a.remaining), 0);
      const accountLimit = Math.min(user.daily_mail_limit || 50, globalDailyLimit);
      const accountRemaining = Math.max(0, accountLimit - totalSentToday);
      const totalRemaining = Math.min(poolRemaining, accountRemaining);
      if (totalRemaining <= 0) continue;

      const { data: due } = await supabase
        .from("automailsend_recipients")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "sent")
        .eq("has_replied", false)
        .lt("follow_up_count", maxFollowUpsForUser)
        .not("next_follow_up_at", "is", null)
        .lte("next_follow_up_at", nowIso)
        .limit(totalRemaining * 3);
      if (!due || due.length === 0) continue;

      const { data: templates } = await supabase.from("automailsend_templates").select("*").eq("user_id", userId);
      const templatesById = {};
      (templates || []).forEach((t) => { templatesById[t.id] = t; });

      const { data: roleDefs } = await supabase
        .from("automailsend_role_defs")
        .select("key, resume_id, follow_up_interval_days, follow_up_template_1_id, follow_up_template_2_id, follow_up_template_3_id")
        .eq("user_id", userId);
      const roleDefByKey = {};
      (roleDefs || []).forEach((r) => { roleDefByKey[r.key] = r; });

      const delaySec = user.send_delay_sec || 3;
      const logger = new ExecutionLogger(userId, "follow_up");
      await logger.start(`Starting follow-up batch process...`);
      await logger.append("INFO", `SMTP pool: ${pool.length} account(s), ${totalRemaining} remaining today. Due: ${due.length}`);

      const transporters = new Map();
      let sentCount = 0;
      let appCreditsSkippedLogged = false;

      for (const recipient of due.slice(0, totalRemaining)) {
        const roleDef = roleDefByKey[recipient.role];
        if (!roleDef || !roleDef.follow_up_interval_days) continue; // role's follow-ups turned off since this became due

        // App credits (2026-08-31) — checked before ANY template/AI/send work, same policy as
        // automail.worker.js/batchSend.worker.js: log once, skip silently after, no status change.
        if (!(user.app_credits > 0)) {
          if (!appCreditsSkippedLogged) {
            await logger.append("WARN", `Out of app credits — skipping remaining follow-up(s) this run.`);
            appCreditsSkippedLogged = true;
          }
          continue;
        }

        const account = pool.filter((a) => a.remaining > 0).sort((a, b) => b.remaining - a.remaining)[0];
        if (!account) {
          await logger.append("WARN", `All SMTP accounts have reached their daily limit. Stopping early.`);
          break;
        }

        const slot = recipient.follow_up_count + 1; // 1, 2, or 3
        const slotTemplateId = roleDef[`follow_up_template_${slot}_id`];
        const roleFiles = resolveRoleAttachments(roleDef, candidateProfileRow).all;
        const resumeLabelForLog = describeFiles(roleFiles);

        let subject;
        let text;
        let templateLabelForLog;
        let aiWrote = false;

        if (slotTemplateId && templatesById[slotTemplateId]) {
          // Candidate linked a fixed template for this slot — sent verbatim, no AI, same "manual" semantics
          // as email_send_mode='manual'.
          const template = templatesById[slotTemplateId];
          subject = applyPlaceholders(template.subject, recipient, profile);
          text = applyPlaceholders(template.content, recipient, profile);
          templateLabelForLog = `${template.label} (follow-up ${slot})`;
        } else {
          // AI-written (the default) — needs both AI enabled and an ai_credit, same gate as ai-write mode.
          if (!aiEnabled || !(user.ai_credits > 0)) {
            await logger.append("WARN", `Follow-up ${slot} for ${recipient.email} needs AI (no template linked) but AI is off or you're out of credits. Skipping.`);
            continue;
          }
          const { data: previousLog } = await supabase
            .from("automailsend_sent_log")
            .select("subject, body")
            .eq("user_id", userId)
            .eq("email", recipient.email)
            .order("sent_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          let result;
          try {
            result = await generateFollowUpEmail(user.candidate_info, recipient, recipient.context_text, previousLog || null, profile, aiTemperature, userId, slot);
          } catch (aiErr) {
            await logger.append("ERROR", `AI follow-up failed for ${recipient.email}: ${aiErr.message}. Skipping.`);
            continue;
          }
          if (result && result.skip) {
            await logger.append("INFO", `AI skipped follow-up for ${recipient.email}: ${result.reason || "no longer worth following up on"}.`);
            // Exhaust this recipient's follow-ups rather than retrying forever on the same "not worth it"
            // judgment — same reasoning as ai-write's skip handling in automail.worker.js, adapted: here we
            // don't fail the recipient (they were already successfully sent to), just stop scheduling more.
            await supabase.from("automailsend_recipients").update({ next_follow_up_at: null }).eq("id", recipient.id);
            continue;
          }
          if (!result || !result.subject || !result.body) {
            await logger.append("ERROR", `AI follow-up returned an empty email for ${recipient.email}. Skipping.`);
            continue;
          }
          subject = result.subject;
          text = result.body;
          templateLabelForLog = `AI-written (follow-up ${slot})`;
          aiWrote = true;
        }

        if (hasUnresolvedPlaceholders(subject) || hasUnresolvedPlaceholders(text)) {
          await logger.append("ERROR", `Blocked follow-up to ${recipient.email}: unresolved template variable(s).`);
          continue;
        }

        const fromEmail = account.fromEmail || account.email;
        const finalHtml = /<html|<body|<!DOCTYPE|<style|<div|<p|<table|<ul|<ol|<li|<h[1-6]|<br|<hr|<blockquote/i.test(text)
          ? text
          : text.replace(/\n/g, "<br>");
        const mailOptions = {
          from: account.fromName ? `"${account.fromName}" <${fromEmail}>` : fromEmail,
          to: recipient.email,
          subject,
          text,
          html: finalHtml,
        };
        if (roleFiles.length > 0) {
          mailOptions.attachments = roleFiles.map((a) => ({ filename: a.name, href: a.url, contentType: a.type }));
        }

        let status = "failed";
        let errorMsg = null;
        let messageId = null;
        try {
          if (!transporters.has(account.id)) transporters.set(account.id, buildTransporter(account, decryptPassword));
          const info = await transporters.get(account.id).sendMail(mailOptions);
          messageId = info && info.messageId ? info.messageId : null;
          status = "sent";
          sentCount++;
          await logger.append("SUCCESS", `Sent follow-up ${slot} to ${recipient.email} via ${account.label || account.email}`);
        } catch (err) {
          status = "failed";
          errorMsg = err.message;
          await logger.append("ERROR", `Failed to send follow-up ${slot} to ${recipient.email}: ${err.message}`);
        } finally {
          account.remaining -= 1;
        }

        await supabase.from("automailsend_sent_log").insert({
          user_id: userId,
          email: recipient.email,
          role: recipient.role,
          title: recipient.title,
          subject,
          body: text,
          status,
          error_message: errorMsg,
          sent_at: new Date().toISOString(),
          smtp_account_id: account.id,
          template_label: templateLabelForLog,
          resume_label: resumeLabelForLog,
          message_id: messageId,
          send_stage: `follow_up_${slot}`,
        });

        if (status === "sent") {
          const spentApp = await spendAppCredit(supabase, userId);
          user.app_credits = spentApp ? user.app_credits - 1 : 0;
          if (aiWrote) {
            const spentAi = await spendAiCredit(supabase, userId);
            user.ai_credits = spentAi ? user.ai_credits - 1 : 0;
          }
          await supabase
            .from("automailsend_recipients")
            .update({
              follow_up_count: slot,
              last_sent_at: new Date().toISOString(),
              next_follow_up_at:
                slot < MAX_FOLLOW_UPS
                  ? new Date(Date.now() + roleDef.follow_up_interval_days * 24 * 60 * 60 * 1000).toISOString()
                  : null,
            })
            .eq("id", recipient.id);
        } else {
          // Retry the same slot's content next time (follow_up_count NOT advanced), just push the due date
          // out so a broken address doesn't get retried every 5-minute tick forever.
          await supabase
            .from("automailsend_recipients")
            .update({ next_follow_up_at: new Date(Date.now() + FAILURE_BACKOFF_DAYS * 24 * 60 * 60 * 1000).toISOString() })
            .eq("id", recipient.id);
        }

        if (delaySec > 0) {
          const jitter = Math.random() * 0.4 - 0.2;
          await sleep(delaySec * 1000 * (1 + jitter));
        }
      }

      await logger.finish("success", `Finished follow-up batch. Sent: ${sentCount}`);
    }
  } catch (err) {
    console.error(pc.red("[FollowUp] Global error: " + err.message));
  }
}

module.exports = { runFollowUpJobs };
