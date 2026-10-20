// /routes/suggestions-api.js
// Correction suggestions: a user of /roster thinks the AI model read their roster wrong and sends
// the file (POST /api/roster/suggestions, public, in routes/roster-api.js). Uploads are never kept
// otherwise, so this is the only way a roster from outside reaches the training data.
// Admins handle them on /helpdesk: Label it (the file joins the data, then /label?name=<file>&suggestion=<id>
// opens it with the rows the model read), Dismiss with a reason, the ticket's state, a reply by email
// (admin API, not in docs/openapi.json):
//   GET   /api/suggestions?status=pending|accepted|dismissed|all&ticket=open|in_progress|resolved|closed|all
//         list (newest first); status = what happened to the file, ticket = the helpdesk's state
//   GET   /api/suggestions/:id/file                                the file (CSV / Excel / TXT as an HTML table)
//   POST  /api/suggestions/:id/accept   add the file to the data (deduplicated) -> { name } to label
//   POST  /api/suggestions/:id/dismiss  { reason } not used: the file is deleted, the record kept, the ticket resolved
//   PATCH /api/suggestions/:id         { ticket?, adminNote? } the helpdesk's state and the admins' own note
//   POST  /api/suggestions/:id/reply   { subject, message, resolve? } email the sender (services/mailer.js);
//         no mail server: 501 with a mailto link, and { via: 'mailto' } records a reply sent that way
//   GET   /api/helpdesk/mail           { configured, from }: is a mail server set
// Stored by MinIO (suggestions/<id>/meta.json + file.<ext>, services/media-client.js).
// A suggestion from /acars has kind 'acars' and the fields the model read instead of rows; Label it puts its
// picture in the ACARS bucket (services/media-client.js acars) instead of the roster data.
import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

import { previewHtml } from '../services/table-text.js';
import { mailStatus, sendMail } from '../services/mailer.js';
import { ACARS_FIELDS } from '../services/acars.js';
import { extOf, kindOf } from '../utils/data-files.js';
import {
  listSuggestions, getSuggestion, putSuggestion, patchSuggestion, suggestionFile, deleteSuggestionFile,
  storeFile, mediaErrorStatus, acars,
} from '../services/media-client.js';

const ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const STATUSES = ['pending', 'accepted', 'dismissed'];
const TICKETS = ['open', 'in_progress', 'resolved', 'closed'];
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
/** The helpdesk state of a suggestion (records from before /helpdesk: from what happened to the file). */
export const ticketOf = (m) => m.ticket || { pending: 'open', accepted: 'in_progress', dismissed: 'closed' }[m.status] || 'open';
/** A requester's email as given (trimmed), '' when none; null when it is not an email address. */
export function cleanEmail(text) {
  const e = String(text || '').trim();
  if (!e) return '';
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', bmp: 'image/bmp', pdf: 'application/pdf' };

/** Rows sent with a suggestion: only the two tables, as arrays of plain objects. */
function cleanFields(fields) {
  if (!fields || typeof fields !== 'object') return null;
  return Object.fromEntries(ACARS_FIELDS.map(k => [k, String(fields[k] ?? '').slice(0, 100)]));
}
function cleanRows(rows) {
  if (!rows || typeof rows !== 'object') return null;
  const pick = (a) => (Array.isArray(a) ? a.filter(r => r && typeof r === 'object').slice(0, 2000) : []);
  return { published: pick(rows.published), planned: pick(rows.planned) };
}

/** Keep a suggestion: the multer temp file goes to MinIO with its meta. -> meta */
export async function createSuggestion(file, { note = '', rows = null, fields = null, acars = false, lang = 'en', email = '' } = {}) {
  const now = new Date();
  const stamp = now.toISOString().replace(/\D/g, '');
  const id = `${stamp.slice(0, 8)}-${stamp.slice(8, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const buf = fs.readFileSync(file.path);
  const meta = {
    id,
    createdAt: now.toISOString(),
    status: 'pending',
    fileName: path.basename(file.originalname),
    fileType: extOf(file.originalname),
    kind: acars ? 'acars' : kindOf(file.originalname),
    size: buf.length,
    md5: crypto.createHash('md5').update(buf).digest('hex'),
    note,
    email,
    lang,
    ticket: 'open',
    replies: [],
    ...(acars ? { fields: cleanFields(fields) } : { rows: cleanRows(rows) }),
  };
  await putSuggestion(meta, buf);
  return meta;
}

const router = Router();
const fail = (res, e) => {
  const status = mediaErrorStatus(e);
  if (status >= 500 && e?.code !== 'MEDIA_DOWN') console.error('[suggestions]', e);
  res.status(status).json({ error: e.message });
};

// One suggestion by :id (404 when unknown)
router.param('id', async (req, res, next, id) => {
  try {
    const meta = ID_RE.test(id) ? await getSuggestion(id) : null;
    if (!meta) return res.status(404).json({ error: 'Suggestion not found' });
    req.suggestion = meta;
    next();
  } catch (e) { fail(res, e); }
});

router.get('/suggestions', async (req, res) => {
  const status = String(req.query.status || (req.query.ticket ? 'all' : 'pending'));
  const ticket = String(req.query.ticket || 'all');
  if (status !== 'all' && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${[...STATUSES, 'all'].join(', ')}` });
  if (ticket !== 'all' && !TICKETS.includes(ticket)) return res.status(400).json({ error: `ticket must be one of: ${[...TICKETS, 'all'].join(', ')}` });
  try {
    const all = await listSuggestions();
    const counts = Object.fromEntries(STATUSES.map(s => [s, all.filter(x => x.status === s).length]));
    const tickets = Object.fromEntries(TICKETS.map(t => [t, all.filter(x => ticketOf(x) === t).length]));
    const items = all.filter(x => (status === 'all' || x.status === status) && (ticket === 'all' || ticketOf(x) === ticket)).map(({ rows, fields, ...m }) => ({
      ...m, ticket: ticketOf(m), replies: m.replies || [], rowCount: rows ? rows.published.length + rows.planned.length : null,
      ...(fields ? { fieldCount: Object.values(fields).filter(Boolean).length } : {}),
    }));
    res.json({ items, counts, tickets });
  } catch (e) { fail(res, e); }
});

router.get('/helpdesk/mail', (req, res) => res.json(mailStatus()));

router.get('/suggestions/:id', (req, res) => res.json(req.suggestion));

router.get('/suggestions/:id/file', async (req, res) => {
  const meta = req.suggestion;
  try {
    const buf = await suggestionFile(meta.id);
    if (!buf) return res.status(410).json({ error: 'The file of this suggestion was removed' });
    if (MIME[meta.fileType]) return res.type(MIME[meta.fileType]).send(buf);
    // CSV / Excel / TXT: shown as a table or as text (the readers need a file with its extension)
    const tmp = path.join(os.tmpdir(), `roster-suggestion-${crypto.randomUUID()}.${meta.fileType}`);
    fs.writeFileSync(tmp, buf);
    try { res.type('html').send(previewHtml(tmp)); } finally { fs.rm(tmp, { force: true }, () => {}); }
  } catch (e) { fail(res, e); }
});

router.post('/suggestions/:id/accept', async (req, res) => {
  const meta = req.suggestion;
  if (meta.status !== 'pending') return res.status(409).json({ error: `This suggestion is already ${meta.status}` });
  try {
    const buf = await suggestionFile(meta.id);
    if (!buf) return res.status(410).json({ error: 'The file of this suggestion was removed' });
    const { name, isNew } = meta.kind === 'acars' ? await acars.storeFile(buf, meta.fileName) : await storeFile(buf, meta.fileName);
    await patchSuggestion(meta.id, { status: 'accepted', handledAt: new Date().toISOString(), dataName: name, alreadyInData: !isNew,
      ...(ticketOf(meta) === 'open' ? { ticket: 'in_progress' } : {}) });
    await deleteSuggestionFile(meta.id); // the roster now is in the data
    res.json({ ok: true, name, isNew });
  } catch (e) { fail(res, e); }
});

router.post('/suggestions/:id/dismiss', async (req, res) => {
  const meta = req.suggestion;
  if (meta.status !== 'pending') return res.status(409).json({ error: `This suggestion is already ${meta.status}` });
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Write why it is dismissed' });
  if (reason.length > 2000) return res.status(400).json({ error: 'The reason is longer than 2000 characters' });
  try {
    await deleteSuggestionFile(meta.id); // not kept: it is someone's roster
    const at = new Date().toISOString();
    await patchSuggestion(meta.id, { status: 'dismissed', handledAt: at, rows: null, fields: null, dismissReason: reason, ticket: 'resolved', ticketAt: at });
    res.json({ ok: true, ticket: 'resolved' });
  } catch (e) { fail(res, e); }
});

// The helpdesk's state of a suggestion and the admins' own note on it
router.patch('/suggestions/:id', async (req, res) => {
  const body = req.body || {};
  const part = {};
  if (body.ticket !== undefined) {
    if (!TICKETS.includes(body.ticket)) return res.status(400).json({ error: `ticket must be one of: ${TICKETS.join(', ')}` });
    part.ticket = body.ticket;
    part.ticketAt = new Date().toISOString();
  }
  if (body.adminNote !== undefined) {
    const note = String(body.adminNote || '').trim();
    if (note.length > 4000) return res.status(400).json({ error: 'The note is longer than 4000 characters' });
    part.adminNote = note;
  }
  if (!Object.keys(part).length) return res.status(400).json({ error: 'Nothing to change: send ticket and / or adminNote' });
  try {
    const meta = await patchSuggestion(req.suggestion.id, part);
    res.json({ ok: true, ticket: ticketOf(meta), adminNote: meta.adminNote || '' });
  } catch (e) { fail(res, e); }
});

/**
 * Email the sender of a suggestion. { subject, message, resolve?: true (ticket -> resolved), via?: 'mailto' }
 * via 'mailto': the admin sent it from their own mail program (no mail server here): only recorded.
 */
router.post('/suggestions/:id/reply', async (req, res) => {
  const meta = req.suggestion;
  const body = req.body || {};
  const to = cleanEmail(body.to || meta.email);
  if (!to) return res.status(400).json({ error: 'This suggestion has no email address to reply to' });
  const subject = String(body.subject || '').trim().slice(0, 300);
  const message = String(body.message || '').trim();
  if (!subject || !message) return res.status(400).json({ error: 'Write a subject and a message' });
  if (message.length > 10000) return res.status(400).json({ error: 'The message is longer than 10000 characters' });
  const reply = { at: new Date().toISOString(), to, subject, message, via: body.via === 'mailto' ? 'mailto' : 'smtp' };
  try {
    if (reply.via === 'smtp') {
      try {
        reply.messageId = (await sendMail({ to, subject, text: message })).messageId;
      } catch (e) {
        const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
        if (e.status === 501) return res.status(501).json({ error: e.message, mailto });
        return res.status(502).json({ error: `The mail server did not send it: ${e.message}`, mailto });
      }
    }
    const part = { replies: [...(meta.replies || []), reply], lastReplyAt: reply.at };
    if (body.resolve) { part.ticket = 'resolved'; part.ticketAt = reply.at; }
    const saved = await patchSuggestion(meta.id, part);
    res.json({ ok: true, via: reply.via, ticket: ticketOf(saved), replies: saved.replies });
  } catch (e) { fail(res, e); }
});

export default router;
