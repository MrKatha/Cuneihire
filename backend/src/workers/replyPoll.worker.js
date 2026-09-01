const pc = require("picocolors");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { decryptPassword } = require("../lib/crypto");
const { ExecutionLogger } = require("../lib/logger");
const { buildImapConfig } = require("../lib/imapPool");

// Tier 3 — reply monitoring (2026-08-19). Polls each user's IMAP-enabled real mailbox (opt-in per
// account, see automailsend_smtp_accounts.imap_enabled) for inbound mail, matches it back to a
// previously-sent outreach email, and records only the matches — never the whole inbox — into
// automailsend_replies. See docs/architecture.md's "Reply monitoring" section for the full design.

const INITIAL_LOOKBACK_DAYS = 14; // first-ever poll for an account: don't scan a whole mailbox history
const OVERLAP_BUFFER_DAYS = 2; // re-scan a small buffer each poll so nothing slips through a missed tick
const SNIPPET_MAX_CHARS = 1000;
const SENT_LOG_LOOKBACK_DAYS = 90; // how far back to look for a sent email a reply could be answering

function stripSubjectPrefix(subject) {
  return (subject || "").replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, "").trim().toLowerCase();
}

function normalizeId(id) {
  return (id || "").trim();
}

function computeSinceDate(lastPolledAt) {
  const now = Date.now();
  if (!lastPolledAt) {
    return new Date(now - INITIAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  }
  return new Date(new Date(lastPolledAt).getTime() - OVERLAP_BUFFER_DAYS * 24 * 60 * 60 * 1000);
}

// Which previously-sent email (if any) this inbound message is answering. Header match first
// (authoritative — In-Reply-To/References against a message_id captured at send time), then a
// sender+subject fallback for clients that mangle threading headers. No match -> null, and the caller
// must not store the message (automailsend_replies only ever holds attributable replies).
function matchReply(parsed, sentByMessageId, sentByEmail) {
  const inReplyTo = normalizeId(parsed.inReplyTo);
  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
    ? [parsed.references]
    : [];

  if (inReplyTo && sentByMessageId.has(inReplyTo)) {
    return { sentLog: sentByMessageId.get(inReplyTo), matchMethod: "header" };
  }
  for (const ref of references) {
    const normalized = normalizeId(ref);
    if (normalized && sentByMessageId.has(normalized)) {
      return { sentLog: sentByMessageId.get(normalized), matchMethod: "header" };
    }
  }

  const fromEmail = ((parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || "").toLowerCase();
  if (!fromEmail) return null;
  const candidates = sentByEmail.get(fromEmail);
  if (!candidates || candidates.length === 0) return null;

  const strippedInbound = stripSubjectPrefix(parsed.subject);
  const subjectMatch = candidates.find((row) => {
    const strippedSent = stripSubjectPrefix(row.subject);
    return (
      strippedSent &&
      strippedInbound &&
      (strippedInbound === strippedSent || strippedInbound.includes(strippedSent) || strippedSent.includes(strippedInbound))
    );
  });
  if (subjectMatch) return { sentLog: subjectMatch, matchMethod: "sender_subject" };

  return null;
}

async function pollAccount(supabase, account, logger) {
  const userId = account.user_id;
  const config = buildImapConfig(account, decryptPassword);
  const since = computeSinceDate(account.imap_last_polled_at);

  const { data: sentRows } = await supabase
    .from("automailsend_sent_log")
    .select("id, email, subject, message_id, role, sent_at")
    .eq("user_id", userId)
    .eq("status", "sent")
    .gte("sent_at", new Date(Date.now() - SENT_LOG_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString())
    .order("sent_at", { ascending: false });

  const sentByMessageId = new Map();
  const sentByEmail = new Map();
  for (const row of sentRows || []) {
    if (row.message_id) sentByMessageId.set(normalizeId(row.message_id), row);
    const key = (row.email || "").toLowerCase();
    if (!key) continue;
    if (!sentByEmail.has(key)) sentByEmail.set(key, []);
    sentByEmail.get(key).push(row);
  }

  // Already-recorded replies for this account — avoids reprocessing work inside the overlap window on
  // every poll. The DB's unique(user_id, message_id) constraint is the real backstop.
  const { data: existingReplies } = await supabase
    .from("automailsend_replies")
    .select("message_id")
    .eq("user_id", userId)
    .eq("smtp_account_id", account.id);
  const knownMessageIds = new Set((existingReplies || []).map((r) => normalizeId(r.message_id)));

  const client = new ImapFlow(config);
  let newReplies = 0;
  let scanned = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ since }, { uid: true });
      if (uids && uids.length > 0) {
        for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
          scanned++;
          let parsed;
          try {
            parsed = await simpleParser(msg.source);
          } catch (parseErr) {
            await logger.append("WARN", `Could not parse a message in ${account.email}'s inbox: ${parseErr.message}`);
            continue;
          }

          const messageId = normalizeId(parsed.messageId);
          if (!messageId || knownMessageIds.has(messageId)) continue;

          const fromEmail = ((parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || "").toLowerCase();
          if (fromEmail && fromEmail === account.email.toLowerCase()) continue; // ignore self-sent copies

          const matched = matchReply(parsed, sentByMessageId, sentByEmail);
          if (!matched) continue;

          const sentLogRow = matched.sentLog;

          const { data: recipientRow } = await supabase
            .from("automailsend_recipients")
            .select("id, reply_count")
            .eq("user_id", userId)
            .eq("email", sentLogRow.email)
            .eq("role", sentLogRow.role)
            .maybeSingle();

          const { error: insertErr } = await supabase.from("automailsend_replies").insert({
            user_id: userId,
            smtp_account_id: account.id,
            recipient_id: recipientRow ? recipientRow.id : null,
            sent_log_id: sentLogRow.id,
            from_email: fromEmail,
            subject: parsed.subject || null,
            body_snippet: (parsed.text || "").slice(0, SNIPPET_MAX_CHARS) || null,
            message_id: messageId,
            in_reply_to: normalizeId(parsed.inReplyTo) || null,
            match_method: matched.matchMethod,
            received_at: parsed.date ? parsed.date.toISOString() : null,
          });

          if (insertErr) {
            // Unique violation = already recorded (e.g. a previous poll's overlap window) — expected
            // and fine to ignore. Anything else is worth surfacing.
            if (insertErr.code !== "23505") {
              await logger.append("WARN", `Failed to save a matched reply from ${fromEmail}: ${insertErr.message}`);
            }
            continue;
          }

          knownMessageIds.add(messageId);
          newReplies++;

          if (recipientRow) {
            await supabase
              .from("automailsend_recipients")
              .update({
                has_replied: true,
                replied_at: new Date().toISOString(),
                reply_count: (recipientRow.reply_count || 0) + 1,
              })
              .eq("id", recipientRow.id);
          }

          await logger.append("SUCCESS", `Reply found from ${fromEmail} (matched via ${matched.matchMethod}).`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  await supabase
    .from("automailsend_smtp_accounts")
    .update({ imap_last_polled_at: new Date().toISOString() })
    .eq("id", account.id);

  return { scanned, newReplies };
}

async function processReplyPollJob(supabase) {
  const { data: accounts, error: acctErr } = await supabase
    .from("automailsend_smtp_accounts")
    .select("*")
    .eq("imap_enabled", true)
    .eq("is_active", true);

  if (acctErr) {
    console.error(pc.red(`[ReplyPoll] Error fetching IMAP-enabled accounts: ${acctErr.message}`));
    return;
  }
  if (!accounts || accounts.length === 0) return;

  const userIds = [...new Set(accounts.map((a) => a.user_id))];
  const { data: userStates } = await supabase
    .from("automailsend_app_state")
    .select("user_id, is_blocked, reply_monitoring_enabled")
    .in("user_id", userIds);
  const blockedUsers = new Set((userStates || []).filter((u) => u.is_blocked).map((u) => u.user_id));
  // Tier gate (2026-08-31, operator spec: Starter has no reply monitoring, Pro/Elite do) — an account can
  // still have imap_enabled=true on its own SMTP config (that toggle isn't hidden retroactively if a
  // downgrade happens), so this is enforced here too, not just in the Settings UI.
  const noReplyMonitoringUsers = new Set((userStates || []).filter((u) => u.reply_monitoring_enabled === false).map((u) => u.user_id));

  for (const account of accounts) {
    if (blockedUsers.has(account.user_id)) continue;
    if (noReplyMonitoringUsers.has(account.user_id)) continue;

    const logger = new ExecutionLogger(account.user_id, "reply_poll");
    await logger.start(`Checking ${account.label || account.email} for replies...`);
    try {
      const { scanned, newReplies } = await pollAccount(supabase, account, logger);
      await logger.finish(
        "success",
        newReplies > 0
          ? `Found ${newReplies} new repl${newReplies === 1 ? "y" : "ies"} (scanned ${scanned} message(s)).`
          : `No new replies (scanned ${scanned} message(s)).`
      );
    } catch (err) {
      console.error(pc.red(`[ReplyPoll] Error polling ${account.email}: ${err.message}`));
      await logger.finish("error", `Could not check for replies: ${err.message}`);
    }
  }
}

module.exports = { processReplyPollJob, matchReply, stripSubjectPrefix, computeSinceDate };
