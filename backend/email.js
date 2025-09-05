// backend/email.js
const nodemailer = require('nodemailer');

async function buildTransport() {
  // Try configured SMTP first
  if (process.env.SMTP_HOST) {
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = port === 465;
    const smtp = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      logger: true,  // keep while debugging
      debug: true,   // keep while debugging
    });
    try {
      await smtp.verify();
      console.log('[smtp] verify ok');
      return smtp;
    } catch (e) {
      console.error('[smtp] verify failed:', e.message);
      if (process.env.EMAIL_FALLBACK === 'ethereal' || process.env.NODE_ENV !== 'production') {
        console.log('[smtp] falling back to Ethereal (dev)');
      } else {
        // no fallback in prod unless explicitly enabled
        throw e;
      }
    }
  }

  // Fallback: Ethereal test account (prints preview URL)
  const test = await nodemailer.createTestAccount();
  const ethereal = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: { user: test.user, pass: test.pass },
  });
  console.log('[smtp] using Ethereal:', test.user);
  return ethereal;
}

let transporterPromise = buildTransport();

async function sendInviteEmail(to, link) {
  const transporter = await transporterPromise;
  const from = process.env.EMAIL_FROM || 'no-reply@example.com';

  const info = await transporter.sendMail({
    from, to,
    subject: 'Your Seller Disclosure Invite',
    html: `
      <p>Hello,</p>
      <p>You’ve been invited to complete the seller disclosure for your property.</p>
      <p><a href="${link}" style="background:#2563eb;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">
        Accept Invite
      </a></p>
      <p>Or paste this link in your browser:<br>${link}</p>
    `,
  });

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) console.log('[email preview]', previewUrl); // Ethereal only
  return { messageId: info.messageId, previewUrl };
}

module.exports = { sendInviteEmail };
