// Used only by replyPoll.worker.js — mirrors smtpPool.js's shape, but resolves an IMAP connection
// config instead of a Nodemailer transporter. Reuses the same account credential (app_password) that
// already works for SMTP — Gmail/Outlook app passwords are protocol-agnostic — so no new secret to
// collect or encrypt for reply monitoring.

function resolveImapHost(account) {
  if (account.imap_host) return account.imap_host;
  if (account.email.includes("@outlook.com") || account.email.includes("@hotmail.com")) {
    return "outlook.office365.com";
  }
  // Default: Gmail (also the account.provider default) — matches smtpPool.js's own default host.
  return "imap.gmail.com";
}

function buildImapConfig(account, decryptPassword) {
  const host = resolveImapHost(account);
  const port = account.imap_port || 993;

  let passwordToUse = account.app_password || "";
  if (passwordToUse.startsWith("enc:")) {
    passwordToUse = decryptPassword(passwordToUse);
  }
  passwordToUse = passwordToUse.replace(/\s+/g, "");

  return {
    host,
    port,
    secure: true,
    auth: {
      user: account.email,
      pass: passwordToUse,
    },
    logger: false,
  };
}

module.exports = { buildImapConfig };
