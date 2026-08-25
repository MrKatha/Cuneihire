# Cuneihire

Next.js app to send bulk emails with Nodemailer. Recipients can be tagged by a user-defined role, each with its own subject, body, and attachments. Supports per-email delay and JSON email extraction.

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Gmail App Password

1. Enable 2-Step Verification on your Google account.
2. Create an [App Password](https://myaccount.google.com/apppasswords).
3. Paste your Gmail address and that app password into **SMTP Config**, then click **Config / Verify**.

## Usage

1. **SMTP Config** — email + app password → verify.
2. **Recipients** — add emails one by one (with a role), or paste JSON/text and extract emails.
3. **Role Templates** — for each role in use, set subject, content, and attachments.
4. **Send** — set delay (seconds) between emails, then send to all.

### JSON examples

```json
["a@x.com", "b@y.com"]
```

```json
[{"email":"a@x.com"},{"email":"b@y.com"}]
```

Plain text with emails also works — addresses are auto-extracted.
