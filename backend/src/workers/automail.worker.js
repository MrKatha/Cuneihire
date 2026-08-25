const pc = require("picocolors");
const nodemailer = require("nodemailer");
const axios = require("axios");
const { decryptPassword } = require("../lib/crypto");
const { ExecutionLogger } = require("../lib/logger");
const { chooseTemplateForJob, generateAiPersonalizedEmail, applyPlaceholders, hasUnresolvedPlaceholders } = require("../services/ai.service");
const { loadAccountPool, buildTransporter } = require("../lib/smtpPool");
const { resolveRoleAttachments, describeFiles } = require("../lib/emailResolve");
const { spendAiCredit } = require("../lib/aiCredits");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStartOfDayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function runAutomailJobs(supabase) {
  try {
    // 1. Fetch users with Automail enabled
    const { data: users, error: usersErr } = await supabase
      .from("automailsend_app_state")
      .select("*")
      .eq("automail_enabled", true);

    if (usersErr) throw usersErr;

    console.log(pc.dim(`  -> Result: Found ${users ? users.length : 0} users with automail enabled.`));
    if (!users || users.length === 0) return;

    // Account-wide admin ceiling (2026-08-25) — one global number for now, no billing/plan system yet
    // (see docs/memory.md). Fetched once per run, not per user, since it's a single global row.
    const { data: globalSettings } = await supabase
      .from("automailsend_global_settings")
      .select("max_daily_send_limit")
      .eq("id", 1)
      .single();
    const globalDailyLimit = globalSettings?.max_daily_send_limit || 100;

    for (const user of users) {
      const userId = user.user_id;
      const defaultInterval = process.env.AUTOMAIL_WORKER_INTERVAL_SEC ? parseInt(process.env.AUTOMAIL_WORKER_INTERVAL_SEC, 10) : 3;
      const delaySec = user.send_delay_sec || defaultInterval;

      // Platform-managed AI (2026-08-18) — no more per-user provider/key, just an enable toggle + a
      // credit balance spent via spendAiCredit() after each successful Gemini call. See aiCredits.js.
      const aiEnabled = !!user.ai_personalization_enabled;
      const aiTemperature = typeof user.ai_temperature === "number" ? user.ai_temperature : 0.4;
      // AI tab (2026-08-18) — a recipient whose scored job post falls below this is skipped entirely by
      // this fully-automated loop (never applied to JAMS's manual/bulk sends in batchSend.worker.js). 0
      // means off. Posts with no score yet (match_score null) are never gated — unknown isn't a fail.
      const matchStrictness = user.ai_match_strictness || 0;
      let strictnessSkippedLogged = false;
      // Structured, user-controlled contact info backing the {{candidate_*}} template variables (see
      // ai.service.js's applyPlaceholders/buildUserMessage). Moved off app_state to its own table
      // (2026-08-19, frontend's automailsend_candidate_profiles — the permanent knowledge base a role's
      // resume module selection now draws from) — app_state's old candidate_* columns are stale/unused
      // as of that change, so this must read the new table, not user.candidate_*.
      // 2026-08-19: also select global_files — the candidate's whole files pool (repurposed column, see
      // storage.ts's mapCandidateProfileRow) — resolveRoleAttachments() below reads it directly off this
      // raw row (snake_case), same as the role_defs rows. 2026-08-20: also global_resume_id — the
      // candidate-level default resume a role falls back to unless it has its own resume_id override.
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

      if (user.is_blocked) {
        console.log(pc.red(`[Automail] User ${userId} is blocked by admin. Skipping.`));
        continue;
      }

      // 2. Load this user's SMTP account pool (active + verified), each with its own remaining
      // daily quota already computed against today's sent_log.
      const pool = await loadAccountPool(supabase, userId, getStartOfDayUTC());
      if (pool.length === 0) {
        console.log(pc.yellow(`[Automail] User ${userId.substring(0, 8)} enabled automail but has no verified, active SMTP accounts. Skipping.`));
        continue;
      }

      const poolRemaining = pool.reduce((sum, a) => sum + Math.max(0, a.remaining), 0);

      // Account-wide daily cap (2026-08-25, operator ask — "Activate Automation"'s daily limit is now
      // THE governing number, not each SMTP account's own 50/day default summed together). Each pooled
      // account already carries its own sent-today count via `remaining` (see smtpPool.js), so total sent
      // today across the whole pool is just the inverse of that — no extra query needed.
      const totalSentToday = pool.reduce((sum, a) => sum + Math.max(0, (a.dailyLimit || 50) - a.remaining), 0);
      // Smaller of: this account's own daily_mail_limit, the admin's account-wide ceiling, and what the
      // SMTP pool can physically still send today.
      const accountLimit = Math.min(user.daily_mail_limit || 50, globalDailyLimit);
      const accountRemaining = Math.max(0, accountLimit - totalSentToday);
      const totalRemaining = Math.min(poolRemaining, accountRemaining);
      if (totalRemaining <= 0) {
        // Silently skip to prevent log flooding every few seconds
        continue;
      }

      // 3. Fetch pending recipients
      const { data: rawPending, error: pendingErr } = await supabase
        .from("automailsend_recipients")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "pending")
        .limit(totalRemaining * 3); // fetch extra to account for duplicates

      if (pendingErr) {
        console.error(pc.red(`Error fetching pending recipients for user ${userId}: ${pendingErr.message}`));
        continue;
      }

      const uniquePendingMap = new Map();
      for (const r of (rawPending || [])) {
        if (!r.email) {
           uniquePendingMap.set(`id:${r.id}`, r); // keep ones without email
           continue;
        }
        const key = r.email.toLowerCase();
        if (!uniquePendingMap.has(key)) {
          uniquePendingMap.set(key, r);
        }
      }
      const pending = Array.from(uniquePendingMap.values()).slice(0, totalRemaining);

      if (!pending || pending.length === 0) {
        // Silently skip if no emails to send
        continue;
      }

      // We have work to do, initialize the logger
      const logger = new ExecutionLogger(userId, "automail");
      await logger.start(`Starting Automail batch process...`);
      await logger.append("INFO", `SMTP pool: ${pool.length} account(s), ${totalRemaining} remaining today. Pending: ${pending.length}`);

      // 4. Fetch user templates + role defs. 2026-08-19: randomization removed — each role now has an
      // explicit email_send_mode (manual/ai-select/ai-write) + selected_template_id, resolved per
      // recipient below. Attachments are resolved per ROLE too — one resume (own resume_id override, or
      // the candidate's global_resume_id) — see resolveRoleAttachments() in lib/emailResolve.js.
      const { data: templates, error: tempErr } = await supabase
        .from("automailsend_templates")
        .select("*")
        .eq("user_id", userId);

      if (tempErr || !templates) {
        await logger.finish("error", `Error fetching templates`);
        continue;
      }

      const { data: roleDefs } = await supabase
        .from("automailsend_role_defs")
        .select("key, email_send_mode, selected_template_id, resume_id")
        .eq("user_id", userId);

      const templatesByRole = {};
      templates.forEach(t => { (templatesByRole[t.role] = templatesByRole[t.role] || []).push(t); });

      const roleDefByKey = {};
      (roleDefs || []).forEach(r => { roleDefByKey[r.key] = r; });

      // 5. Send loop — pick the account with the most remaining quota for each recipient, building
      // (and caching) one transporter per account actually used.
      const transporters = new Map();
      let sentCount = 0;
      for (const recipient of pending) {
        // AI tab match strictness (2026-08-18) — skip entirely, before any template/AI/send work, when
        // this recipient's scored job post falls below the threshold. Unscored posts (match_score null)
        // are never gated — see the field's comment in types.ts for why "unknown" isn't treated as a fail.
        if (matchStrictness > 0 && recipient.match_score != null && recipient.match_score < matchStrictness) {
          await supabase.from("automailsend_recipients").update({ status: "failed" }).eq("id", recipient.id);
          await supabase.from("automailsend_sent_log").insert({
            user_id: userId,
            email: recipient.email || recipient.phone || "Unknown",
            role: recipient.role,
            title: recipient.title,
            status: "skipped",
            error_message: `Below your match strictness threshold (scored ${recipient.match_score}, need ${matchStrictness}+).`,
          });
          if (!strictnessSkippedLogged) {
            await logger.append("INFO", `Skipping recipient(s) below your match strictness threshold (${matchStrictness}) for the rest of this run.`);
            strictnessSkippedLogged = true;
          }
          continue;
        }

        const account = pool
          .filter(a => a.remaining > 0)
          .sort((a, b) => b.remaining - a.remaining)[0];

        if (!account) {
          await logger.append("WARN", `All SMTP accounts have reached their daily limit. Stopping early.`);
          break;
        }

        // 2026-08-20: role-mode-aware resolution replaces pickFromPool()'s randomization — three send
        // modes (manual / ai-select / ai-write — "let AI write the whole email" was tried, dropped, then
        // brought back per operator ask; see docs/architecture.md's "Email Templates redesign" section
        // and its follow-ups).
        const roleTemplates = templatesByRole[recipient.role] || [];
        const roleDef = roleDefByKey[recipient.role];
        const sendMode = roleDef?.email_send_mode || "manual";

        let template = null;
        if (sendMode === "manual") {
          template = roleTemplates.find((t) => t.id === roleDef?.selected_template_id) || null;
          if (!template) {
            await logger.append("WARN", `Role "${recipient.role}" is set to manual but has no template selected. Skipping recipient ${recipient.email}.`);
            continue;
          }
        } else if (sendMode === "ai-select") {
          if (roleTemplates.length === 0) {
            await logger.append("WARN", `Role "${recipient.role}" is set to "Let AI choose" but has no templates yet. Skipping recipient ${recipient.email}.`);
            continue;
          }
          if (aiEnabled && user.ai_credits > 0) {
            try {
              template = await chooseTemplateForJob(roleTemplates, recipient.role, recipient.context_text, aiTemperature);
              if (template) {
                const spent = await spendAiCredit(supabase, userId);
                user.ai_credits = spent ? user.ai_credits - 1 : 0;
              }
            } catch (aiErr) {
              await logger.append("ERROR", `AI template choice failed: ${aiErr.message}. Falling back to the first template.`);
            }
          }
          if (!template) template = roleTemplates[0];
        }
        // ai-write needs no template at all — content is resolved from scratch below.

        // Attachments: one resume (this role's own resume_id override, else the candidate's
        // global_resume_id) — every job sent for this role shares the same attachment regardless of send
        // mode. See resolveRoleAttachments() in lib/emailResolve.js.
        const roleFiles = resolveRoleAttachments(roleDef, candidateProfileRow).all;
        const resumeLabelForLog = describeFiles(roleFiles);

        let subject;
        let text;
        let templateLabelForLog;

        if (sendMode === "ai-write") {
          if (!aiEnabled || !(user.ai_credits > 0)) {
            await logger.append("WARN", `Role "${recipient.role}" is set to "Let AI write" but AI is off or you're out of credits. Skipping recipient ${recipient.email}.`);
            continue;
          }
          let result;
          try {
            result = await generateAiPersonalizedEmail(user.candidate_info, recipient, recipient.context_text, null, profile, aiTemperature);
          } catch (aiErr) {
            await logger.append("ERROR", `AI write failed for ${recipient.email}: ${aiErr.message}. Skipping.`);
            continue;
          }
          if (result && result.skip) {
            await logger.append("INFO", `AI skipped ${recipient.email}: ${result.reason || "not a relevant job post"}.`);
            await supabase.from("automailsend_recipients").update({ status: "failed" }).eq("id", recipient.id);
            await supabase.from("automailsend_sent_log").insert({
              user_id: userId,
              email: recipient.email || recipient.phone || "Unknown",
              role: recipient.role,
              title: recipient.title,
              status: "skipped",
              error_message: result.reason || "AI determined this wasn't a relevant job opportunity.",
            });
            continue;
          }
          if (!result || !result.subject || !result.body) {
            await logger.append("ERROR", `AI write returned an empty email for ${recipient.email}. Skipping.`);
            continue;
          }
          const spent = await spendAiCredit(supabase, userId);
          user.ai_credits = spent ? user.ai_credits - 1 : 0;
          subject = result.subject;
          text = result.body;
          templateLabelForLog = "AI-written (no template)";
        } else {
          if (!template.subject || !template.content) {
            await logger.append("WARN", `Missing template for role ${recipient.role}. Skipping recipient ${recipient.email}.`);
            continue;
          }
          // The template's own words, only variables filled in — ai-select already spent its (one)
          // credit above just choosing WHICH template, never rewriting its content.
          subject = applyPlaceholders(template.subject, recipient, profile);
          text = applyPlaceholders(template.content, recipient, profile);
          templateLabelForLog = template.label;
        }

        if (!recipient.email) {
          await logger.append("WARN", `Recipient ${recipient.id} has no email address. Skipping.`);
          await supabase.from("automailsend_recipients").update({ status: "failed" }).eq("id", recipient.id);
          await supabase.from("automailsend_sent_log").insert({
            user_id: userId,
            email: recipient.phone || "No Email",
            role: recipient.role,
            title: recipient.title,
            status: "failed",
            error_message: "No email address found",
            template_label: templateLabelForLog,
            resume_label: resumeLabelForLog,
          });
          continue;
        }

        // Hard guardrail: never send an email that still contains a literal unresolved {{...}} token
        // (e.g. a template used {{candidate_phone}} but the profile field is empty, or the AI echoed a
        // token verbatim). Blocked, not delivered — and no SMTP quota is spent, since we `continue`
        // before the send attempt below rather than entering the try/finally that decrements it.
        if (hasUnresolvedPlaceholders(subject) || hasUnresolvedPlaceholders(text)) {
          await logger.append("ERROR", `Blocked send to ${recipient.email}: unresolved template variable(s) found in the final email.`);
          await supabase.from("automailsend_recipients").update({ status: "failed" }).eq("user_id", userId).eq("email", recipient.email);
          await supabase.from("automailsend_sent_log").insert({
            user_id: userId,
            email: recipient.email,
            role: recipient.role,
            title: recipient.title,
            subject: subject,
            body: text,
            status: "failed",
            error_message: "Blocked: unresolved template variable(s) — email not sent.",
            template_label: templateLabelForLog,
            resume_label: resumeLabelForLog,
          });
          continue;
        }

        let status = "failed";
        let errorMsg = null;
        let messageId = null;

        const isHtmlBlock = /<html|<body|<!DOCTYPE|<style|<div|<p|<table|<ul|<ol|<li|<h[1-6]|<br|<hr|<blockquote/i.test(text);

        let finalHtml = "";
        let finalText = "";

        if (isHtmlBlock) {
          finalHtml = text;
        } else {
          finalHtml = text.replace(/\n/g, "<br>");
        }

        const hasAnyTags = /<[a-z][\s\S]*>/i.test(text) || text.includes("<!DOCTYPE");
        if (hasAnyTags) {
          finalText = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                          .replace(/<br[^>]*>/gi, '\n')
                          .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n')
                          .replace(/<[^>]+>/g, '')
                          .replace(/\n\s*\n/g, '\n\n')
                          .trim();
        } else {
          finalText = text;
        }

        const fromEmail = account.fromEmail || account.email;
        const mailOptions = {
          from: account.fromName ? `"${account.fromName}" <${fromEmail}>` : fromEmail,
          to: recipient.email,
          subject,
          text: finalText,
          html: finalHtml,
        };

        if (roleFiles.length > 0) {
          mailOptions.attachments = roleFiles.map(a => ({
            filename: a.name,
            href: a.url,
            contentType: a.type,
          }));
        }

        try {
          if (!transporters.has(account.id)) {
            transporters.set(account.id, buildTransporter(account, decryptPassword));
          }
          const info = await transporters.get(account.id).sendMail(mailOptions);
          messageId = info && info.messageId ? info.messageId : null;
          status = "sent";
          sentCount++;
          await logger.append("SUCCESS", `Sent email to ${recipient.email} via ${account.label || account.email}`);
        } catch (err) {
          status = "failed";
          errorMsg = err.message;
          await logger.append("ERROR", `Failed to send to ${recipient.email} via ${account.label || account.email}: ${err.message}`);
        } finally {
          // Decrement on failure too, not just success — otherwise a persistently broken account
          // (bad credentials, etc.) keeps being picked as "most remaining" for every recipient
          // instead of the pool rotating to a working account.
          account.remaining -= 1;
        }

        // Update recipient status
        await supabase
          .from("automailsend_recipients")
          .update({ status })
          .eq("user_id", userId)
          .eq("email", recipient.email);

        // Log to sent_log
        await supabase
          .from("automailsend_sent_log")
          .insert({
            user_id: userId,
            email: recipient.email,
            role: recipient.role,
            title: recipient.title,
            subject: subject,
            body: text,
            status,
            error_message: errorMsg,
            sent_at: new Date().toISOString(),
            smtp_account_id: account.id,
            template_label: templateLabelForLog,
            resume_label: resumeLabelForLog,
            message_id: messageId,
          });

        if (delaySec > 0) {
          // Anti-ban Jitter: Randomize delay by +/- 20%
          const jitter = Math.random() * 0.4 - 0.2;
          const actualDelayMs = (delaySec * 1000) * (1 + jitter);
          await logger.append("INFO", `Waiting ${Math.round(actualDelayMs / 1000)}s before next email...`);
          await sleep(actualDelayMs);
        }
      }

      await logger.finish("success", `Finished batch. Sent: ${sentCount}`);
    }
  } catch (err) {
    console.error(pc.red("[Automail] Global error: " + err.message));
  }
}

module.exports = { runAutomailJobs };
