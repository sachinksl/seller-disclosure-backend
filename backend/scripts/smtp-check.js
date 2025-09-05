// scripts/smtp-check.js
require('dotenv').config();
const nodemailer = require('nodemailer');

(async () => {
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = port === 465;
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: true,
    debug: true,
  });
  try {
    const ok = await t.verify();
    console.log('[smtp] verify ok:', ok);
  } catch (e) {
    console.error('[smtp] verify failed:', e.message);
  }
  process.exit(0);
})();
