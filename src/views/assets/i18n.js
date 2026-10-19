// UI language: English (default) or Vietnamese. English text is written in the pages and the code;
// the Vietnamese for it lives in /assets/i18n/vi.js (English text -> Vietnamese), loaded before this file:
//   <script src="/assets/i18n/vi.js"></script><script src="/assets/i18n.js"></script>
//
// __('Open .ics file')               -> the text in the current language (also t(); `t`/`tr` are local names in some pages)
// __('{n} events', { n: 3 })         -> placeholders {name} filled in (after translating)
// __(messageFromServer)              -> a key with placeholders also matches a finished message:
//                                       'Airport "{code}" not found' translates 'Airport "XYZ" not found'
// Static HTML is translated on load, nothing to mark:
//   - an element's text that is exactly a key ("Save" in <button><i ...></i> Save</button>)
//   - title / placeholder / aria-label attributes that are exactly a key
//   - data-i18n on an element: its whole innerHTML is the key (sentences with <b>, <code>, links)
// The choice is kept in localStorage + a 'lang' cookie (the server words its messages by it, utils/i18n.js);
// switching reloads the page. The topnav (nav.js) shows the switch.
(function (root) {
  const LANGS = { en: 'English', vi: 'Tiếng Việt' };
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const fill = (text, params) => (params ? String(text).replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m)) : text);

  /** A translate function over one dictionary (null: English, text unchanged). Shared with the server. */
  function makeT(dict) {
    let patterns = null; // keys with {placeholders}, as regexps, built on first use
    const patternsOf = () => patterns || (patterns = Object.keys(dict).filter(k => /\{\w+\}/.test(k)).map((k) => {
      const names = [];
      const re = k.split(/(\{\w+\})/).map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (m) { names.push(m[1]); return '(.+?)'; }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      return { re: new RegExp(`^${re}$`, 's'), names, text: dict[k] };
    }));
    return function t(text, params) {
      if (text == null) return text;
      if (!dict) return fill(text, params);
      const key = norm(text);
      const hit = dict[key];
      if (hit != null) return fill(hit, params);
      if (params || !/\S/.test(key)) return fill(text, params);
      for (const p of patternsOf()) {
        const m = p.re.exec(key);
        if (!m) continue;
        const values = Object.fromEntries(p.names.map((n, i) => [n, dict[norm(m[i + 1])] ?? m[i + 1]]));
        return fill(p.text, values);
      }
      return text;
    };
  }

  root.I18N_CORE = { LANGS, makeT, norm };
  if (typeof document === 'undefined') return; // on the server: utils/i18n.js uses makeT only

  function readLang() {
    try { const v = localStorage.getItem('lang'); if (LANGS[v]) return v; } catch { /* storage blocked */ }
    const m = /(?:^|;\s*)lang=(\w+)/.exec(document.cookie);
    return m && LANGS[m[1]] ? m[1] : 'en';
  }
  const lang = readLang();
  document.documentElement.lang = lang;
  // Keep the cookie in step with localStorage, so the server answers in the same language.
  document.cookie = `lang=${lang}; path=/; max-age=31536000; SameSite=Lax`;
  const dict = lang === 'vi' ? root.I18N_VI || {} : null;
  const t = makeT(dict);

  function setLang(next) {
    if (!LANGS[next] || next === lang) return;
    try { localStorage.setItem('lang', next); } catch { /* storage blocked */ }
    document.cookie = `lang=${next}; path=/; max-age=31536000; SameSite=Lax`;
    location.reload();
  }

  const ATTRS = ['title', 'placeholder', 'aria-label'];
  /** Translate the static text under `node` (the whole page on load): exact keys only. */
  function apply(node = document.body) {
    if (!dict || !node) return;
    for (const el of node.querySelectorAll('[data-i18n]')) {
      const hit = dict[norm(el.innerHTML)];
      if (hit) el.innerHTML = hit;
    }
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest('script, style, textarea, code, pre, [data-no-i18n]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const n of texts) {
      const key = norm(n.nodeValue);
      if (key && dict[key]) n.nodeValue = n.nodeValue.replace(/\S[\s\S]*\S|\S/, () => dict[key]);
    }
    for (const el of node.querySelectorAll(ATTRS.map(a => `[${a}]`).join(','))) {
      for (const a of ATTRS) { const v = el.getAttribute(a); if (v && dict[norm(v)]) el.setAttribute(a, dict[norm(v)]); }
    }
    const title = dict[norm(document.title)];
    if (title) document.title = title;
  }

  root.I18N = { lang, langs: LANGS, t, setLang, apply };
  root.t = t;
  root.__ = t;
  // Static page text: once the HTML is parsed (the page's own scripts already use __()).
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => apply(), { once: true });
  else apply();
})(typeof window !== 'undefined' ? window : globalThis);
