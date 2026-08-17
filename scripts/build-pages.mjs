/**
 * Generates the six page shells so the chrome (head, top bar, bottom nav) is
 * defined once. Run `node scripts/build-pages.mjs` after changing it.
 *
 * Accent colours cycle through the three the Figma file actually uses — the
 * ladder screen is cyan, the stats screen lime — so each page owns one.
 */
import { writeFile } from 'node:fs/promises';

const PAGES = [
  // Icons are the WC Draft file's own Menu Bar frame (node 229:55), one per page
  // in the order they sit on the canvas. Each is a single #F4FF7B glyph on a
  // transparent ground, which is what the bottom nav's grey-out filter expects.
  { slug: 'index',     title: 'Dashboard',         accent: 'lime',   icon: 'nav-dashboard', nav: 'Dashboard' },
  { slug: 'squad',     title: 'Squad Optimiser',   accent: 'cyan',   icon: 'nav-squad',     nav: 'Squad' },
  { slug: 'draft',     title: 'Draft Board',       accent: 'cyan',   icon: 'nav-draft',     nav: 'Draft' },
  { slug: 'transfers', title: 'Transfers',         accent: 'yellow', icon: 'nav-transfers', nav: 'Transfers' },
  { slug: 'players',   title: 'Players',           accent: 'lime',   icon: 'nav-players',   nav: 'Players' },
  { slug: 'market',    title: 'Market',            accent: 'cyan',   icon: 'nav-market',    nav: 'Market' },
  { slug: 'rules',     title: 'Rules',             accent: 'yellow', icon: 'nav-rules',     nav: 'Rules' },
];

const href = (p) => `${p.slug}.html`;

const page = (p) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#202123" />
<title>${p.title} · LBH FPL 26/27</title>
<link rel="icon" type="image/svg+xml" href="img/logo-fpl.svg" />
<link rel="apple-touch-icon" href="img/apple-touch-icon.png" />
<link rel="manifest" href="manifest.json" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="FPL Tracker" />
<link rel="preload" href="fonts/anton-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="fonts/inter-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="css/base.css" />
<link rel="stylesheet" href="css/app.css" />
</head>
<body data-accent="${p.accent}" data-page="${p.slug}">
<header class="topbar">
  <a class="brand" href="index.html">
    <img class="brand-logo" src="img/logo-fpl.svg" alt="FPL Tracker" />
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
