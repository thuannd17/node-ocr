/**
 * Emails the app sends (the /helpdesk "Reply" to whoever sent a correction suggestion), through an SMTP
 * server set in .env. Without one, /helpdesk opens the admin's own mail program instead (mailto:).
 *
 *   SMTP_HOST=smtp.example.com  SMTP_PORT=587  SMTP_SECURE=false  SMTP_USER=...  SMTP_PASS=...
 *   MAIL_FROM="RosterParser <helpdesk@example.com>"  MAIL_REPLY_TO=helpdesk@example.com (optional)
 *
 *   mailStatus() -> { configured, from }       (never the password)
 *   sendMail({ to, subject, text }) -> { messageId }   throws when not configured or the server refuses
 */
import nodemailer from 'nodemailer';

const env = () => ({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: ['true', '1'].includes(String(process.env.SMTP_SECURE || '').toLowerCase()),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || '',
  replyTo: process.env.MAIL_REPLY_TO || '',
});

export function mailStatus() {
  const c = env();
  return { configured: !!(c.host && c.from), from: c.from || null };
}

let transport = null, transportKey = '';
export async function sendMail({ to, subject, text }) {
  const c = env();
  if (!c.host || !c.from) throw Object.assign(new Error('No mail server set (SMTP_HOST, MAIL_FROM in .env)'), { status: 501 });
  const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.pass]);
  if (!transport || key !== transportKey) {
    transport = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, ...(c.user ? { auth: { user: c.user, pass: c.pass } } : {}) });
    transportKey = key;
  }
  const info = await transport.sendMail({ from: c.from, to, subject, text, ...(c.replyTo ? { replyTo: c.replyTo } : {}) });
  return { messageId: info.messageId };
}
