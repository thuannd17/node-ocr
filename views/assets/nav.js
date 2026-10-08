// Shared top navigation. Include as the first element of <body>:
//   <script src="/assets/nav.js"></script>
// It renders synchronously in place, so there is no layout flash.
(function () {
  const items = [
    { href: '/', label: '🏠 Home' },
    { href: '/upload', label: '📤 Upload & OCR' },
    { href: '/label', label: '🏷️ Label' },
    { href: '/benchmark', label: '📊 Benchmark' },
  ];
  const here = location.pathname.replace(/\/+$/, '') || '/';
  const links = items
    .map((i) => `<a href="${i.href}"${i.href === here ? ' class="active" aria-current="page"' : ''}>${i.label}</a>`)
    .join('');
  document.currentScript.insertAdjacentHTML(
    'beforebegin',
    `<nav class="topnav"><a class="brand" href="/">📋 Roster OCR</a><div class="menu">${links}</div></nav>`
  );
})();
