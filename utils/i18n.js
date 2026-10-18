// Server side of the UI language (see views/assets/i18n.js): the browser keeps the choice in a
// 'lang' cookie; messages the server sends are English and translated here with the same
// dictionary (views/assets/i18n/vi.js) and the same rules ({placeholder} keys match finished messages).
//   app.use(i18n)                  -> req.lang, req.__(text, params); JSON replies get their
//                                     `error` / `notices` translated on the way out
import '../views/assets/i18n/vi.js';
import '../views/assets/i18n.js';

const { LANGS, makeT } = globalThis.I18N_CORE;
const T = { en: makeT(null), vi: makeT(globalThis.I18N_VI) };

export const langOf = (req) => {
  const m = /(?:^|;\s*)lang=(\w+)/.exec(req.headers.cookie || '');
  return m && LANGS[m[1]] ? m[1] : 'en';
};

/** Translate the user-facing fields of a JSON reply. */
function translateBody(body, t) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out = { ...body };
  if (typeof out.error === 'string') out.error = t(out.error);
  if (Array.isArray(out.notices)) out.notices = out.notices.map(n => (typeof n === 'string' ? t(n) : n));
  return out;
}

export default function i18n(req, res, next) {
  req.lang = langOf(req);
  req.__ = T[req.lang];
  if (req.lang !== 'en') {
    const json = res.json.bind(res);
    res.json = (body) => json(translateBody(body, req.__));
  }
  next();
}
