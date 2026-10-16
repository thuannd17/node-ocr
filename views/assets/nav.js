// Shared top navigation. Include as the first element of <body>:
//   <script src="/assets/nav.js"></script>
// It renders synchronously in place, so there is no layout flash.
(function () {
  const items = [
    { href: '/', icon: 'fa-house', label: 'Home' },
    { href: '/upload', icon: 'fa-upload', label: 'Upload Roster' },
    { href: '/label', icon: 'fa-tags', label: 'Label' },
    { href: '/benchmark', icon: 'fa-chart-column', label: 'Benchmark' },
    { href: '/models', icon: 'fa-brain', label: 'AI Models' },
  ];
  const here = location.pathname.replace(/\/+$/, '') || '/';
  const links = items
    .map((i) => `<a href="${i.href}"${i.href === here ? ' class="active" aria-current="page"' : ''}><i class="fa-solid ${i.icon}" aria-hidden="true"></i> ${i.label}</a>`)
    .join('');
  document.currentScript.insertAdjacentHTML(
    'beforebegin',
    `<nav class="topnav"><a class="brand" href="/">Roster OCR</a><div class="menu">${links}</div></nav>`
  );
})();
