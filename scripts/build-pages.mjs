/**
 * Generates the six page shells so the chrome (head, top bar, bottom nav) is
 * defined once. Run `node scripts/build-pages.mjs` after changing it.
 *
 * Accent colours cycle through the three the Figma file actually uses — the
 * ladder screen is cyan, the stats screen lime — so each page owns one.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, normalize } from 'node:path';

/**
 * The two products. Classic FPL and FPL Draft are different games — different
 * mechanics, different state, different questions — and the site now says so
 * at the top level rather than mixing their pages into one navigation.
 *
 * `home` is where the product switcher lands. Deliberately each product's own
 * dashboard rather than an equivalent page: Classic Transfers and Draft Waivers
 * are not the same activity, and pretending they are makes the switch
 * unpredictable.
 */
const PRODUCTS = [
  // Draft first, logo centred, Classic right — the composition in Figma 236:2.
  { id: 'draft',   label: 'Draft',   home: 'draft-dashboard' },
  { id: 'classic', label: 'Classic', home: 'index' },
];

/**
 * Every page, and which product owns it.
 *
 * Filenames stay flat at the repo root. `js/data.js` fetches `data/<name>.json`
 * RELATIVE to the page URL, so moving pages into /classic/ and /draft/ would
 * make them request /classic/data/… — and fixing that means absolute paths,
 * which on a project Pages site must be /fpl-2627-tracker/data/ and then break
 * `npm run serve` at localhost root. Flat files keep direct loads, refreshes,
 * Pages and every existing Classic bookmark working, with no change to the data
 * layer. The product split is expressed in the navigation, not the paths.
 */
const PAGES = [
  // Icons are the WC Draft file's own Menu Bar frame (node 229:55).
  //
  // `hidden` keeps a page reachable by URL while removing it from every
  // navigation. Nothing here is deleted: Squad absorbed the old Dashboard,
  // Players absorbed Market, and Draft's Waivers folded into Draft Players —
  // but their URLs still resolve, so bookmarks and in-page links survive and
  // the functionality can be pulled back into view if the grouping proves wrong.
  // ---- Classic ----
  { slug: 'index',           product: 'classic', title: 'Squad',       accent: 'lime',   icon: 'nav-squad',     nav: 'Squad' },
  { slug: 'transfers',       product: 'classic', title: 'Transfers',   accent: 'yellow', icon: 'nav-transfers', nav: 'Transfers' },
  { slug: 'players',         product: 'classic', title: 'Players',     accent: 'cyan',   icon: 'nav-players',   nav: 'Players' },
  { slug: 'squad',           product: 'classic', title: 'Optimiser',   accent: 'cyan',   icon: 'nav-squad',     nav: 'Optimiser', hidden: true },
  { slug: 'market',          product: 'classic', title: 'Market',      accent: 'cyan',   icon: 'nav-market',    nav: 'Market',    hidden: true },
  { slug: 'rules',           product: 'classic', title: 'Rules',       accent: 'yellow', icon: 'nav-rules',     nav: 'Rules',     hidden: true },
  // ---- Draft ----
  { slug: 'draft-dashboard', product: 'draft',   title: 'Squad',       accent: 'cyan',   icon: 'nav-squad',     nav: 'Squad' },
  { slug: 'draft-league',    product: 'draft',   title: 'League',      accent: 'lime',   icon: 'nav-market',    nav: 'League' },
  { slug: 'draft-players',   product: 'draft',   title: 'Players',     accent: 'yellow', icon: 'nav-players',   nav: 'Players' },
  // Draft Night is a sub-mode of Draft, never a third product.
  { slug: 'draft',           product: 'draft',   title: 'Draft Night', accent: 'cyan',   icon: 'nav-draft',     nav: 'Draft Night' },
  { slug: 'draft-squad',     product: 'draft',   title: 'Squad detail', accent: 'cyan',  icon: 'nav-squad',     nav: 'Squad',     hidden: true },
  { slug: 'draft-waivers',   product: 'draft',   title: 'Waivers',     accent: 'yellow', icon: 'nav-transfers', nav: 'Waivers',   hidden: true },
];

/** The dashboard's module is named for what it is, not for its URL. */
const entryFor = (p) => `js/pages/${p.slug === 'index' ? 'dashboard' : p.slug}.js`;

/** Pages of one product, in navigation order, excluding hidden ones. */
const pagesOf = (product) => PAGES.filter((q) => q.product === product && !q.hidden);

/**
 * Every module a page reaches, transitively.
 *
 * The browser cannot discover `js/data.js` until it has downloaded and parsed
 * `js/pages/squad.js`, so imports arrive in waves. Measured on the deployed
 * site that cost ~400ms of dead network time before the first data request even
 * started, and the draft page is thirteen modules deep. Emitting the whole graph
 * as `<link rel="modulepreload">` lets them all start at once.
 *
 * This changes *when* modules are fetched, never what runs or in what order —
 * module evaluation order is still decided by the import statements. The one
 * obligation it creates: re-run this script after adding an import, the same as
 * for any other change here. A stale list is slow, never wrong.
 */
/**
 * A content hash over a page's whole module graph, used to version its script
 * URLs.
 *
 * Data files already carry a cache-buster; JS did not, and browsers were
 * serving stale modules after a deploy — a change would be live in the repo,
 * live on Pages, and simply not running in anyone's browser until they
 * happened to hard-refresh. That is the worst kind of bug: everything reports
 * success and the user sees the old app.
 *
 * Hashing the graph rather than stamping a build time means an unchanged page
 * keeps its URL and stays cached, which is the whole point of caching.
 */
async function graphHash(files) {
  const h = createHash('sha256');
  for (const f of [...files].sort()) {
    h.update(f);
    h.update(await readFile(f, 'utf8').catch(() => ''));
  }
  return h.digest('hex').slice(0, 8);
}

async function moduleGraph(file, out = new Set()) {
  let src;
  try {
    src = await readFile(file, 'utf8');
  } catch {
    return out; // a page without its own module is not an error worth failing on
  }
  for (const [, spec] of src.matchAll(/from\s+'([^']+)'/g)) {
    if (!spec.startsWith('.')) continue; // bare specifiers: nothing to preload
    const path = normalize(join(dirname(file), spec));
    if (out.has(path)) continue;
    out.add(path);
    await moduleGraph(path, out);
  }
  return out;
}

/**
 * Modules reached only through a dynamic `import()`.
 *
 * These must NOT be preloaded — being lazy is the whole reason they are
 * dynamic — but they DO have to affect the page's version hash, or editing one
 * leaves every browser running the cached copy with nothing to signal it.
 */
async function lazyGraph(files) {
  const out = new Set();
  for (const file of files) {
    const src = await readFile(file, 'utf8').catch(() => '');
    // Matches both import('./x.js') and import(`./x.js${v}`) — the second form
    // is what a cache-busted lazy import looks like, and a quote-only pattern
    // silently found nothing, which is exactly the staleness this guards.
    for (const [, spec] of src.matchAll(/import\(\s*[`']([^`'$]+)/g)) {
      if (!spec.startsWith('.')) continue;
      const path = normalize(join(dirname(file), spec));
      if (out.has(path) || files.has?.(path)) continue;
      out.add(path);
      await moduleGraph(path, out);
    }
  }
  return out;
}

const href = (p) => `${p.slug}.html`;

/**
 * An import map, because a version query does not survive a nested import.
 *
 * `squad.js?v=abc` importing `../ui.js` resolves against its own URL and the
 * query is NOT inherited — the browser fetches an unversioned `/js/ui.js` and
 * happily serves whatever it cached last week. Versioning only the entry point
 * therefore busts nothing below it, and worse, the preload hints point at URLs
 * the imports never request.
 *
 * Mapping every module in the graph fixes both: the specifier a module writes
 * is rewritten to the versioned URL, so one map covers the whole tree.
 *
 * Keys MUST carry the `./` prefix. Without it the browser reads `js/ui.js` as a
 * BARE specifier — the npm-package kind — which never matches a relative import
 * and silently maps nothing. Keeping them relative also means this works at the
 * site root and under a project subpath alike.
 */
const importMap = (modules, v) => `<script type="importmap">
${JSON.stringify({
    imports: Object.fromEntries(modules.map((m) => [`./${m}`, `./${m}?v=${v}`])),
  }, null, 0)}
</script>`;

const page = (p, modules, v, cssV, lazy = []) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#202123" />
<title>${p.title} · LBH FPL 26/27</title>
<link rel="icon" type="image/svg+xml" href="img/logo-fpl.svg?v=${cssV}" />
<link rel="apple-touch-icon" href="img/apple-touch-icon.png" />
<link rel="manifest" href="manifest.json" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="FPL Tracker" />
<link rel="preload" href="fonts/anton-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="fonts/inter-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin />
<!-- 700/800/900 are used by the databar, tables and the bottom nav, but a weight
     is only requested once something renders in it — measured arriving at 1.5-2.0s,
     long after first paint, which is what made the text visibly re-flow. The
     italic is deliberately absent: nothing renders in it on load. -->
<link rel="preload" href="fonts/inter-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="fonts/inter-latin-800-normal.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="fonts/inter-latin-900-normal.woff2" as="font" type="font/woff2" crossorigin />
${importMap([...modules, ...lazy], v)}
${modules.map((m) => `<link rel="modulepreload" href="${m}?v=${v}" />`).join('\n')}
<link rel="stylesheet" href="css/base.css?v=${cssV}" />
<link rel="stylesheet" href="css/app.css?v=${cssV}" />
</head>
<body data-accent="${p.accent}" data-page="${p.slug}" data-product="${p.product}">
<header class="appbar">
  <nav class="productnav" aria-label="Product">
${PRODUCTS.map((pr) => `    <a href="${pr.home}.html"${pr.id === p.product ? ' class="active" aria-current="true"' : ''}>${pr.label}</a>`).join('\n')}
  </nav>
  <a class="brand" href="${PRODUCTS.find((pr) => pr.id === p.product).home}.html">
    <img class="brand-logo" src="img/logo-fpl.svg?v=${cssV}" alt="" />
    <span class="brand-text">FPL<br />Tracker</span>
  </a>
</header>
<nav class="pagenav" aria-label="${p.product === 'draft' ? 'Draft' : 'Classic'} pages">
${pagesOf(p.product).map((q) => `  <a href="${href(q)}"${q.slug === p.slug ? ' class="active" aria-current="page"' : ''}>${q.nav}</a>`).join('\n')}
</nav>
<main class="container">
  <div id="databar"></div>
  <h1>${p.title}</h1>
  <div id="app"><p class="loading">Loading…</p></div>
</main>
<nav class="bottomnav" aria-label="${p.product === 'draft' ? 'Draft' : 'Classic'} pages">
${pagesOf(p.product).map((q) => `  <a href="${href(q)}"${q.slug === p.slug ? ' class="active" aria-current="page"' : ''}><img src="img/${q.icon}.svg" alt="" /><span>${q.nav}</span></a>`).join('\n')}
</nav>
<script type="module" src="${entryFor(p)}?v=${v}"></script>
</body>
</html>
`;

// Stylesheets need the same treatment as modules, and for the same reason: a
// cached app.css against fresh JS renders new markup with no rules for it,
// which looks like a layout bug rather than a caching one.
/* The shell's own assets, versioned together. The logo used to be requested
   without a version, so replacing the mark left every returning browser showing
   the old one — the same class of bug the JS versioning fixed. */
const cssV = await graphHash(['css/base.css', 'css/app.css', 'img/logo-fpl.svg']);

for (const p of PAGES) {
  const entry = entryFor(p);
  const modules = [entry, ...await moduleGraph(entry)];
  // Lazy modules count toward the hash but are deliberately left out of the
  // preload list below.
  const lazy = await lazyGraph(new Set(modules));
  const v = await graphHash([...modules, ...lazy]);
  await writeFile(`${p.slug}.html`, page(p, modules, v, cssV, [...lazy]));
  console.log(`✓ ${p.slug}.html — ${p.accent}, ${modules.length} module${modules.length === 1 ? '' : 's'}`
    + `${lazy.size ? ` + ${lazy.size} lazy` : ''}, v=${v}`);
}
