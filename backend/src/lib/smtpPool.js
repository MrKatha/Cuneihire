const nodemailer = require("nodemailer");

// Shared by automail.worker.js and batchSend.worker.js — loads a user's SMTP account pool (multi-mailbox
// pooling, added 2026-08-17 to replace the old single automailsend_app_state.config credential) and builds
// a Nodemailer transporter for a given account.

// Load a user's active + verified SMTP accounts, each annotated with `remaining` (daily_limit minus how
// many were actually sent today via that account) — computed from one grouped query against
// automailsend_sent_log rather than a separate count query per account.
async function loadAccountPool(supabase, userId, startOfDayIso) {
  const { data: accounts, error: acctErr } = await supabase
    .from("automailsend_smtp_accounts")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .eq("is_verified", true);

  if (acctErr || !accounts || accounts.length === 0) return [];

  const { data: sentRows } = await supabase
    .from("automailsend_sent_log")
    .select("smtp_account_id")
    .eq("user_id", userId)
    .eq("status", "sent")
    .gte("sent_at", startOfDayIso)
    .not("smtp_account_id", "is", null);

  const sentCounts = new Map();
  (sentRows || []).forEach((r) => {
    sentCounts.set(r.smtp_account_id, (sentCounts.get(r.smtp_account_id) || 0) + 1);
  });

  return accounts.map((a) => ({
    id: a.id,
    label: a.label || "",
    email: a.email,
    appPassword: a.app_password,
    host: a.host || "smtp.gmail.com",
    port: a.port || 465,
    fromEmail: a.from_email || "",
    fromName: a.from_name || "",
    dailyLimit: a.daily_limit || 50,
    remaining: (a.daily_limit || 50) - (sentCounts.get(a.id) || 0),
  }));
}

function buildTransporter(account, decryptPassword) {
  let host = account.host || "smtp.gmail.com";
  let port = account.port || 465;
  let secure = port === 465;
  if (account.email.includes("@outlook.com") || account.email.includes("@hotmail.com")) {
    host = "smtp-mail.outlook.com";
    port = 587;
    secure = false;
  }

  let passwordToUse = account.appPassword || "";
  if (passwordToUse.startsWith("enc:")) {
    passwordToUse = decryptPassword(passwordToUse);
  }
  passwordToUse = passwordToUse.replace(/\s+/g, "");

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: account.email,
      pass: passwordToUse,
    },
  });
}

module.exports = { loadAccountPool, buildTransporter };
