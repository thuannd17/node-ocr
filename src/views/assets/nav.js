// Shared top navigation. Include as the first element of <body>:
//   <script src="/assets/nav.js"></script>
// It renders synchronously in place, so there is no layout flash.
// Needs /assets/i18n.js (in <head>) for the language switch and the labels.
//
// Two groups: the public tools, and Admin (labels, benchmarks, models, media, users) in a menu of its own, shown to
// admins only (routes/auth-api.js guards the pages themselves). Right of it: Sign in, or the account's name (/account).
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
    { href: '/label', icon: 'fa-tags', label: 'Label' },
    { href: '/benchmark', icon: 'fa-chart-column', label: 'Benchmark' },
    { href: '/models', icon: 'fa-brain', label: 'AI Models' },
    { href: '/media', icon: 'fa-photo-film', label: 'Media' },
    { href: '/helpdesk', icon: 'fa-headset', label: 'Helpdesk' },
    { href: '/users', icon: 'fa-users', label: 'Users' },
    { href: '/billing', icon: 'fa-file-invoice-dollar', label: 'Billing' },
  ];
  const here = location.pathname.replace(/\/+$/, '') || '/';
  const link = (i) => `<a href="${i.href}"${i.href === here ? ' class="active" aria-current="page"' : ''}><i class="fa-solid ${i.icon}" aria-hidden="true"></i> ${t(i.label)}</a>`;
  const inAdmin = ADMIN.some(i => i.href === here);
  // the admin menu: shown at once on an admin page, else once /api/auth/me says this is an admin
  const admin = `<details class="admin-menu${inAdmin ? ' active' : ''}"${inAdmin ? '' : ' hidden'}>
    <summary title="${t('Administration: labels, benchmarks and models (admins only)')}"><i class="fa-solid fa-user-gear" aria-hidden="true"></i> ${t('Admin')} <i class="fa-solid fa-chevron-down caret" aria-hidden="true"></i></summary>
    <div class="admin-list">${ADMIN.map(link).join('')}</div></details>`;
  const signIn = `<a class="account-link" href="/login${here === '/' || here === '/login' || here === '/signup' ? '' : `?next=${encodeURIComponent(location.pathname + location.search)}`}"><i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i> <span>${t('Sign in')}</span></a>`;
  const i18n = window.I18N;
  const langs = i18n
    ? `<div class="lang" role="group" aria-label="Language">${Object.entries(i18n.langs).map(([code, name]) =>
      `<button type="button" data-lang="${code}" title="${name}"${code === i18n.lang ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>${code.toUpperCase()}</button>`).join('')}</div>`
    : '';
  document.currentScript.insertAdjacentHTML(
    'beforebegin',
    `<nav class="topnav" data-no-i18n><button type="button" class="nav-toggle" aria-expanded="false" aria-controls="navMenu" title="${t('Menu')}" aria-label="${t('Menu')}"><i class="fa-solid fa-bars" aria-hidden="true"></i></button>`
    + `<a class="brand" href="/">RosterParser</a><div class="menu" id="navMenu">${PUBLIC.map(link).join('')}</div>`
    + `<div class="nav-right">${admin}${signIn}${langs}</div></nav>`
  );
  const nav = document.querySelector('.topnav');
  nav.querySelector('.lang')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) i18n.setLang(b.dataset.lang);
  });
  // Phones and tablets: the public links fold into a menu under the ☰ button (app.css, max-width 900px).
  const toggle = nav.querySelector('.nav-toggle');
  const setOpen = (open) => { nav.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open)); };
  toggle.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!nav.classList.contains('open')); });
  document.addEventListener('click', (e) => { if (nav.classList.contains('open') && !nav.querySelector('.menu').contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('open')) { setOpen(false); toggle.focus(); } });
  // The admin menu closes on a click elsewhere or Esc.
  const menu = nav.querySelector('.admin-menu');
  document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
  // Who is signed in: the account link (Sign in / the account's name), the admin menu for admins only
  const accountLink = nav.querySelector('.account-link');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  fetch('/api/auth/me').then(r => r.json()).then((me) => {
    if (me.user) {
      accountLink.href = '/account';
      accountLink.title = me.user.email;
      accountLink.innerHTML = `<i class="fa-solid fa-circle-user" aria-hidden="true"></i> <span>${esc(me.user.name || me.user.email)}</span>`;
      if (here === '/account') accountLink.classList.add('active');
    } else if (!me.enabled) {
      accountLink.hidden = true; // login not set up
    }
    menu.hidden = !(me.user?.role === 'admin' || me.local);
  }).catch(() => {});
})();
