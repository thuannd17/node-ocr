// Shared navigation. Include as the first element of <body>:
//   <script src="/assets/nav.js"></script>
// It renders synchronously in place, so there is no layout flash.
// Needs /assets/i18n.js (in <head>) for the language switch and the labels.
//
// Two modes, by the page:
//   public pages  a top bar with the public tools in a row; admins see "Switch to Administrator" on the right
//   admin pages   the top bar keeps the brand, "Back to site", the account and the language; the admin pages are a
//                 vertical sidebar on the left (it folds to icons: the button at its foot, kept per browser)
// #navMenu is the menu of the mode: the row of public links, or the admin sidebar. On a phone (and a tablet for
// the public row) it slides in from the left under ☰, with the mode switch inside it.
// The switch goes back to the page last seen in the other mode (sessionStorage). routes/auth-api.js guards the
// admin pages themselves; the switch is only shown to admins.
// Admins also get a status bar under the top bar on every page: the training and benchmark runs the server is doing
// (GET /api/jobs, routes/jobs-api.js), each with its progress and a link to its page; a finished one shows a little while.
(function () {
  const t = window.t || ((s) => s);
  const PUBLIC = [
    { href: '/', icon: 'fa-house', label: 'Home' },
    { href: '/roster', icon: 'fa-file-lines', label: 'Roster' },
    { href: '/acars', icon: 'fa-satellite-dish', label: 'ACARS' },
    { href: '/calendar', icon: 'fa-calendar-days', label: 'Calendar' },
    { href: '/airport', icon: 'fa-plane-departure', label: 'Airport' },
    { href: '/night-time', icon: 'fa-moon', label: 'Night Time' },
    { href: '/api-docs', icon: 'fa-book', label: 'API Docs' },
    { href: '/pricing', icon: 'fa-tags', label: 'Pricing' },
  ];
  const ADMIN = [
    { href: '/dashboard', icon: 'fa-gauge-high', label: 'Dashboard' },
    { href: '/label', icon: 'fa-tags', label: 'Label' },
    { href: '/benchmark', icon: 'fa-chart-column', label: 'Benchmark' },
    { href: '/models', icon: 'fa-brain', label: 'AI Models' },
    { href: '/helpdesk', icon: 'fa-headset', label: 'Helpdesk' },
    { href: '/users', icon: 'fa-users', label: 'Users' },
    { href: '/billing', icon: 'fa-file-invoice-dollar', label: 'Billing' },
  ];
  const here = location.pathname.replace(/\/+$/, '') || '/';
  const inAdmin = ADMIN.some(i => i.href === here);
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
    getLocal: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    setLocal: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  // where the switch leads: the page last seen in the other mode
  if (!['/login', '/signup'].includes(here)) store.set(inAdmin ? 'nav.lastAdmin' : 'nav.lastPublic', location.pathname + location.search);
  const target = inAdmin ? store.get('nav.lastPublic') || '/' : store.get('nav.lastAdmin') || '/dashboard';

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const link = (i) => `<a href="${i.href}" title="${t(i.label)}"${i.href === here ? ' class="active" aria-current="page"' : ''}><i class="fa-solid ${i.icon}" aria-hidden="true"></i> <span>${t(i.label)}</span></a>`;
  const switchText = inAdmin ? t('Back to site') : t('Switch to Administrator');
  const switchBtn = (where) => `<a class="mode-switch ${where}" href="${esc(target)}"${inAdmin ? '' : ' hidden'} title="${switchText}">`
    + `<i class="fa-solid ${inAdmin ? 'fa-arrow-left' : 'fa-user-shield'}" aria-hidden="true"></i> <span>${switchText}</span></a>`;
  const signIn = `<a class="account-link" href="/login${here === '/' || here === '/login' || here === '/signup' ? '' : `?next=${encodeURIComponent(location.pathname + location.search)}`}"><i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i> <span>${t('Sign in')}</span></a>`;
  const i18n = window.I18N;
  const langs = i18n
    ? `<div class="lang" role="group" aria-label="Language">${Object.entries(i18n.langs).map(([code, name]) =>
      `<button type="button" data-lang="${code}" title="${name}"${code === i18n.lang ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>${code.toUpperCase()}</button>`).join('')}</div>`
    : '';

  const menu = inAdmin
    ? `<aside class="sidenav" id="navMenu" aria-label="${t('Administration')}" data-no-i18n>
        <div class="side-title"><i class="fa-solid fa-user-gear" aria-hidden="true"></i> <span>${t('Administration')}</span></div>
        <nav class="side-links">${ADMIN.map(link).join('')}</nav>
        <div class="side-foot">${switchBtn('in-menu')}
          <button type="button" class="side-fold" title="${t('Fold the menu')}" aria-label="${t('Fold the menu')}"><i class="fa-solid fa-angles-left" aria-hidden="true"></i> <span>${t('Fold the menu')}</span></button></div>
      </aside>`
    : `<div class="menu" id="navMenu">${PUBLIC.map(link).join('')}<div class="menu-foot">${switchBtn('in-menu')}</div></div>`;

  if (inAdmin) {
    document.body.classList.add('has-sidenav');
    if (store.getLocal('nav.folded') === '1') document.body.classList.add('side-folded');
  }
  document.currentScript.insertAdjacentHTML(
    'beforebegin',
    `<nav class="topnav${inAdmin ? ' admin-mode' : ''}" data-no-i18n>`
    + `<button type="button" class="nav-toggle" aria-expanded="false" aria-controls="navMenu" title="${t('Menu')}" aria-label="${t('Menu')}"><i class="fa-solid fa-bars" aria-hidden="true"></i></button>`
    + `<a class="brand" href="/"><span class="logo" aria-hidden="true"><i class="fa-solid fa-plane"></i></span> <span class="name">RosterParser</span>${inAdmin ? ` <span class="mode-tag">${t('Admin')}</span>` : ''}</a>`
    + (inAdmin ? '' : menu)
    + `<div class="nav-right">${switchBtn('in-bar')}${signIn}${langs}</div></nav>`
    + (inAdmin ? menu : '')
    + '<div class="nav-backdrop" hidden></div>'
    + '<div class="jobbar" id="jobBar" role="status" aria-live="polite" data-no-i18n hidden></div>',
  );

  const nav = document.querySelector('.topnav');
  const panel = document.getElementById('navMenu');
  const backdrop = document.querySelector('.nav-backdrop');
  nav.querySelector('.lang')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) i18n.setLang(b.dataset.lang);
  });

  // ☰: the menu of the mode slides in (phones; tablets for the public row); a click outside, a link or Esc closes it
  const toggle = nav.querySelector('.nav-toggle');
  const setOpen = (open) => {
    document.body.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    backdrop.hidden = !open;
  };
  toggle.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!document.body.classList.contains('nav-open')); });
  backdrop.addEventListener('click', () => setOpen(false));
  panel.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) { setOpen(false); toggle.focus(); } });

  // the admin sidebar folds to icons (wide screens; tablets always show the icons)
  panel.querySelector('.side-fold')?.addEventListener('click', () => {
    const folded = document.body.classList.toggle('side-folded');
    store.setLocal('nav.folded', folded ? '1' : '0');
  });

  // Who is signed in: the account link (Sign in / the account's name); the mode switch for admins only
  const accountLink = nav.querySelector('.account-link');
  fetch('/api/auth/me').then(r => r.json()).then((me) => {
    if (me.user) {
      accountLink.href = '/account';
      accountLink.title = me.user.email;
      accountLink.innerHTML = `<i class="fa-solid fa-circle-user" aria-hidden="true"></i> <span>${esc(me.user.name || me.user.email)}</span>`;
      if (here === '/account') accountLink.classList.add('active');
    } else if (!me.enabled) {
      accountLink.hidden = true; // login not set up
    }
    const admin = me.user?.role === 'admin' || me.local;
    document.querySelectorAll('.mode-switch').forEach((a) => { a.hidden = !admin && !inAdmin; });
    if (admin) watchJobs();
  }).catch(() => {});

  // ---- The status bar: runs going on (or just finished) on the server ----
  const bar = document.getElementById('jobBar');
  const DISMISSED = 'nav.jobsDismissed';
  const dismissed = new Set(JSON.parse(store.get(DISMISSED) || '[]'));
  const ICON = { training: 'fa-graduation-cap', benchmark: 'fa-chart-column' };
  let pollTimer = null;
  // a Stop asks once more on the button itself (no browser dialog): the second click within 4 s stops; kept across redraws
  const armed = new Map(); // job id -> until (ms)
  const TYPE = { training: 'Training', benchmark: 'Benchmark' };
  function renderJobs(jobs) {
    const shown = jobs.filter(j => j.running || !dismissed.has(`${j.id}@${j.finishedAt}`));
    bar.hidden = !shown.length;
    document.body.classList.toggle('has-jobbar', !!shown.length);
    bar.innerHTML = shown.map((j) => {
      const pct = j.fraction != null ? Math.round(100 * j.fraction) : null;
      const state = j.running
        ? (j.stopping ? `<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${t('Stopping…')}` : `<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${t('Running')}`)
        : j.stopped ? `<i class="fa-solid fa-circle-stop" aria-hidden="true"></i> ${t('Stopped')}`
          : j.ok ? `<i class="fa-solid fa-circle-check jb-ok" aria-hidden="true"></i> ${t('Done')}` : `<i class="fa-solid fa-circle-xmark jb-bad" aria-hidden="true"></i> ${t('Failed')}`;
      const isArmed = (armed.get(j.id) || 0) > Date.now();
      const stop = j.stop
        ? `<button type="button" class="jb-stop${isArmed ? ' jb-armed' : ''}" data-stop="${esc(j.stop)}" data-id="${esc(j.id)}" title="${esc(t('Stop this run'))}">`
          + `<i class="fa-solid fa-stop" aria-hidden="true"></i> <span>${isArmed ? t('Stop it?') : t('Stop')}</span></button>`
        : '';
      return `<div class="jb-job jb-${j.type} jb-${j.running ? 'running' : j.stopped ? 'stopped' : j.ok ? 'done' : 'failed'}">
        <span class="jb-kind"><i class="fa-solid ${ICON[j.type] || 'fa-gear'}" aria-hidden="true"></i> ${t(TYPE[j.type] || j.type)}</span>
        <a href="${esc(j.href)}" title="${esc(t('Open its page'))}"><b>${esc(j.section || j.title)}</b>
          <span class="jb-state">${state}</span>${j.detail ? `<span class="jb-detail">${esc(j.detail)}</span>` : ''}</a>
        ${j.running && pct != null ? `<span class="jb-bar" aria-hidden="true"><span style="width:${pct}%"></span></span><span class="jb-pct">${pct}%</span>` : ''}
        ${stop}
        ${j.running ? '' : `<button type="button" class="jb-hide" data-hide="${esc(`${j.id}@${j.finishedAt}`)}" title="${esc(t('Hide'))}" aria-label="${esc(t('Hide'))}">×</button>`}
      </div>`;
    }).join('');
    return shown.some(j => j.running);
  }
  bar.addEventListener('click', async (e) => {
    const s = e.target.closest('[data-stop]');
    if (s) {
      const id = s.dataset.id;
      if ((armed.get(id) || 0) <= Date.now()) {
        armed.set(id, Date.now() + 4000);
        s.classList.add('jb-armed');
        s.querySelector('span').textContent = t('Stop it?');
        setTimeout(() => { if ((armed.get(id) || 0) <= Date.now() && s.isConnected) { s.classList.remove('jb-armed'); s.querySelector('span').textContent = t('Stop'); } }, 4100);
        return;
      }
      armed.delete(id);
      s.disabled = true;
      s.querySelector('span').textContent = t('Stopping…');
      await fetch(s.dataset.stop, { method: 'POST' }).catch(() => {});
      pollJobs();
      return;
    }
    const b = e.target.closest('[data-hide]');
    if (!b) return;
    dismissed.add(b.dataset.hide);
    store.set(DISMISSED, JSON.stringify([...dismissed].slice(-50)));
    b.closest('.jb-job').remove();
    if (!bar.children.length) { bar.hidden = true; document.body.classList.remove('has-jobbar'); }
  });
  // every 3 s while a run goes on, every 30 s otherwise (a run started in another tab); not while the tab is hidden
  async function pollJobs() {
    clearTimeout(pollTimer);
    if (document.hidden) return;
    let busy = false;
    try {
      const r = await fetch('/api/jobs');
      if (r.ok) busy = renderJobs((await r.json()).jobs || []);
    } catch { /* offline: try again later */ }
    pollTimer = setTimeout(pollJobs, busy ? 3000 : 30000);
  }
  function watchJobs() {
    pollJobs();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollJobs(); });
    // a page that starts a run asks for the bar at once
    window.addEventListener('rp:jobs', () => setTimeout(pollJobs, 800));
  }
})();
