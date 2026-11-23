// site-generator-speed-01's case generator: generate(rng, index) draws one whole site for makefun-site to build, from
// rng alone (the scaffold's rng.ts stream of the case), so a seed always draws the same site. No corpus: every word
// comes from the tables below, written for this home.
//
// A site holds SOURCES_MIN to SOURCES_MAX Markdown sources (about 1 to 4 KB each: posts under posts/, pages at the root
// and under a few directories; how many is drawn in the band of its index, SIZE_BANDS) and a few static files, 14 to 30 templates (the five layouts every site has and
// partials drawn around them), and a site record. Its sources carry what a public generator gets wrong: about a tenth
// are drafts, some 5% hold a title outside ASCII and some 5% repeat an earlier title in another spelling, so slugs
// collide; about 5% of the sources are refused by makefun-site's own front matter (an unknown key, a key given twice,
// a date that is not one, a missing title, a tag list or a quoted string that does not read, a post with no date, a
// layout no template has); and their bodies mix the Markdown makefun-site reads with what it does not (raw HTML,
// indented code, setext underlines, underscores, closing hashes), links to pages, drafts, refusals and files that are
// not there, and the characters its escape table names.

/** How many Markdown sources a site holds. */
export const SOURCES_MIN = 200;
export const SOURCES_MAX = 600;

/**
 * The three bands of a site's size, by its index in the set (index % 3): every three sites hold a small, a middling and
 * a large one, so one set weighs about what another does, whatever its seed.
 */
export const SIZE_BANDS = Object.freeze([
  [200, 333],
  [334, 466],
  [467, 600],
]);

const WORDS = (
  'the a of and to in is that it for on with as was at by be this from or are an but not you all can had her were ' +
  'one our out day get has him his how man new now old see two way who boy did its let put say she too use build ' +
  'site page post static render template markdown slug output tree index list tag draft layout partial front matter ' +
  'river stone garden orbit signal lantern harbor meadow copper velvet summit compass thunder willow ember quartz ' +
  'parser token cache queue thread buffer vector matrix kernel socket packet module bundle schema record ledger ' +
  'morning evening winter autumn spring summer north south island valley canyon forest desert ocean prairie glacier ' +
  'quick slow bright quiet early late simple careful honest steady curious patient gentle bold clever plain ' +
  'write read keep move turn hold draw walk measure compare gather follow notice explain describe remember'
).split(' ');

const UNICODE_WORDS = ['café', 'Zürich', 'naïve', 'résumé', 'Ærøskøbing', 'São Paulo', 'Łódź', 'Ångström', 'smörgåsbord', 'piñata', 'Füße', 'Δέλτα', 'Москва', '東京', 'crème brûlée', 'Kraków', 'ﬁnal', 'Ｗｉｄｅ', 'œuvre', 'Straße'];

const TAG_NAMES = [
  'JavaScript', 'javascript', 'Java Script', 'Node.js', 'node-js', 'Rust', 'Go', 'C++', 'C#', 'Performance', 'performance',
  'Static Sites', 'static-sites', 'Markdown', 'Templates', 'Design', 'Notes', 'Travel', 'Food', 'Café Culture', 'cafe culture',
  'Music', 'Books', 'Running', 'Garden', 'Release Notes', 'release notes', 'Tutorials', 'How To', 'how-to', 'Q&A', 'Ideas',
  'Open Source', 'open source', 'Weekend', 'Photography', 'Data', 'Maps', 'Écriture', 'ecriture',
];

const LANGS = ['js', 'ts', 'html', 'css', 'json', 'sh', 'python', 'rust', 'c++', ''];

const PAGE_DIRS = ['', '', 'docs', 'docs/guides', 'about', 'projects', 'notes'];

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

/** `n` words from the table, now and then one from outside ASCII. */
function words(rng, n, unicode = 0.02) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(rng.chance(unicode) ? rng.pick(UNICODE_WORDS) : rng.pick(WORDS));
  return out;
}

/** A title: 2 to 7 words, capitalised, sometimes with punctuation a slug drops. */
function titleOf(rng, unicode) {
  const ws = words(rng, rng.int(2, 7), unicode ? 0.5 : 0).map((w, i) => (i === 0 || rng.chance(0.4) ? cap(w) : w));
  if (unicode && !ws.some((w) => UNICODE_WORDS.includes(w) || UNICODE_WORDS.includes(w.toLowerCase()))) ws[rng.int(0, ws.length - 1)] = rng.pick(UNICODE_WORDS);
  let t = ws.join(' ');
  const tail = rng.int(0, 9);
  if (tail === 0) t += '!';
  else if (tail === 1) t += '?';
  else if (tail === 2) t = `${t}: ${cap(rng.pick(WORDS))}`;
  else if (tail === 3) t = `${t} & ${rng.pick(WORDS)}`;
  else if (tail === 4) t = `"${t}"`;
  else if (tail === 5) t = `${t} (${rng.int(1, 12)})`;
  return t;
}

/** Another spelling of `title` that slugs the same: case, punctuation and spacing moved. */
function respell(rng, title) {
  const plain = title.replace(/[^A-Za-z0-9 ]+/g, ' ').trim();
  switch (rng.int(0, 3)) {
    case 0:
      return plain.toUpperCase();
    case 1:
      return `${plain.toLowerCase()}!!`;
    case 2:
      return plain.split(/ +/).join(' -- ');
    default:
      return `  ${plain}.`;
  }
}

/** A title as front matter writes it: bare, or quoted with its quotes and backslashes escaped. */
function titleLine(rng, title) {
  const needsQuote = title.startsWith('"') || title.startsWith('[') || title !== title.trim();
  if (needsQuote || rng.chance(0.3)) return `title: "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `title: ${title}`;
}

/** A date from 2018 to 2026, as YYYY-MM-DD. */
function dateOf(rng) {
  const y = rng.int(2018, 2026);
  const m = rng.int(1, 12);
  const d = rng.int(1, m === 2 ? 28 : 30);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A sentence of 5 to 16 words, inline marks drawn in, links from `links`. */
function sentence(rng, links) {
  const ws = words(rng, rng.int(5, 16));
  ws[0] = cap(ws[0]);
  const marks = rng.int(0, 3);
  for (let k = 0; k < marks; k++) {
    const at = rng.int(0, ws.length - 1);
    const w = ws[at];
    switch (rng.int(0, 15)) {
      case 0:
      case 1:
        ws[at] = `*${w}*`;
        break;
      case 2:
      case 3:
        ws[at] = `**${w}**`;
        break;
      case 4:
        ws[at] = `\`${w}()\``;
        break;
      case 5:
        ws[at] = `_${w}_`;
        break;
      case 6:
        ws[at] = `${w}_${rng.pick(WORDS)}_${rng.pick(WORDS)}`;
        break;
      case 7:
      case 8:
        ws[at] = `[${w} ${rng.pick(WORDS)}](${rng.pick(links)})`;
        break;
      case 9:
        ws[at] = `<${rng.pick(['b', 'span', 'em', 'kbd'])}>${w}</${rng.pick(['b', 'span', 'em', 'kbd'])}>`;
        break;
      case 10:
        ws[at] = `${w} & ${rng.pick(WORDS)}`;
        break;
      case 11:
        ws[at] = `"${w}"`;
        break;
      case 12:
        ws[at] = `${w}'s`;
        break;
      case 13:
        ws[at] = `\\*${w}\\*`;
        break;
      case 14:
        ws[at] = `**${w} *${rng.pick(WORDS)}* ${rng.pick(WORDS)}**`;
        break;
      default:
        ws[at] = `${w} < ${rng.int(2, 99)} > ${rng.int(0, 9)}`;
    }
  }
  return `${ws.join(' ')}${rng.pick(['.', '.', '.', '!', '?', ':', ';'])}`;
}

/** A paragraph: sentences wrapped into lines of about 60 to 100 characters. */
function paragraph(rng, links) {
  const text = Array.from({ length: rng.int(2, 6) }, () => sentence(rng, links)).join(' ');
  const width = rng.int(60, 100);
  const lines = [];
  let cur = '';
  for (const w of text.split(' ')) {
    if (cur !== '' && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else cur = cur === '' ? w : `${cur} ${w}`;
  }
  if (cur !== '') lines.push(cur);
  if (rng.chance(0.08)) lines[rng.int(0, lines.length - 1)] += '  ';
  if (rng.chance(0.06)) lines[rng.int(0, lines.length - 1)] = `    ${lines[rng.int(0, lines.length - 1)]}`;
  return lines.join('\n');
}

/** A fenced code block, its body full of what HTML escapes. */
function codeBlock(rng) {
  const lang = rng.pick(LANGS);
  const n = rng.int(2, 12);
  const lines = [];
  for (let i = 0; i < n; i++) {
    switch (rng.int(0, 6)) {
      case 0:
        lines.push(`const ${rng.pick(WORDS)} = "${rng.pick(WORDS)}" && x < ${rng.int(0, 99)};`);
        break;
      case 1:
        lines.push(`<div class='${rng.pick(WORDS)}'>${rng.pick(WORDS)} &amp; ${rng.pick(WORDS)}</div>`);
        break;
      case 2:
        lines.push('');
        break;
      case 3:
        lines.push(`  ${'*'.repeat(rng.int(1, 3))} ${rng.pick(WORDS)} [${rng.pick(WORDS)}](#${rng.pick(WORDS)})`);
        break;
      case 4:
        lines.push(`# ${rng.pick(WORDS)} -> ${rng.pick(WORDS)}`);
        break;
      default:
        lines.push(`    ${words(rng, rng.int(2, 8)).join('_')}();`);
    }
  }
  return `\`\`\`${lang}\n${lines.join('\n')}\n\`\`\``;
}

/** A body: 4 to 16 blocks; `links` are the link targets it may use. */
function bodyOf(rng, links, size) {
  const blocks = [];
  const headings = [];
  let bytes = 0;
  while (bytes < size || blocks.length < 4) {
    let b;
    const kind = rng.int(0, 29);
    if (kind < 12) b = paragraph(rng, links);
    else if (kind < 16) {
      const reuse = headings.length > 0 && rng.chance(0.2);
      const text = reuse ? rng.pick(headings) : words(rng, rng.int(1, 5), 0.05).map(cap).join(' ');
      headings.push(text);
      const level = rng.pick([2, 2, 2, 3, 3, 4, 1, 5, 6]);
      b = `${'#'.repeat(level)} ${text}${rng.chance(0.1) ? ' ##' : ''}`;
    } else if (kind < 19) {
      const ordered = rng.chance(0.4);
      const start = ordered ? (rng.chance(0.7) ? 1 : rng.int(2, 20)) : 0;
      const items = [];
      for (let k = 0; k < rng.int(2, 7); k++) {
        let item = `${ordered ? `${start + k}. ` : rng.pick(['- ', '* '])}${sentence(rng, links)}`;
        if (rng.chance(0.15)) item += `\n  ${sentence(rng, links)}`;
        items.push(item);
      }
      b = items.join('\n');
    } else if (kind < 21) b = codeBlock(rng);
    else if (kind < 23) b = Array.from({ length: rng.int(1, 4) }, () => `> ${sentence(rng, links)}`).join('\n');
    else if (kind < 24) b = rng.pick(['---', '***', '---  ']);
    else if (kind < 25) b = `${paragraph(rng, links)}\n${rng.pick(['---', '===', '***'])}`;
    else if (kind < 26) b = `<div class="${rng.pick(WORDS)}">\n${sentence(rng, links)}\n</div>`;
    else if (kind < 27) b = `    ${words(rng, rng.int(3, 9)).join(' ')}\n    ${words(rng, rng.int(3, 9)).join(' ')}`;
    else if (kind < 28) b = `#${rng.pick(WORDS)} ${sentence(rng, links)}`;
    else b = `${rng.int(1, 30)}) ${sentence(rng, links)}\n+ ${sentence(rng, links)}`;
    blocks.push(b);
    bytes += b.length + 2;
  }
  return blocks.join(rng.chance(0.1) ? '\n\n\n' : '\n\n');
}

/** `path`'s target from the source at `from`, as a relative link ("../" where it must climb). */
function relativeLink(from, path) {
  const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')).split('/') : [];
  const to = path.split('/');
  let k = 0;
  while (k < fromDir.length && k < to.length - 1 && fromDir[k] === to[k]) k++;
  return [...fromDir.slice(k).map(() => '..'), ...to.slice(k)].join('/');
}

// ---------------------------------------------------------------- the templates

/** The templates of one site: the five layouts, the partials they include, and filler partials, 10 to 30 in all. */
function templatesOf(rng) {
  const c = rng.pick(['site', 'mf', 'blog', 'wrap', 'ink', 'paper']);
  const el = rng.pick(['main', 'div', 'section']);
  const ind = rng.pick(['  ', '    ', '\t']);
  const t = {};
  const extras = [];
  const fillers = rng.int(0, 15);
  for (let k = 0; k < fillers; k++) {
    const name = `${rng.pick(['promo', 'aside', 'note', 'badge', 'strip'])}-${k + 1}`;
    extras.push(name);
    const body = rng.pick([
      `<aside class="${c}-${name}">{{ site.title }} · ${words(rng, 3).join(' ')}</aside>\n`,
      `{% if recent %}\n<p class="${name}">{% for p in recent %}{% if loop.first %}Latest: {% endif %}<a href="{{ p.url }}">{{ p.title }}</a>{% if not loop.last %}, {% endif %}{% endfor %}</p>\n{% endif %}\n`,
      `<div class="${name}">\n${ind}{% for t in tags %}\n${ind}{% if loop.index %}<span data-n="{{ loop.index }}">{{ t.name }} ({{ t.count }})</span>{% endif %}\n${ind}{% endfor %}\n</div>\n`,
      `<p class="${name}">{{ page.title }}{% if page.date %} - {{ page.date_long }}{% else %} - undated{% endif %}</p>\n`,
    ]);
    t[name] = body;
  }
  const extraIncludes = (n) =>
    Array.from({ length: Math.min(n, extras.length) }, () => `${ind}{% include "${rng.pick(extras)}" %}\n`).join('');
  t.meta = `<meta name="generator" content="makefun-site">\n<meta property="og:site_name" content="{{ site.title }}">\n{% if page %}<meta property="og:title" content="{{ page.title }}">{% endif %}\n`;
  t.head = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n{% include "meta" %}\n<title>{% if page %}{{ page.title }} | {% endif %}{% if tag %}{{ tag.name }} | {% endif %}{{ site.title }}</title>\n<link rel="stylesheet" href="{{ site.base_url }}/assets/style.css">\n</head>\n<body class="${c}">\n`;
  t.nav = `<nav class="${c}-nav">\n${ind}<a href="{{ site.base_url }}/">Home</a>\n${ind}<a href="{{ site.base_url }}/tags/">Tags</a>\n{% for p in recent %}\n${ind}<a href="{{ p.url }}"{% if loop.last %} class="last"{% endif %}>{{ p.title }}</a>\n{% endfor %}\n</nav>\n`;
  t.header = `<header class="${c}-header">\n${ind}<h1 class="${c}-title"><a href="{{ site.base_url }}/">{{ site.title }}</a></h1>\n${rng.chance(0.7) ? `${ind}{% include "nav" %}\n` : ''}</header>\n`;
  t.footer = `<footer class="${c}-footer">\n${ind}<p>{{ site.title }}, built by makefun-site.</p>\n${extraIncludes(rng.int(0, 2))}</footer>\n</body>\n</html>\n`;
  t['tag-list'] = rng.pick([
    `<ul class="${c}-tags">{% for t in p.tags %}<li><a href="{{ t.url }}">{{ t.name }}</a></li>{% endfor %}</ul>\n`,
    `{% if p.tags %}\n<p class="${c}-tags">Tagged {% for t in p.tags %}{% if t.url %}<a href="{{ t.url }}">#{{ t.slug }}</a>{% else %}#{{ t.slug }}{% endif %}{% if not loop.last %} {% endif %}{% endfor %}</p>\n{% endif %}\n`,
  ]);
  t.card = `<article class="${c}-card">\n${ind}<h2><a href="{{ p.url }}">{{ p.title }}</a></h2>\n${ind}<p class="meta"><time datetime="{{ p.date }}">{{ p.date_long }}</time> · {{ p.reading_minutes }} min</p>\n{% if p.summary %}\n${ind}<p class="summary">{{ p.summary }}</p>\n{% else %}\n${ind}<div class="excerpt">{{{ p.excerpt }}}</div>\n{% endif %}\n${ind}{% include "tag-list" %}\n</article>\n`;
  t.toc = `{% if page.toc %}\n<nav class="${c}-toc">\n<ol>\n{% for h in page.toc %}\n${ind}<li class="toc-{{ h.level }}"><a href="#{{ h.id }}">{{{ h.html }}}</a></li>\n{% endfor %}\n</ol>\n</nav>\n{% endif %}\n`;
  t.pager = `<nav class="${c}-pager">\n{% if pager.newer_url %}${ind}<a rel="prev" href="{{ pager.newer_url }}">Newer</a>\n{% endif %}\n${ind}<span>Page {{ pager.number }} of {{ pager.total }}</span>\n{% if pager.older_url %}\n${ind}<a rel="next" href="{{ pager.older_url }}">Older</a>\n{% endif %}\n</nav>\n`;
  const pageMeta = `{% if page.date %}<p class="meta"><time datetime="{{ page.date }}">{{ page.date_long }}</time> · {{ page.reading_minutes }} min read</p>{% endif %}\n`;
  const pageTags = `{% if page.tags %}\n<ul class="${c}-page-tags">\n{% for t in page.tags %}\n${ind}<li>{% if t.url %}<a href="{{ t.url }}">{{ t.name }}</a>{% else %}{{ t.name }}{% endif %}</li>\n{% endfor %}\n</ul>\n{% endif %}\n`;
  const neighbours = `<nav class="${c}-neighbours">\n{% if page.newer %}\n${ind}<a href="{{ page.newer.url }}">&larr; {{ page.newer.title }}</a>\n{% endif %}\n{% if page.older %}\n${ind}<a href="{{ page.older.url }}">{{ page.older.title }} &rarr;</a>\n{% endif %}\n</nav>\n`;
  const postParts = [pageMeta, pageTags, rng.chance(0.8) ? '{% include "toc" %}\n' : ''];
  if (rng.chance(0.5)) postParts.reverse();
  t.post = `{% include "head" %}\n{% include "header" %}\n<${el} class="${c}-post">\n<article>\n<h1>{{ page.title }}</h1>\n${postParts.join('')}{{{ page.content }}}\n</article>\n${neighbours}${extraIncludes(rng.int(0, 3))}</${el}>\n{% include "footer" %}\n`;
  t.page = `{% include "head" %}\n{% include "header" %}\n<${el} class="${c}-page">\n<h1>{{ page.title }}</h1>\n${rng.chance(0.5) ? '{% include "toc" %}\n' : ''}{{{ page.content }}}\n${pageTags}${extraIncludes(rng.int(0, 2))}</${el}>\n{% include "footer" %}\n`;
  t.index = `{% include "head" %}\n{% include "header" %}\n<${el} class="${c}-index">\n{% for p in posts %}\n{% include "card" %}\n{% endfor %}\n{% if not posts %}\n<p>Nothing here yet.</p>\n{% endif %}\n{% include "pager" %}\n</${el}>\n{% include "footer" %}\n`;
  t.tag = `{% include "head" %}\n{% include "header" %}\n<${el} class="${c}-tag">\n<h1>{{ tag.name }} <small>{{ tag.count }} post{% if tag.posts %}s{% endif %}</small></h1>\n{% for p in tag.posts %}\n{% include "card" %}\n{% endfor %}\n</${el}>\n{% include "footer" %}\n`;
  t.tags = `{% include "head" %}\n{% include "header" %}\n<${el} class="${c}-tags-index">\n<ul>\n{% for t in tags %}\n${ind}<li><a href="{{ t.url }}">{{ t.name }}</a> <span>{{ t.count }}</span></li>\n{% endfor %}\n</ul>\n</${el}>\n{% include "footer" %}\n`;
  if (rng.chance(0.3)) t.wide = t.page.replace(`${c}-page`, `${c}-wide`);
  return t;
}

// ---------------------------------------------------------------- the site

/** What a refused source's front matter gets wrong, one drawn per refused source. */
const REFUSALS = [
  (lines) => lines.splice(1, 0, `author: ${'someone'}`),
  (lines) => lines.splice(1, 0, lines[1]),
  (lines) => lines.splice(1, 0, 'date: 2026-02-30'),
  (lines) => lines.splice(1, 0, 'date: 2025-13-01'),
  (lines) => lines.splice(1, 0, 'date: 26-11-19'),
  (lines) => lines.splice(lines.findIndex((l) => l.startsWith('title')), 1),
  (lines) => lines.splice(1, 0, 'tags: [one, "two"]'),
  (lines) => lines.splice(1, 0, 'tags: one, two'),
  (lines) => lines.splice(1, 0, 'draft: yes'),
  (lines) => lines.splice(1, 0, 'title: "an unclosed quote'),
  (lines) => lines.splice(1, 0, 'layout: no-such-layout'),
  (lines) => lines.splice(1, 0, 'Title: Capitalised'),
  (lines) => lines.splice(1, 0, 'slug: Not A Slug'),
  (lines) => lines.splice(1, 0, 'summary:'),
  (lines) => {
    const at = lines.findIndex((l) => l.startsWith('date: '));
    if (at !== -1) lines.splice(at, 1);
  },
];

/** One site for makefun-site to build (the header). */
export function generate(rng, index) {
  const [lo, hi] = SIZE_BANDS[index % SIZE_BANDS.length];
  const nSources = rng.int(lo, hi);
  const templates = templatesOf(rng);
  const layouts = Object.hasOwn(templates, 'wide') ? ['wide'] : [];
  const host = `${rng.pick(WORDS)}-${rng.pick(WORDS)}`.replace(/[^a-z-]/g, '');
  const site = {
    title: `${cap(rng.pick(WORDS))} ${cap(rng.pick(WORDS))}${rng.chance(0.2) ? ' & Co.' : ''}`,
    base_url: `https://${host}.example${rng.chance(0.3) ? '/blog' : ''}${rng.chance(0.3) ? '/' : ''}`,
    per_page: rng.int(5, 15),
    recent: rng.int(3, 6),
  };
  // The sources' paths and titles first, so bodies can link to any of them.
  const metas = [];
  const usedPaths = new Set();
  for (let k = 0; k < nSources; k++) {
    const post = rng.chance(0.7);
    const unicode = rng.chance(0.05);
    const collide = metas.length > 0 && rng.chance(0.05);
    const title = collide ? respell(rng, rng.pick(metas).title) : titleOf(rng, unicode);
    const dir = post ? `posts/${rng.int(2018, 2026)}` : rng.pick(PAGE_DIRS);
    let file = `${words(rng, rng.int(1, 3)).join('-').replace(/[^a-z0-9-]/g, 'x')}.md`;
    let path = dir === '' ? file : `${dir}/${file}`;
    for (let n = 2; usedPaths.has(path); n++) {
      file = file.replace(/(?:-\d+)?\.md$/, `-${n}.md`);
      path = dir === '' ? file : `${dir}/${file}`;
    }
    usedPaths.add(path);
    metas.push({ path, title, post });
  }
  const statics = ['assets/style.css', 'robots.txt', ...Array.from({ length: rng.int(1, 6) }, (_, k) => `assets/img/${rng.pick(WORDS)}-${k + 1}.svg`)];
  const files = [];
  for (const [k, m] of metas.entries()) {
    const targets = [
      ...Array.from({ length: 4 }, () => relativeLink(m.path, rng.pick(metas).path)),
      `${relativeLink(m.path, rng.pick(metas).path)}#${rng.pick(WORDS)}`,
      relativeLink(m.path, rng.pick(statics)),
      `${relativeLink(m.path, 'missing')}/${rng.pick(WORDS)}.md`,
      `https://${rng.pick(WORDS)}.example/${rng.pick(WORDS)}?q=${rng.pick(WORDS)}&n=${rng.int(1, 9)}`,
      `mailto:${rng.pick(WORDS)}@example.com`,
      `#${rng.pick(WORDS)}`,
      `/${rng.pick(WORDS)}/`,
    ];
    const lines = ['---'];
    if (rng.chance(0.1)) lines.push(`# ${words(rng, 3).join(' ')}`);
    lines.push(titleLine(rng, m.title));
    if (m.post || rng.chance(0.1)) lines.push(`date: ${dateOf(rng)}`);
    if (m.post ? rng.chance(0.85) : rng.chance(0.2)) {
      const tags = Array.from({ length: rng.int(0, 5) }, () => rng.pick(TAG_NAMES));
      lines.push(`tags: [${tags.join(rng.pick([', ', ',', ' , ']))}]`);
    }
    if (rng.chance(0.1)) lines.push('draft: true');
    else if (rng.chance(0.05)) lines.push('draft: false');
    if (rng.chance(0.05)) lines.push(`slug: ${words(rng, 2).join('-').replace(/[^a-z0-9-]/g, 'x')}`);
    if (rng.chance(0.25)) lines.push(`summary: ${sentence(rng, ['#x']).replace(/^["[]/, '')}`);
    if (layouts.length > 0 && !m.post && rng.chance(0.3)) lines.push(`layout: ${layouts[0]}`);
    if (rng.chance(0.08)) lines.splice(rng.int(1, lines.length), 0, '');
    if (rng.chance(0.04)) rng.pick(REFUSALS)(lines);
    lines.push('---');
    let content = `${lines.join('\n')}\n${rng.chance(0.3) ? '\n' : ''}${bodyOf(rng, targets, rng.int(900, 3800))}\n`;
    if (rng.chance(0.01)) content = content.replace(/^---\n/, '');
    if (rng.chance(0.05)) content = content.replace(/\n/g, '\r\n');
    files.push({ path: m.path, content });
    if (k === 0) files.push({ path: 'assets/style.css', content: `body { font-family: system-ui; }\n.${templates.head.match(/class="([^"]+)"/)?.[1] ?? 'site'} a { color: #${rng.int(0, 0xffffff).toString(16).padStart(6, '0')}; }\n` });
  }
  files.push({ path: 'robots.txt', content: `User-agent: *\nSitemap: ${site.base_url}sitemap.xml\n` });
  for (const p of statics.slice(2)) files.push({ path: p, content: `<svg xmlns="http://www.w3.org/2000/svg" width="${rng.int(8, 64)}" height="${rng.int(8, 64)}"></svg>\n` });
  // The order the files are handed in is drawn too: a build sorts them itself.
  for (let k = files.length - 1; k > 0; k--) {
    const j = rng.int(0, k);
    [files[k], files[j]] = [files[j], files[k]];
  }
  return { site, templates, files };
}
