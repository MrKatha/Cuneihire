const pc = require("picocolors");
const { supabase } = require("../config/supabase");
const { decryptPassword } = require("../lib/crypto");
const { chooseTemplateForJob, generateAiPersonalizedEmail, applyPlaceholders, hasUnresolvedPlaceholders } = require("../services/ai.service");
const { loadAccountPool, buildTransporter } = require("../lib/smtpPool");
const { resolveRoleAttachments, describeFiles, computeNextFollowUpAt } = require("../lib/emailResolve");
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

async function processBatchSendJob(job) {
  const { user_id } = job.data;
  console.log(pc.blue(`[BatchSend Worker] Starting batch send for user ${user_id}`));

  try {
    // 1. Fetch user state and templates
    const { data: userState, error: userErr } = await supabase
      .from("automailsend_app_state")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (userErr || !userState) throw new Error("Could not fetch user state");

    if (userState.is_blocked) {
      console.log(pc.red(`[BatchSend] User ${user_id} is blocked by admin. Halting.`));
      return;
    }

    // batchTargetIds are still signaled via the config jsonb blob (written by JamsTab's bulk-send
    // dialog) — unrelated to which SMTP account sends the mail. batchMode (the old global "AI
    // personalize / Template" picker) is retired (2026-08-19) — each recipient's role now carries its
    // own email_send_mode, resolved per-recipient below, same as automail.worker.js. See
    // docs/architecture.md's "Email Templates redesign" section.
    const config = userState.config || {};
    const defaultInterval = process.env.BATCH_INTERVAL_SEC ? parseInt(process.env.BATCH_INTERVAL_SEC, 10) : 3;
    const delaySec = userState.send_delay_sec || defaultInterval;

    // Structured, user-controlled contact info backing the {{candidate_*}} template variables (see
    // ai.service.js's applyPlaceholders/buildUserMessage). Moved off app_state to its own table
    // (2026-08-19, frontend's automailsend_candidate_profiles — the permanent knowledge base a role's
    // resume module selection now draws from) — app_state's old candidate_* columns are stale/unused as
    // of that change, so this must read the new table, not userState.candidate_*.
    // 2026-08-20: also global_resume_id — the candidate-level default resume a role falls back to unless
    // it has its own resume_id override (resolveRoleAttachments in lib/emailResolve.js).
    const { data: candidateProfileRow } = await supabase
      .from("automailsend_candidate_profiles")
      .select("name, email, phone, portfolio_url, resume_url, global_files, global_resume_id")
      .eq("user_id", user_id)
      .maybeSingle();
    const profile = {
      name: candidateProfileRow?.name || "",
      email: candidateProfileRow?.email || "",
      phone: candidateProfileRow?.phone || "",
      portfolioUrl: candidateProfileRow?.portfolio_url || "",
      resumeUrl: candidateProfileRow?.resume_url || "",
    };

    const pool = await loadAccountPool(supabase, user_id, getStartOfDayUTC());
    if (pool.length === 0) {
      throw new Error("No verified, active SMTP accounts");
    }

    const { data: templatesArray } = await supabase
      .from("automailsend_templates")
      .select("*")
      .eq("user_id", user_id);

    // 2026-08-20: randomization removed — each role now has an explicit email_send_mode
    // (manual/ai-select/ai-write) + selected_template_id, resolved per recipient below. Attachments
    // resolve to one resume (resume_id override, else global_resume_id) — see resolveRoleAttachments() in
    // lib/emailResolve.js. No early bail on an empty templates table any more — a role in ai-write mode
    // needs none at all; a manual/ai-select role with nothing here is skipped per-recipient instead, same
    // as automail.worker.js.
    const templates = {};
    for (const t of (templatesArray || [])) {
      (templates[t.role] = templates[t.role] || []).push(t);
    }

    const { data: roleDefsArray } = await supabase
      .from("automailsend_role_defs")
      .select("key, email_send_mode, selected_template_id, resume_id, follow_up_interval_days, follow_up_template_1_id, follow_up_template_2_id, follow_up_template_3_id")
      .eq("user_id", user_id);

    const roleDefByKey = {};
    for (const r of (roleDefsArray || [])) {
      roleDefByKey[r.key] = r;
    }

    // 2. Fetch sent logs to filter out what has already been sent. Keyed by email ALONE, not
    // email::role (2026-08-28 fix, operator ask — "keep mail as the main criteria... we should not
    // apply multiple times in a single mail" regardless of job title/role). Confirmed live: one real
    // contact had 3 separate "sent" rows before this fix. A role is just which of the candidate's own
    // search categories found a post — the same recruiter's inbox doesn't care which one, and getting
    // the same application twice reads as spam, not enthusiasm.
    const { data: sentLog } = await supabase
      .from("automailsend_sent_log")
      .select("email")
      .eq("user_id", user_id)
      .in("status", ["sent", "skipped"]);

    const sentEmails = new Set((sentLog || []).map(s => s.email.toLowerCase()));

    // 3. Check daily quota — the sum of remaining capacity across the whole SMTP pool
    const totalRemaining = pool.reduce((sum, a) => sum + Math.max(0, a.remaining), 0);
    if (totalRemaining <= 0) {
      console.log(pc.yellow(`[BatchSend] User ${user_id} — all SMTP accounts reached their daily limit. Skipping batch send.`));
      return;
    }

    // 4. Fetch pending recipients
    const { data: recipients } = await supabase
      .from("automailsend_recipients")
      .select("*")
      .eq("user_id", user_id);

    const uniqueMap = new Map();
    for (const r of (recipients || [])) {
      if (!r.email) continue;
      // If target IDs are specified, ignore others
      if (config.batchTargetIds && Array.isArray(config.batchTargetIds) && config.batchTargetIds.length > 0) {
        if (!config.batchTargetIds.includes(r.id)) continue;
      }

      const key = r.email.toLowerCase();
      if (!sentEmails.has(key) && !uniqueMap.has(key)) {
        uniqueMap.set(key, r);
      }
    }

    let toProcess = Array.from(uniqueMap.values());

    // Apply quota limit
    toProcess = toProcess.slice(0, totalRemaining);

    if (toProcess.length === 0) {
      console.log(pc.green(`[BatchSend] No new emails to send for ${user_id} (or quota reached)`));
      return;
    }

    const delayMs = delaySec * 1000;
    const transporters = new Map();
    let appCreditsSkippedLogged = false;

    // 5. Send loop
    for (let i = 0; i < toProcess.length; i++) {
      // Check cancellation flag in DB
      const { data: checkState } = await supabase
        .from("automailsend_app_state")
        .select("batch_send_pending")
        .eq("user_id", user_id)
        .single();

      if (!checkState || !checkState.batch_send_pending) {
        console.log(pc.yellow(`[BatchSend] User ${user_id} cancelled the batch processing.`));
        break;
      }

      const account = pool
        .filter(a => a.remaining > 0)
        .sort((a, b) => b.remaining - a.remaining)[0];

      if (!account) {
        console.log(pc.yellow(`[BatchSend] User ${user_id} — all SMTP accounts exhausted mid-batch. Stopping.`));
        break;
      }

      const recipient = toProcess[i];

      // App credits (2026-08-31, MVP push) — checked before ANY template/AI/send work, same reasoning and
      // "log once, skip silently after, no status change, no sent_log row" policy as automail.worker.js.
      if (!(userState.app_credits > 0)) {
        if (!appCreditsSkippedLogged) {
          console.log(pc.yellow(`[BatchSend] User ${user_id} — out of app credits. Skipping remaining recipient(s) this batch.`));
          appCreditsSkippedLogged = true;
        }
        continue;
      }

      // 2026-08-20: role-mode-aware resolution replaces pickFromPool()'s randomization — three send
      // modes (manual / ai-select / ai-write). Same logic as automail.worker.js, see
      // docs/architecture.md's "Email Templates redesign" section and its follow-ups.
      const roleTemplates = templates[recipient.role] || [];
      const roleDef = roleDefByKey[recipient.role];
      const sendMode = roleDef?.email_send_mode || "manual";

      let tpl = null;
      if (sendMode === "manual") {
        tpl = roleTemplates.find((t) => t.id === roleDef?.selected_template_id) || null;
        if (!tpl) continue;
      } else if (sendMode === "ai-select") {
        if (roleTemplates.length === 0) continue;
        // ai_email_writing_enabled (2026-08-31, operator spec) -- the tier's ceiling on any AI-touched
        // email content, template selection included; ai_personalization_enabled stays the user's own
        // on/off preference and also gates AI job-match scoring elsewhere, unaffected by this.
        const aiWritingAllowed = userState.ai_personalization_enabled && userState.ai_email_writing_enabled !== false;
        if (aiWritingAllowed && userState.ai_credits > 0) {
          try {
            tpl = await chooseTemplateForJob(roleTemplates, recipient.role, recipient.context_text, userState.ai_temperature, user_id);
            if (tpl) {
              const spent = await spendAiCredit(supabase, user_id);
              userState.ai_credits = spent ? userState.ai_credits - 1 : 0;
            }
          } catch (err) {
            console.error(pc.red(`[BatchSend] AI template choice failed for ${recipient.email}: ${err.message}. Falling back to the first template.`));
          }
        } else if (aiWritingAllowed) {
          // 2026-08-31: was a silent fallback with zero log line — now visible, matching automail.worker.js.
          console.log(pc.yellow(`[BatchSend] Out of AI credits — falling back to the first template for ${recipient.email}.`));
        }
        if (!tpl) tpl = roleTemplates[0];
      }
      // ai-write needs no template at all — content is resolved from scratch below.

      // Attachments: one resume (this role's own resume_id override, else the candidate's
      // global_resume_id) — see resolveRoleAttachments() in lib/emailResolve.js.
      const roleFiles = resolveRoleAttachments(roleDef, candidateProfileRow).all;
      const resumeLabelForLog = describeFiles(roleFiles);

      let subject;
      let content;
      let templateLabelForLog;

      if (sendMode === "ai-write") {
        if (!userState.ai_personalization_enabled || userState.ai_email_writing_enabled === false || !(userState.ai_credits > 0)) {
          // 2026-08-31: was a bare continue with zero log line — now visible, matching automail.worker.js's
          // ai-write WARN. Deliberately no status change / no sent_log row — same admin-recoverable policy.
          console.log(pc.yellow(`[BatchSend] Out of AI credits — skipping AI-write for ${recipient.email}.`));
          continue;
        }
        let result;
        try {
          result = await generateAiPersonalizedEmail(userState.candidate_info, recipient, recipient.context_text, null, profile, userState.ai_temperature, user_id);
        } catch (err) {
          console.error(pc.red(`[BatchSend] AI write failed for ${recipient.email}: ${err.message}. Skipping.`));
          continue;
        }
        if (result && result.skip) {
          await supabase.from("automailsend_sent_log").insert({
            user_id, email: recipient.email.toLowerCase(), role: recipient.role, title: recipient.title,
            status: "skipped", error_message: result.reason || "AI determined this wasn't a relevant job opportunity.",
            sent_at: new Date().toISOString(),
          });
          await supabase.from("automailsend_recipients").update({ status: "failed" }).eq("user_id", user_id).eq("email", recipient.email);
          continue;
        }
        if (!result || !result.subject || !result.body) continue;
        const spent = await spendAiCredit(supabase, user_id);
        userState.ai_credits = spent ? userState.ai_credits - 1 : 0;
        subject = result.subject;
        content = result.body;
        templateLabelForLog = "AI-written (no template)";
      } else {
        if (!tpl.subject || !tpl.content) continue;
        // The template's own words, only variables filled in.
        subject = applyPlaceholders(tpl.subject, recipient, profile);
        content = applyPlaceholders(tpl.content, recipient, profile);
        templateLabelForLog = tpl.label;
      }

      // Safety-net pass: applied again even after AI, in case the model echoed a literal
      // {{title}}/{{name}}/{{email}} token from BASE TEMPLATE into its own output instead of
      // writing around it. A no-op when the token isn't present.
      subject = applyPlaceholders(subject, recipient, profile);
      content = applyPlaceholders(content, recipient, profile);

      // Hard guardrail: never send an email that still contains a literal unresolved {{...}} token
      // (e.g. a template used {{candidate_phone}} but the profile field is empty, or the AI echoed a
      // token verbatim). Blocked, not delivered — and no SMTP quota is spent, since we `continue`
      // before the send attempt below rather than entering the try/finally that decrements it.
      if (hasUnresolvedPlaceholders(subject) || hasUnresolvedPlaceholders(content)) {
        console.log(pc.red(`[BatchSend] Blocked send to ${recipient.email}: unresolved template variable(s) found in the final email.`));
        await supabase.from("automailsend_sent_log").insert({
          user_id, email: recipient.email.toLowerCase(), role: recipient.role, title: recipient.title,
          subject: subject, body: content, status: "failed",
          error_message: "Blocked: unresolved template variable(s) — email not sent.",
          sent_at: new Date().toISOString(),
          template_label: templateLabelForLog, resume_label: resumeLabelForLog,
        });
        await supabase.from("automailsend_recipients")
          .update({ status: "failed" })
          .eq("user_id", user_id)
          .eq("email", recipient.email);
        continue;
      }

      const fromEmail = account.fromEmail || account.email;
      const fromName = account.fromName;

      try {
        const isHtmlBlock = /<html|<body|<!DOCTYPE|<style|<div|<p|<table|<ul|<ol|<li|<h[1-6]|<br|<hr|<blockquote/i.test(content);

        let finalHtml = "";
        let finalText = "";

        if (isHtmlBlock) {
          finalHtml = content;
        } else {
          finalHtml = content.replace(/\n/g, "<br>");
        }

        const hasAnyTags = /<[a-z][\s\S]*>/i.test(content) || content.includes("<!DOCTYPE");
        if (hasAnyTags) {
          finalText = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                             .replace(/<br[^>]*>/gi, '\n')
                             .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n')
                             .replace(/<[^>]+>/g, '')
                             .replace(/\n\s*\n/g, '\n\n')
                             .trim();
        } else {
          finalText = content;
        }

        if (!transporters.has(account.id)) {
          transporters.set(account.id, buildTransporter(account, decryptPassword));
        }

        const info = await transporters.get(account.id).sendMail({
          from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
          to: recipient.email,
          subject,
          text: finalText,
          html: finalHtml,
          attachments: roleFiles.map(a => ({
            filename: a.name,
            path: a.url,
            contentType: a.type
          }))
        });

        // Log success
        await supabase.from("automailsend_sent_log").insert({
          user_id,
          email: recipient.email.toLowerCase(),
          role: recipient.role,
          title: recipient.title,
          subject: subject,
          body: content,
          status: "sent",
          sent_at: new Date().toISOString(),
          smtp_account_id: account.id,
          template_label: templateLabelForLog,
          resume_label: resumeLabelForLog,
          message_id: info && info.messageId ? info.messageId : null,
          send_stage: "initial",
        });

        // App credits (2026-08-31) — spent only after a successful send, alongside the follow-up
        // scheduling fields, same "spend after success only" rule as ai_credits.
        const spentApp = await spendAppCredit(supabase, user_id);
        userState.app_credits = spentApp ? userState.app_credits - 1 : 0;

        await supabase.from("automailsend_recipients")
          .update({
            status: "sent",
            last_sent_at: new Date().toISOString(),
            next_follow_up_at: computeNextFollowUpAt(roleDef),
          })
          .eq("user_id", user_id)
          .eq("email", recipient.email);

      } catch (error) {
        const errMessage = error instanceof Error ? error.message : "Send failed";
        // Log failure
        await supabase.from("automailsend_sent_log").insert({
          user_id,
          email: recipient.email.toLowerCase(),
          role: recipient.role,
          title: recipient.title,
          subject: subject,
          body: content,
          status: "failed",
          error_message: errMessage,
          sent_at: new Date().toISOString(),
          smtp_account_id: account.id,
          template_label: templateLabelForLog,
          resume_label: resumeLabelForLog,
        });

        await supabase.from("automailsend_recipients")
          .update({ status: "failed" })
          .eq("user_id", user_id)
          .eq("email", recipient.email);
      } finally {
        // Decrement on failure too — otherwise a persistently broken account keeps being picked
        // as "most remaining" for every subsequent recipient instead of rotating away from it.
        account.remaining -= 1;
      }

      if (i < toProcess.length - 1) {
        // Double check cancellation during delay
        let slept = 0;
        const interval = 1000;
        let cancelled = false;

        // Anti-ban Jitter: Randomize delay by +/- 20% to avoid exact, predictable intervals
        const jitter = Math.random() * 0.4 - 0.2;
        const actualDelayMs = delayMs > 0 ? delayMs * (1 + jitter) : 0;

        while (slept < actualDelayMs) {
          await sleep(interval);
          slept += interval;
          const { data: pollState } = await supabase.from("automailsend_app_state").select("batch_send_pending").eq("user_id", user_id).single();
          if (!pollState || !pollState.batch_send_pending) {
            cancelled = true;
            break;
          }
        }
        if (cancelled) {
          console.log(pc.yellow(`[BatchSend] User ${user_id} cancelled during delay.`));
          break;
        }
      }
    }

    console.log(pc.green(`[BatchSend Worker] Finished batch for ${user_id}`));
  } catch (error) {
    console.error(pc.red(`[BatchSend Worker] Error: ${error.message}`));
  } finally {
    // Release the flags
    await supabase
      .from("automailsend_app_state")
      .update({ batch_send_pending: false, batch_send_processing: false })
      .eq("user_id", user_id);
  }
}

module.exports = { processBatchSendJob };
