/**
 * Generates the six page shells so the chrome (head, top bar, bottom nav) is
 * defined once. Run `node scripts/build-pages.mjs` after changing it.
 *
 * Accent colours cycle through the three the Figma file actually uses — the
 * ladder screen is cyan, the stats screen lime — so each page owns one.
 */
import { writeFile } from 'node:fs/promises';

const PAGES = [
  { slug: 'index',     title: 'Dashboard',         accent: 'lime',   icon: 'nav-stats',    nav: 'Dashboard' },
  { slug: 'squad',     title: 'Squad Optimiser',   accent: 'cyan',   icon: 'nav-teams',    nav: 'Squad' },
  { slug: 'transfers', title: 'Transfers',         accent: 'yellow', icon: 'nav-bracket',  nav: 'Transfers' },
  { slug: 'players',   title: 'Players',           accent: 'lime',   icon: 'nav-ladder',   nav: 'Players' },
  { slug: 'market',    title: 'Market',            accent: 'cyan',   icon: 'nav-fixtures', nav: 'Market' },
  { slug: 'rules',     title: 'Rules',             accent: 'yellow', icon: 'nav-admin',    nav: 'Rules' },
];

const href = (p) => `${p.slug}.html`;

const page = (p) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#202123" />
<title>${p.title} · LBH FPL 26/27</title>
<link rel="icon" type="image/svg+xml" href="img/favicon.svg" />
<link rel="apple-touch-icon" href="img/lbh-app-icon.svg" />
<link rel="preload" href="fonts/anton-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="fonts/inter-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="css/base.css" />
<link rel="stylesheet" href="css/app.css" />
</head>
<body data-accent="${p.accent}">
<header class="topbar">
  <a class="brand" href="index.html">
    <img class="brand-logo" src="img/logo-black.svg" alt="LBH Draft" />
    <span class="brand-text">FPL<br />26/27</span>
  </a>
  <nav>
${PAGES.map((q) => `    <a href="${href(q)}"${q.slug === p.slug ? ' class="active"' : ''}>${q.nav}</a>`).join('\n')}
  </nav>
</header>
<main class="container">
  <div id="databar"></div>
  <h1>${p.title}</h1>
  <div id="app"><p class="loading">Loading…</p></div>
</main>
<nav class="bottomnav">
${PAGES.map((q) => `  <a href="${href(q)}"${q.slug === p.slug ? ' class="active"' : ''}><img src="img/${q.icon}.svg" alt="" /><span>${q.nav}</span></a>`).join('\n')}
</nav>
<script type="module" src="js/pages/${p.slug === 'index' ? 'dashboard' : p.slug}.js"></script>
</body>
</html>
`;

for (const p of PAGES) {
  await writeFile(`${p.slug}.html`, page(p));
  console.log(`✓ ${p.slug}.html — ${p.accent}`);
}
