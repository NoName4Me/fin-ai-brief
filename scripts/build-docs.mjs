import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { Marked } from 'marked';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'docs-site');
const outputFile = path.join(outputDir, 'index.html');
const reviewed = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const documentConfig = [
  {
    id: 'home',
    file: 'docs/README.md',
    nav: '文档导航',
    audience: '所有人',
    summary: '按目标和故障场景进入项目文档。',
  },
  {
    id: 'architecture',
    file: 'docs/architecture.md',
    nav: '架构与边界',
    audience: '开发 · 运维',
    summary: '系统组件、内容主链路、业务规则和生产拓扑。',
  },
  {
    id: 'mail-delivery',
    file: 'docs/mail-delivery.md',
    nav: '邮件推送',
    audience: '运维 · 值班',
    summary: '自动投递、手动推送、单条重推、SMTP 复用与故障恢复。',
  },
  {
    id: 'model-runtime',
    file: 'docs/model-runtime.md',
    nav: '模型运行',
    audience: '开发 · 运维',
    summary: '模型主备路由、健康隔离、恢复探测和三层重试。',
  },
  {
    id: 'deployment',
    file: 'docs/deployment.md',
    nav: '部署运维',
    audience: '运维',
    summary: '本地打包、服务器部署、日常更新、备份与灾难恢复。',
  },
  {
    id: 'sources',
    file: 'docs/sources.md',
    nav: '信源入口',
    audience: '编辑 · 开发',
    summary: '信源生命周期、采集节奏和当前入口清单。',
  },
  {
    id: 'project',
    file: 'README.md',
    nav: '项目说明',
    audience: '开发',
    summary: '本地运行、常用命令、管理入口与订阅行为。',
  },
  {
    id: 'glossary',
    file: 'GLOSSARY.md',
    nav: '术语',
    audience: '所有人',
    summary: '内容、编辑和运行流程中的固定术语。',
  },
];

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function slugify(value) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

function docHash(docId, section = '') {
  return section ? `#${docId}/${encodeURIComponent(section)}` : `#${docId}`;
}

const marked = new Marked({
  gfm: true,
  breaks: false,
});
const documents = [];
const documentByFile = new Map(documentConfig.map((config) => [config.file, config]));

for (const config of documentConfig) {
  const markdown = await readFile(path.join(root, config.file), 'utf8');
  const html = await marked.parse(markdown);
  const $ = cheerio.load(`<main id="document-root">${html}</main>`, null, false);
  const rootNode = $('#document-root');
  const seen = new Map();
  const toc = [];

  rootNode.find('h1,h2,h3').each((_, element) => {
    const heading = $(element);
    const text = heading.text().replace(/\s+/g, ' ').trim();
    const base = slugify(text) || 'section';
    const count = seen.get(base) ?? 0;
    const id = count ? `${base}-${count}` : base;
    seen.set(base, count + 1);
    heading.attr('id', id);
    heading.append(
      `<a class="heading-link" aria-label="复制“${escapeHtml(text)}”的链接" href="${docHash(
        config.id,
        id,
      )}">#</a>`,
    );
    if (element.tagName !== 'h1') toc.push({ id, text, level: Number(element.tagName.slice(1)) });
  });

  const document = {
    ...config,
    html: '',
    text: '',
    toc,
    title: rootNode.find('h1').first().text().replace(/#$/, '').trim() || config.nav,
  };
  documents.push(document);

  rootNode.find('pre > code.language-mermaid').each((index, element) => {
    const code = $(element).text();
    const title = `${document.title}流程图 ${index + 1}`;
    $(element)
      .parent()
      .replaceWith(
        `<figure class="diagram-frame">
          <div class="diagram-scroll">
            <pre class="mermaid" role="img" aria-label="${escapeHtml(title)}">${escapeHtml(code)}</pre>
          </div>
          <figcaption>流程与状态关系图</figcaption>
        </figure>`,
      );
  });

  rootNode.find('pre').each((_, element) => {
    const pre = $(element);
    if (pre.is('.mermaid') || pre.find('.mermaid').length) return;
    const language =
      pre
        .find('code')
        .attr('class')
        ?.match(/language-([\w-]+)/)?.[1] ?? '命令';
    const frame = $('<div class="code-frame"></div>');
    pre.wrap(frame);
    frame.append(
      `<button class="copy-code" type="button" data-language="${escapeHtml(language)}">复制</button>`,
    );
  });

  if (document.id === 'sources') {
    const table = rootNode.find('table').first();
    const rows = table.find('tbody tr');
    table.addClass('source-table');
    table.attr('data-source-table', '');
    table.wrap('<div class="source-table-shell"></div>');
    rootNode.find('.source-table-shell')
      .before(`<section class="source-tools" aria-label="筛选信源">
        <div class="source-tools-heading">
          <strong>入口清单</strong>
          <span id="source-count">${rows.length} 个信源</span>
        </div>
        <div class="source-filters">
          <label class="filter-field filter-search">
            <span class="sr-only">搜索信源</span>
            <input id="source-search" type="search" placeholder="搜索名称或域名" autocomplete="off">
          </label>
          <label class="filter-field">
            <span>状态</span>
            <select id="source-status">
              <option value="">全部</option>
              <option value="启用">启用</option>
              <option value="暂停">暂停</option>
            </select>
          </label>
          <label class="filter-field">
            <span>采集方式</span>
            <select id="source-format">
              <option value="">全部</option>
              <option value="RSS">RSS</option>
              <option value="JSON">JSON</option>
              <option value="网页">网页</option>
              <option value="手动">手动</option>
            </select>
          </label>
        </div>
      </section>`);
  }

  document.html = rootNode.html();
  document.text = rootNode.text().replace(/\s+/g, ' ').trim();
}

for (const document of documents) {
  const $ = cheerio.load(`<main>${document.html}</main>`, null, false);
  $('a[href]').each((_, element) => {
    const link = $(element);
    const href = link.attr('href');
    if (!href) return;
    if (link.hasClass('heading-link')) return;
    if (href.startsWith('#')) {
      link.attr('href', docHash(document.id, decodeURIComponent(href.slice(1))));
      return;
    }
    if (/^(?:https?:|mailto:)/i.test(href)) {
      link.attr('target', '_blank');
      link.attr('rel', 'noreferrer');
      return;
    }
    const [filePart, hashPart = ''] = href.split('#', 2);
    if (!filePart.endsWith('.md')) {
      console.warn(`未处理文档链接：${document.file} -> ${href}`);
      return;
    }
    const resolved = filePart.startsWith('/')
      ? filePart.slice(1)
      : path.posix.normalize(path.posix.join(path.posix.dirname(document.file), filePart));
    const target = documentByFile.get(resolved);
    if (!target) {
      console.warn(`未找到文档链接目标：${document.file} -> ${href}`);
      return;
    }
    link.attr('href', docHash(target.id, hashPart ? decodeURIComponent(hashPart) : ''));
  });
  document.html = $('main').html();
}

const searchSections = [];
for (const document of documents) {
  const $ = cheerio.load(`<main>${document.html}</main>`, null, false);
  const headings = $('h2,h3').toArray();
  const introParts = [];
  for (const node of $('main').contents().toArray()) {
    if (node.type === 'tag' && /^h[1-3]$/.test(node.name)) break;
    if (node.type === 'text' || node.type === 'tag') {
      const clone = $(node).clone();
      clone.find('.heading-link').remove();
      introParts.push(clone.text());
    }
  }
  const intro = introParts.join(' ').replace(/\s+/g, ' ').trim();
  if (intro) {
    searchSections.push({
      doc: document.id,
      docTitle: document.title,
      section: '',
      heading: document.title,
      text: intro,
    });
  }
  for (const heading of headings) {
    const parts = [$(heading).clone().children('.heading-link').remove().end().text()];
    let next = heading.next;
    while (next) {
      if (next.type === 'tag' && /^h[23]$/.test(next.name)) break;
      if (next.type === 'text' || next.type === 'tag') parts.push($(next).text());
      next = next.next;
    }
    searchSections.push({
      doc: document.id,
      docTitle: document.title,
      section: $(heading).attr('id'),
      heading: $(heading).clone().children('.heading-link').remove().end().text().trim(),
      text: parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 6000),
    });
  }
}

const tabs = documents
  .map(
    (document) => `<button class="doc-tab" type="button" role="tab" id="tab-${document.id}"
      aria-controls="panel-${document.id}" aria-selected="${document.id === 'home'}"
      data-doc="${document.id}">${escapeHtml(document.nav)}</button>`,
  )
  .join('');

const sidebarLinks = documents
  .map(
    (document) => `<button class="sidebar-link" type="button" data-doc="${document.id}">
      <span>${escapeHtml(document.nav)}</span>
      <small>${escapeHtml(document.audience)}</small>
    </button>`,
  )
  .join('');

const panels = documents
  .map(
    (document) => `<section class="doc-panel" id="panel-${document.id}" role="tabpanel"
      aria-labelledby="tab-${document.id}" data-doc="${document.id}" ${document.id === 'home' ? '' : 'hidden'}>
      <header class="doc-header">
        <div class="doc-heading">
          <div class="doc-meta">
            <span>${escapeHtml(document.audience)}</span>
            <span>最后复核 ${reviewed}</span>
          </div>
          <p>${escapeHtml(document.summary)}</p>
        </div>
        <a class="source-link" href="${escapeHtml(path.posix.relative('docs-site', document.file))}">查看 Markdown</a>
      </header>
      <article class="markdown-body">${document.html}</article>
    </section>`,
  )
  .join('');

const searchData = JSON.stringify(searchSections).replaceAll('<', '\\u003c');
const mermaidBundle = (
  await readFile(path.join(root, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8')
).replaceAll('</script', '<\\/script');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#233c53">
  <meta name="description" content="数智参阅项目文档：架构、邮件推送、模型运行、部署、信源和术语。">
  <title>数智参阅 · 项目文档</title>
  <style>
    :root {
      --paper: #f7f5ef;
      --paper-raised: #fdfcf8;
      --wash: #eeece5;
      --ink: #252d32;
      --body: #41494d;
      --muted: #626a6e;
      --blue: #233c53;
      --blue-strong: #172b3d;
      --green: #35634f;
      --green-soft: #e4ede7;
      --line: #d6d4cb;
      --line-strong: #b9b9b2;
      --danger: #9c3d35;
      --warning: #8a641e;
      --focus: #35634f;
      --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif;
      --serif: "Songti SC", "STSong", "Noto Serif CJK SC", Georgia, serif;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      --header: 72px;
      --tabs: 50px;
      --sidebar: 264px;
    }
    * { box-sizing: border-box; }
    html {
      scroll-behavior: smooth;
      scroll-padding-top: calc(var(--header) + var(--tabs) + 28px);
    }
    body {
      margin: 0;
      min-width: 320px;
      background: var(--paper);
      color: var(--body);
      font: 15px/1.78 var(--sans);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0 0 auto;
      height: 3px;
      background: var(--blue);
      z-index: 80;
    }
    ::selection { background: #cbdcd1; color: var(--blue-strong); }
    ::placeholder { color: #626a6e; opacity: 1; }
    * { scrollbar-width: thin; scrollbar-color: #929a9f var(--wash); }
    ::-webkit-scrollbar { width: 9px; height: 9px; }
    ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: var(--wash); }
    ::-webkit-scrollbar-thumb { background: #929a9f; border: 2px solid var(--wash); }
    ::-webkit-scrollbar-thumb:hover { background: var(--blue); }
    [hidden] { display: none !important; }
    a { color: var(--green); text-decoration-thickness: 1px; text-underline-offset: 3px; }
    a:hover { color: var(--blue); }
    button, input, select { font: inherit; color: inherit; }
    button { cursor: pointer; }
    button, a { touch-action: manipulation; }
    button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 3px;
    }
    svg { display: block; max-width: 100%; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .skip-link {
      position: fixed;
      top: 8px;
      left: 12px;
      z-index: 100;
      padding: 9px 14px;
      background: var(--paper-raised);
      color: var(--blue);
      border: 1px solid var(--blue);
      transform: translateY(-160%);
    }
    .skip-link:focus { transform: translateY(0); }
    .masthead {
      position: sticky;
      top: 0;
      z-index: 50;
      height: var(--header);
      background: rgba(247, 245, 239, .96);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(12px);
    }
    .masthead-inner {
      width: min(100%, 1600px);
      height: 100%;
      margin: 0 auto;
      padding: 8px 28px;
      display: flex;
      align-items: center;
      gap: 28px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 13px;
      min-width: 238px;
      color: var(--ink);
      text-decoration: none;
    }
    .brand-mark {
      width: 39px;
      height: 39px;
      display: grid;
      place-items: center;
      background: var(--blue);
      color: #fff;
      font: 700 17px/1 var(--serif);
      letter-spacing: .08em;
    }
    .brand-copy { display: grid; gap: 1px; }
    .brand-copy strong {
      color: var(--blue);
      font: 700 19px/1.3 var(--serif);
      letter-spacing: .08em;
    }
    .brand-copy small {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    .search-wrap {
      position: relative;
      width: min(520px, 48vw);
      margin-left: auto;
    }
    .search-field {
      display: flex;
      align-items: center;
      height: 42px;
      border: 1px solid var(--line-strong);
      background: var(--paper-raised);
    }
    .search-field:focus-within { border-color: var(--blue); box-shadow: inset 0 -2px var(--blue); }
    .search-icon {
      width: 17px;
      height: 17px;
      margin-left: 13px;
      flex: none;
      color: var(--muted);
    }
    .search-field input {
      width: 100%;
      min-width: 0;
      height: 100%;
      padding: 0 12px;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--ink);
      font-size: 14px;
    }
    .search-key {
      margin-right: 10px;
      padding: 1px 6px;
      border: 1px solid var(--line);
      color: var(--muted);
      font: 11px/1.5 var(--mono);
      white-space: nowrap;
    }
    .search-results {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      left: 0;
      z-index: 70;
      max-height: min(66vh, 600px);
      overflow: auto;
      background: var(--paper-raised);
      border: 1px solid var(--line-strong);
      box-shadow: 0 18px 40px rgba(32, 41, 46, .14);
    }
    .search-summary {
      padding: 11px 16px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .search-result {
      display: block;
      width: 100%;
      padding: 13px 16px;
      border: 0;
      border-bottom: 1px solid var(--line);
      background: transparent;
      text-align: left;
    }
    .search-result:hover, .search-result[aria-selected="true"] { background: var(--green-soft); }
    .search-result:last-child { border-bottom: 0; }
    .search-result small {
      display: block;
      margin-bottom: 3px;
      color: var(--green);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .06em;
    }
    .search-result strong { display: block; color: var(--ink); font-size: 14px; }
    .search-result span {
      display: -webkit-box;
      margin-top: 3px;
      overflow: hidden;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.55;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .search-result mark { background: #dce9df; color: var(--blue); }
    .search-empty { padding: 24px 16px; color: var(--muted); text-align: center; }
    .header-action {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 40px;
      padding: 0 12px;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }
    .header-action:hover { border-color: var(--blue); color: var(--blue); }
    .menu-button { display: none; }
    .tabbar {
      position: sticky;
      top: var(--header);
      z-index: 40;
      height: var(--tabs);
      background: var(--paper);
      border-bottom: 1px solid var(--line);
    }
    .tabs {
      width: min(100%, 1600px);
      height: 100%;
      margin: 0 auto;
      padding: 8px 28px;
      display: flex;
      align-items: stretch;
      gap: 25px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .tabs::-webkit-scrollbar { display: none; }
    .doc-tab {
      position: relative;
      flex: none;
      padding: 0 1px;
      border: 0;
      background: transparent;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }
    .doc-tab::after {
      content: "";
      position: absolute;
      right: 0;
      bottom: -1px;
      left: 0;
      height: 2px;
      background: transparent;
    }
    .doc-tab:hover { color: var(--blue); }
    .doc-tab[aria-selected="true"] { color: var(--blue); font-weight: 700; }
    .doc-tab[aria-selected="true"]::after { background: var(--green); }
    .layout {
      width: min(100%, 1600px);
      min-height: calc(100vh - var(--header) - var(--tabs));
      margin: 0 auto;
      padding: 0 28px 72px;
      display: grid;
      grid-template-columns: var(--sidebar) minmax(0, 1fr) 220px;
      gap: 48px;
    }
    .sidebar {
      position: sticky;
      top: calc(var(--header) + var(--tabs));
      align-self: start;
      height: calc(100vh - var(--header) - var(--tabs));
      padding: 30px 22px 32px 0;
      overflow-y: auto;
      border-right: 1px solid var(--line);
    }
    .sidebar-title {
      margin: 0 0 12px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .13em;
      text-transform: uppercase;
    }
    .sidebar-list { display: grid; gap: 2px; }
    .sidebar-link {
      width: 100%;
      padding: 9px 10px 9px 13px;
      border: 0;
      border-left: 2px solid transparent;
      background: transparent;
      text-align: left;
    }
    .sidebar-link span { display: block; color: var(--ink); font-size: 14px; font-weight: 600; }
    .sidebar-link small { display: block; margin-top: 1px; color: var(--muted); font-size: 11px; }
    .sidebar-link:hover { background: var(--wash); }
    .sidebar-link.active { border-left-color: var(--green); background: var(--green-soft); }
    .sidebar-link.active span { color: var(--blue); }
    .section-nav-wrap { margin-top: 30px; }
    .section-nav { display: grid; gap: 1px; }
    .section-nav a {
      display: block;
      padding: 6px 8px 6px 13px;
      border-left: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      text-decoration: none;
    }
    .section-nav a.level-3 { padding-left: 24px; }
    .section-nav a:hover, .section-nav a.active {
      border-left-color: var(--green);
      color: var(--blue);
      background: #f0f2eb;
    }
    .content { min-width: 0; padding-top: 44px; }
    .doc-panel { width: 100%; max-width: 980px; margin: 0 auto; }
    .doc-header {
      margin-bottom: 42px;
      padding-bottom: 26px;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      border-bottom: 1px solid var(--line);
    }
    .doc-heading { max-width: 680px; }
    .doc-meta { display: flex; flex-wrap: wrap; gap: 7px 14px; margin-bottom: 8px; }
    .doc-meta span {
      color: var(--green);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .06em;
    }
    .doc-heading p { margin: 0; color: var(--muted); font-size: 13px; }
    .source-link {
      flex: none;
      color: var(--muted);
      font-size: 12px;
      text-decoration: none;
    }
    .source-link:hover { color: var(--blue); text-decoration: underline; }
    .markdown-body {
      max-width: 78ch;
      color: var(--body);
      font-size: 15.5px;
      line-height: 1.82;
    }
    .markdown-body > :first-child { margin-top: 0; }
    .markdown-body h1 {
      margin: 0 0 26px;
      color: var(--blue);
      font: 700 40px/1.22 var(--serif);
      letter-spacing: -.025em;
      text-wrap: balance;
    }
    .markdown-body h2 {
      position: relative;
      margin: 58px 0 20px;
      padding-top: 17px;
      border-top: 1px solid var(--line);
      color: var(--blue);
      font: 700 26px/1.35 var(--serif);
      letter-spacing: -.015em;
      text-wrap: balance;
    }
    .markdown-body h3 {
      margin: 36px 0 13px;
      color: var(--ink);
      font: 700 19px/1.45 var(--sans);
      text-wrap: balance;
    }
    .heading-link {
      margin-left: 9px;
      color: var(--line-strong);
      font: 400 16px/1 var(--sans);
      text-decoration: none;
      opacity: 0;
      transition: opacity 140ms ease;
    }
    h1:hover > .heading-link, h2:hover > .heading-link, h3:hover > .heading-link,
    .heading-link:focus-visible { opacity: 1; }
    .markdown-body p { margin: 0 0 16px; }
    .markdown-body strong { color: var(--ink); font-weight: 700; }
    .markdown-body a {
      color: var(--green);
      text-decoration-color: #9cb5a6;
    }
    .markdown-body a:hover { color: var(--blue); text-decoration-color: var(--blue); }
    .markdown-body ul, .markdown-body ol { margin: 0 0 18px; padding-left: 1.55em; }
    .markdown-body li { margin: 6px 0; padding-left: .18em; }
    .markdown-body li::marker { color: var(--green); }
    .markdown-body blockquote {
      margin: 24px 0;
      padding: 14px 20px;
      border-left: 3px solid var(--green);
      background: var(--green-soft);
      color: var(--ink);
    }
    .markdown-body blockquote > :last-child { margin-bottom: 0; }
    .markdown-body hr { margin: 34px 0; border: 0; border-top: 1px solid var(--line); }
    .markdown-body code {
      padding: .14em .38em;
      background: #ecebe5;
      color: #304b5f;
      font: .88em/1.5 var(--mono);
      overflow-wrap: anywhere;
    }
    .code-frame {
      position: relative;
      margin: 22px 0 25px;
      background: #1f2e39;
      border: 1px solid #182631;
    }
    .code-frame pre {
      margin: 0;
      padding: 20px 58px 20px 20px;
      overflow: auto;
      color: #edf1ed;
      font: 12.5px/1.75 var(--mono);
      tab-size: 2;
    }
    .code-frame code { padding: 0; background: transparent; color: inherit; font: inherit; }
    .copy-code {
      position: absolute;
      top: 8px;
      right: 8px;
      padding: 5px 8px;
      border: 1px solid #5a6972;
      background: #2b3d49;
      color: #e8ece8;
      font-size: 11px;
    }
    .copy-code:hover { border-color: #b7c6bc; background: #354a57; }
    .copy-code[data-language="mermaid"] { display: none; }
    .markdown-body table {
      width: 100%;
      margin: 22px 0 28px;
      border-collapse: collapse;
      font-size: 13px;
      line-height: 1.6;
    }
    .markdown-body th {
      padding: 10px 12px;
      border: 1px solid var(--line);
      background: #e9e8e1;
      color: var(--blue);
      font-weight: 700;
      text-align: left;
      white-space: nowrap;
    }
    .markdown-body td {
      padding: 10px 12px;
      border: 1px solid var(--line);
      vertical-align: top;
    }
    .markdown-body tbody tr:nth-child(even) { background: #f1f0ea; }
    .markdown-body tbody tr:hover { background: var(--green-soft); }
    .markdown-body td code { white-space: nowrap; }
    .diagram-frame {
      margin: 26px 0 30px;
      padding: 16px;
      border: 1px solid var(--line);
      background: var(--paper-raised);
    }
    .diagram-scroll { overflow: auto; }
    .diagram-frame .mermaid {
      min-width: 560px;
      margin: 0;
      padding: 4px;
      background: transparent;
      color: var(--body);
      font: 13px/1.5 var(--sans);
      text-align: center;
    }
    .diagram-frame .mermaid svg { margin: 0 auto; }
    .diagram-frame figcaption {
      margin-top: 10px;
      padding-top: 9px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 11px;
      text-align: right;
    }
    .diagram-frame.failed .diagram-scroll { background: #f4ece9; }
    .diagram-error { margin-top: 10px; color: var(--danger); font-size: 12px; }
    .source-tools {
      margin: 24px 0 12px;
      padding: 14px;
      border: 1px solid var(--line);
      background: var(--paper-raised);
    }
    .source-tools-heading {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
      color: var(--blue);
      font-size: 12px;
    }
    .source-tools-heading span { color: var(--muted); }
    .source-filters { display: grid; grid-template-columns: minmax(180px, 1fr) auto auto; gap: 8px; }
    .filter-field {
      display: flex;
      align-items: center;
      min-height: 38px;
      border: 1px solid var(--line);
      background: var(--paper);
      color: var(--muted);
      font-size: 12px;
    }
    .filter-field > span:not(.sr-only) { padding-left: 10px; white-space: nowrap; }
    .filter-field input, .filter-field select {
      width: 100%;
      min-width: 0;
      height: 36px;
      padding: 0 10px;
      border: 0;
      outline: 0;
      background: transparent;
      font-size: 12px;
    }
    .filter-field select { padding-right: 26px; }
    .source-table-shell {
      max-height: 70vh;
      overflow: auto;
      padding: 8px;
      border: 1px solid var(--line);
      background: var(--paper-raised);
    }
    .source-table-shell table { min-width: 920px; margin: 0; border: 0; }
    .source-table-shell thead { position: sticky; top: 0; z-index: 2; }
    .source-table-shell th { border-top: 0; }
    .source-table-shell th:first-child, .source-table-shell td:first-child { border-left: 0; }
    .source-table-shell th:last-child, .source-table-shell td:last-child { border-right: 0; }
    .source-table-shell tbody tr:last-child td { border-bottom: 0; }
    .source-table-shell a { overflow-wrap: anywhere; }
    .outline {
      position: sticky;
      top: calc(var(--header) + var(--tabs) + 34px);
      align-self: start;
      padding-top: 44px;
    }
    .outline-title {
      margin: 0 0 12px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .outline nav { display: grid; gap: 2px; }
    .outline a {
      display: block;
      padding: 5px 0 5px 12px;
      border-left: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      text-decoration: none;
    }
    .outline a.level-3 { padding-left: 23px; }
    .outline a:hover, .outline a.active { border-left-color: var(--green); color: var(--blue); }
    .site-footer {
      width: min(100%, 1600px);
      margin: 0 auto;
      padding: 22px 28px 34px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 11px;
      display: flex;
      justify-content: space-between;
      gap: 20px;
    }
    .toast {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 90;
      padding: 10px 14px;
      background: var(--blue);
      color: #fff;
      font-size: 12px;
      box-shadow: 0 12px 30px rgba(24, 37, 47, .2);
      transform: translateY(16px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .drawer-backdrop { display: none; }
    @media (max-width: 1220px) {
      .layout { grid-template-columns: 235px minmax(0, 1fr); gap: 38px; }
      .outline { display: none; }
      :root { --sidebar: 235px; }
    }
    @media (max-width: 920px) {
      :root { --header: 68px; }
      .masthead-inner { padding: 0 18px; gap: 14px; }
      .brand { min-width: 0; }
      .brand-copy small { display: none; }
      .header-action { display: none; }
      .menu-button { display: inline-flex; }
      .search-wrap { width: auto; flex: 1; }
      .tabs { padding: 8px 18px; gap: 21px; }
      .layout { display: block; padding: 0 24px 60px; }
      .content { padding-top: 30px; }
      .outline { display: none; }
      .sidebar {
        position: fixed;
        top: calc(var(--header) + var(--tabs));
        bottom: 0;
        left: 0;
        z-index: 60;
        width: min(84vw, 320px);
        height: auto;
        padding: 24px 20px 36px;
        background: var(--paper-raised);
        border-right: 1px solid var(--line-strong);
        box-shadow: 18px 0 40px rgba(30, 39, 44, .16);
        transform: translateX(-104%);
        transition: transform 180ms ease-out;
      }
      body.drawer-open .sidebar { transform: translateX(0); }
      .drawer-backdrop {
        position: fixed;
        inset: calc(var(--header) + var(--tabs)) 0 0;
        z-index: 55;
        display: block;
        background: rgba(25, 34, 39, .28);
        opacity: 0;
        pointer-events: none;
        transition: opacity 180ms ease;
      }
      body.drawer-open .drawer-backdrop { opacity: 1; pointer-events: auto; }
    }
    @media (max-width: 620px) {
      :root { --header: 116px; --tabs: 47px; }
      .masthead { height: var(--header); }
      .masthead-inner {
        height: 100%;
        padding: 10px 14px 9px;
        flex-wrap: wrap;
        align-content: center;
        gap: 8px;
      }
      .brand { width: calc(100% - 50px); }
      .brand-mark { width: 35px; height: 35px; }
      .brand-copy strong { font-size: 17px; }
      .menu-button { order: 2; margin-left: auto; }
      .search-wrap { order: 3; width: 100%; }
      .search-field { height: 37px; }
      .search-key { display: none; }
      .search-results { max-height: 58vh; }
      .tabs { padding: 8px 14px; gap: 18px; }
      .layout { padding: 0 16px 48px; }
      .content { padding-top: 23px; }
      .doc-header { margin-bottom: 30px; align-items: flex-start; flex-direction: column; gap: 10px; }
      .source-link { order: -1; }
      .markdown-body { font-size: 15px; line-height: 1.78; }
      .markdown-body h1 { font-size: 32px; }
      .markdown-body h2 { margin-top: 45px; font-size: 23px; }
      .markdown-body h3 { font-size: 18px; }
      .markdown-body table { display: block; overflow-x: auto; white-space: normal; }
      .diagram-frame { padding: 10px; }
      .diagram-frame .mermaid { min-width: 440px; }
      .diagram-frame::before {
        content: "左右滑动查看完整图";
        display: block;
        margin: -2px 0 8px;
        color: var(--muted);
        font-size: 10px;
        text-align: right;
      }
      .source-filters { grid-template-columns: 1fr 1fr; }
      .filter-search { grid-column: 1 / -1; }
      .site-footer { padding: 20px 16px 30px; flex-direction: column; gap: 4px; }
      .toast { right: 14px; bottom: 14px; left: 14px; text-align: center; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { transition-duration: .01ms !important; }
    }
    @media print {
      body { background: #fff; color: #000; }
      body::before, .masthead, .tabbar, .sidebar, .outline, .doc-header .source-link,
      .site-footer, .copy-code, .heading-link, .source-tools { display: none !important; }
      .layout { display: block; max-width: none; padding: 0; }
      .content { padding: 0; }
      .doc-panel { max-width: none; }
      .doc-panel[hidden] { display: none !important; }
      .markdown-body { max-width: none; font-size: 11pt; }
      .diagram-frame, .code-frame, .markdown-body table { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">跳到正文</a>
  <header class="masthead">
    <div class="masthead-inner">
      <a class="brand" href="#home" aria-label="数智参阅文档首页">
        <span class="brand-mark">智阅</span>
        <span class="brand-copy"><strong>数智参阅</strong><small>Project Documentation</small></span>
      </a>
      <button class="header-action menu-button" id="menu-button" type="button" aria-controls="sidebar" aria-expanded="false">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16"/>
        </svg>
        文档目录
      </button>
      <div class="search-wrap">
        <div class="search-field">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>
          </svg>
          <input id="global-search" type="search" placeholder="搜索流程、状态、命令或术语"
            autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list"
            aria-controls="search-results" aria-expanded="false">
          <kbd class="search-key">⌘ K</kbd>
        </div>
        <div class="search-results" id="search-results" role="listbox" hidden></div>
      </div>
    </div>
  </header>
  <div class="tabbar">
    <nav class="tabs" role="tablist" aria-label="文档分类">${tabs}</nav>
  </div>
  <div class="drawer-backdrop" id="drawer-backdrop"></div>
  <main class="layout" id="main-content">
    <aside class="sidebar" id="sidebar" aria-label="文档目录">
      <p class="sidebar-title">文档</p>
      <nav class="sidebar-list">${sidebarLinks}</nav>
      <div class="section-nav-wrap">
        <p class="sidebar-title">本页目录</p>
        <nav class="section-nav" id="section-nav"></nav>
      </div>
    </aside>
    <div class="content">${panels}</div>
    <aside class="outline" aria-label="当前页小节">
      <p class="outline-title">本页目录</p>
      <nav id="outline-nav"></nav>
    </aside>
  </main>
  <footer class="site-footer">
    <span>数智参阅 · 项目文档</span>
    <span>Markdown 正文 · 离线静态生成 · 复核于 ${reviewed}</span>
  </footer>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script>${mermaidBundle}</script>
  <script>
    const DOCS = ${JSON.stringify(
      documents.map(({ id, nav, title, audience, summary, toc }) => ({
        id,
        nav,
        title,
        audience,
        summary,
        toc,
      })),
    ).replaceAll('<', '\\u003c')};
    const SEARCH_INDEX = ${searchData};
  </script>
  <script>
    (() => {
      const byId = Object.fromEntries(DOCS.map((doc) => [doc.id, doc]));
      const tabs = [...document.querySelectorAll('.doc-tab')];
      const panels = [...document.querySelectorAll('.doc-panel')];
      const sidebarLinks = [...document.querySelectorAll('.sidebar-link')];
      const searchInput = document.querySelector('#global-search');
      const searchResults = document.querySelector('#search-results');
      const sectionNav = document.querySelector('#section-nav');
      const outlineNav = document.querySelector('#outline-nav');
      const menuButton = document.querySelector('#menu-button');
      const backdrop = document.querySelector('#drawer-backdrop');
      const toast = document.querySelector('#toast');
      let activeDoc = 'home';
      let searchMatches = [];
      let selectedMatch = -1;
      let toastTimer;

      const escapeHtml = (value) => value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

      const normalize = (value) => value.toLocaleLowerCase('zh-CN').replace(/\\s+/g, ' ').trim();
      const parseHash = () => {
        const raw = decodeURIComponent(location.hash.slice(1));
        const [docId, ...sectionParts] = raw.split('/');
        return {
          doc: byId[docId] ? docId : 'home',
          section: sectionParts.join('/'),
        };
      };
      const hashFor = (doc, section = '') =>
        section ? '#' + doc + '/' + encodeURIComponent(section) : '#' + doc;
      const closeDrawer = () => {
        document.body.classList.remove('drawer-open');
        menuButton?.setAttribute('aria-expanded', 'false');
      };
      const showToast = (message) => {
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
      };
      const copyText = async (text) => {
        if (navigator.clipboard?.writeText && isSecureContext) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const input = document.createElement('textarea');
        input.value = text;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.append(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw new Error('浏览器未允许复制');
      };

      const renderSectionNav = (doc) => {
        const links = doc.toc.map((item) =>
          '<a class="level-' + item.level + '" href="' + hashFor(doc.id, item.id) + '">' +
          escapeHtml(item.text) + '</a>'
        ).join('');
        sectionNav.innerHTML = links;
        outlineNav.innerHTML = links;
      };

      const observeSections = () => {
        const panel = document.querySelector('#panel-' + activeDoc);
        const links = [...panel.querySelectorAll('.markdown-body h2[id], .markdown-body h3[id]')];
        const allLinks = [...document.querySelectorAll('#section-nav a, #outline-nav a')];
        const setActive = (id) => {
          allLinks.forEach((link) => {
            link.classList.toggle('active', link.getAttribute('href') === hashFor(activeDoc, id));
          });
        };
        let ticking = false;
        const onScroll = () => {
          if (ticking) return;
          ticking = true;
          requestAnimationFrame(() => {
            const top = innerHeight * 0.25;
            let current = links[0];
            for (const heading of links) {
              if (heading.getBoundingClientRect().top <= top) current = heading;
              else break;
            }
            if (current) setActive(current.id);
            ticking = false;
          });
        };
        removeEventListener('scroll', window.__docScrollHandler || (() => {}));
        window.__docScrollHandler = onScroll;
        addEventListener('scroll', onScroll, { passive: true });
        onScroll();
      };

      const activateDoc = (docId, section = '', push = true) => {
        const doc = byId[docId] || byId.home;
        activeDoc = doc.id;
        tabs.forEach((tab) => {
          const active = tab.dataset.doc === activeDoc;
          tab.setAttribute('aria-selected', String(active));
          tab.tabIndex = active ? 0 : -1;
          if (active) tab.scrollIntoView({ block: 'nearest', inline: 'center' });
        });
        panels.forEach((panel) => { panel.hidden = panel.dataset.doc !== activeDoc; });
        sidebarLinks.forEach((link) => link.classList.toggle('active', link.dataset.doc === activeDoc));
        renderSectionNav(doc);
        document.title = doc.title + ' · 数智参阅文档';
        if (push && location.hash !== hashFor(activeDoc, section)) {
          history.pushState(null, '', hashFor(activeDoc, section));
        }
        closeDrawer();
        if (section) {
          requestAnimationFrame(() => {
            const target = document.getElementById(section);
            if (target) target.scrollIntoView({ block: 'start' });
          });
        } else {
          scrollTo({ top: 0, behavior: 'instant' });
        }
        observeSections();
      };

      const snippetFor = (text, terms, query) => {
        const normalized = text.toLocaleLowerCase('zh-CN');
        const first = Math.max(0, Math.min(...terms.map((term) => {
          const position = normalized.indexOf(term);
          return position < 0 ? Infinity : position;
        })));
        const start = Number.isFinite(first) ? Math.max(0, first - 52) : 0;
        let snippet = text.slice(start, start + 190);
        if (start > 0) snippet = '…' + snippet;
        if (start + 190 < text.length) snippet += '…';
        const escaped = escapeHtml(snippet);
        const escapedTerms = terms
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)
          .map((term) => escapeHtml(term).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'));
        if (!escapedTerms.length) return escaped;
        return escaped.replace(new RegExp('(' + escapedTerms.join('|') + ')', 'gi'), '<mark>$1</mark>');
      };

      const runSearch = () => {
        const query = searchInput.value.trim();
        if (!query) {
          searchMatches = [];
          selectedMatch = -1;
          searchResults.hidden = true;
          searchInput.setAttribute('aria-expanded', 'false');
          return;
        }
        const terms = normalize(query).split(' ').filter(Boolean);
        searchMatches = SEARCH_INDEX
          .map((item) => {
            const heading = normalize(item.heading);
            const body = normalize(item.text);
            const docTitle = normalize(item.docTitle);
            const full = heading + ' ' + body + ' ' + docTitle;
            if (!terms.every((term) => full.includes(term))) return null;
            let score = 0;
            for (const term of terms) {
              if (heading.includes(term)) score += 80;
              if (docTitle.includes(term)) score += 30;
              if (body.includes(term)) score += 10;
              if (heading.startsWith(term)) score += 40;
            }
            return { ...item, score };
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score)
          .slice(0, 24);
        selectedMatch = searchMatches.length ? 0 : -1;
        searchResults.innerHTML =
          '<div class="search-summary">' +
          (searchMatches.length ? searchMatches.length + ' 条相关结果 · ↑↓ 选择 · Enter 打开' : '没有找到相关文档') +
          '</div>' +
          (searchMatches.length
            ? searchMatches.map((item, index) =>
                '<button class="search-result" type="button" role="option" data-index="' + index +
                '" aria-selected="' + (index === 0) + '">' +
                '<small>' + escapeHtml(byId[item.doc].nav) + '</small>' +
                '<strong>' + escapeHtml(item.heading) + '</strong>' +
                '<span>' + snippetFor(item.text, terms, query) + '</span></button>'
              ).join('')
            : '<div class="search-empty">试试“认证失败”“模型重试”“恢复”或“SMTP”。</div>');
        searchResults.hidden = false;
        searchInput.setAttribute('aria-expanded', 'true');
      };

      const chooseSearchResult = (index) => {
        const item = searchMatches[index];
        if (!item) return;
        searchInput.value = '';
        searchResults.hidden = true;
        searchInput.setAttribute('aria-expanded', 'false');
        activateDoc(item.doc, item.section || '');
        searchInput.blur();
      };

      const updateSearchSelection = (next) => {
        if (!searchMatches.length) return;
        selectedMatch = (next + searchMatches.length) % searchMatches.length;
        searchResults.querySelectorAll('.search-result').forEach((button, index) => {
          const active = index === selectedMatch;
          button.setAttribute('aria-selected', String(active));
          if (active) button.scrollIntoView({ block: 'nearest' });
        });
      };

      tabs.forEach((tab) => {
        tab.addEventListener('click', () => activateDoc(tab.dataset.doc));
        tab.addEventListener('keydown', (event) => {
          const current = tabs.indexOf(tab);
          let next = current;
          if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
          else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = tabs.length - 1;
          else return;
          event.preventDefault();
          tabs[next].focus();
          activateDoc(tabs[next].dataset.doc);
        });
      });
      sidebarLinks.forEach((link) => {
        link.addEventListener('click', () => activateDoc(link.dataset.doc));
      });
      document.querySelectorAll('.heading-link').forEach((link) => {
        link.addEventListener('click', async (event) => {
          event.preventDefault();
          const url = new URL(link.getAttribute('href'), location.href).href;
          history.replaceState(null, '', link.getAttribute('href'));
          try {
            await copyText(url);
            showToast('已复制本节链接');
          } catch {
            showToast('已定位到本节');
          }
        });
      });
      document.querySelectorAll('.copy-code').forEach((button) => {
        button.addEventListener('click', async () => {
          const codeNode = button.parentElement.querySelector('code');
          const code = codeNode?.textContent ?? '';
          try {
            await copyText(code);
            button.textContent = '已复制';
            showToast('代码已复制');
            setTimeout(() => { button.textContent = '复制'; }, 1300);
          } catch {
            const range = document.createRange();
            if (codeNode) range.selectNodeContents(codeNode);
            const selection = getSelection();
            selection.removeAllRanges();
            if (codeNode) selection.addRange(range);
            showToast('自动复制受限，已选中代码供手动复制');
          }
        });
      });
      menuButton?.addEventListener('click', () => {
        const open = !document.body.classList.contains('drawer-open');
        document.body.classList.toggle('drawer-open', open);
        menuButton.setAttribute('aria-expanded', String(open));
      });
      backdrop.addEventListener('click', closeDrawer);
      addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
          event.preventDefault();
          searchInput.focus();
          searchInput.select();
        } else if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
          event.preventDefault();
          searchInput.focus();
        } else if (event.key === 'Escape') {
          closeDrawer();
          searchResults.hidden = true;
          searchInput.setAttribute('aria-expanded', 'false');
        }
      });
      searchInput.addEventListener('input', runSearch);
      searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim()) runSearch();
      });
      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          updateSearchSelection(selectedMatch + 1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          updateSearchSelection(selectedMatch - 1);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          chooseSearchResult(selectedMatch);
        } else if (event.key === 'Escape') {
          searchResults.hidden = true;
          searchInput.setAttribute('aria-expanded', 'false');
        }
      });
      searchResults.addEventListener('click', (event) => {
        const button = event.target.closest('.search-result');
        if (button) chooseSearchResult(Number(button.dataset.index));
      });
      document.addEventListener('click', (event) => {
        if (!event.target.closest('.search-wrap')) {
          searchResults.hidden = true;
          searchInput.setAttribute('aria-expanded', 'false');
        }
      });
      addEventListener('popstate', () => {
        const state = parseHash();
        activateDoc(state.doc, state.section, false);
      });
      addEventListener('hashchange', () => {
        const state = parseHash();
        activateDoc(state.doc, state.section, false);
      });

      const sourceSearch = document.querySelector('#source-search');
      const sourceStatus = document.querySelector('#source-status');
      const sourceFormat = document.querySelector('#source-format');
      const filterSources = () => {
        const query = normalize(sourceSearch?.value || '');
        const status = sourceStatus?.value || '';
        const format = sourceFormat?.value || '';
        const rows = [...document.querySelectorAll('[data-source-table] tbody tr')];
        let visible = 0;
        rows.forEach((row) => {
          const cells = row.querySelectorAll('td');
          const text = normalize(row.textContent || '');
          const match =
            (!query || text.includes(query)) &&
            (!status || cells[1]?.textContent.trim() === status) &&
            (!format || cells[2]?.textContent.trim() === format);
          row.hidden = !match;
          if (match) visible++;
        });
        const count = document.querySelector('#source-count');
        if (count) count.textContent = visible + ' / ' + rows.length + ' 个信源';
      };
      sourceSearch?.addEventListener('input', filterSources);
      sourceStatus?.addEventListener('change', filterSources);
      sourceFormat?.addEventListener('change', filterSources);

      const initial = parseHash();
      activateDoc(initial.doc, initial.section, false);
      if (initial.section) {
        setTimeout(() => document.getElementById(initial.section)?.scrollIntoView(), 30);
      }
    })();

    addEventListener('DOMContentLoaded', async () => {
      if (!globalThis.mermaid) return;
      globalThis.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
        themeVariables: {
          background: '#fdfcf8',
          primaryColor: '#e4ede7',
          primaryTextColor: '#253038',
          primaryBorderColor: '#35634f',
          lineColor: '#677d72',
          secondaryColor: '#eeece5',
          tertiaryColor: '#f7f5ef',
          clusterBkg: '#f7f5ef',
          clusterBorder: '#b9b9b2',
          noteBkgColor: '#fff5d9',
          noteBorderColor: '#8a641e',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
        }
      });
      const diagrams = [...document.querySelectorAll('.mermaid')];
      for (const [index, diagram] of diagrams.entries()) {
        try {
          const code = diagram.textContent;
          const { svg } = await globalThis.mermaid.render('diagram-' + index, code);
          diagram.innerHTML = svg;
          diagram.removeAttribute('role');
        } catch (error) {
          const frame = diagram.closest('.diagram-frame');
          frame?.classList.add('failed');
          const message = document.createElement('p');
          message.className = 'diagram-error';
          message.textContent = '流程图渲染失败，已保留原始 Mermaid 文本。' +
            (error instanceof Error ? ' ' + error.message : '');
          diagram.after(message);
        }
      }
    });
  </script>
</body>
</html>`;

await mkdir(outputDir, { recursive: true });
await writeFile(outputFile, html);
console.log(
  `文档站已生成：${path.relative(root, outputFile)}（${documents.length} 个文档，${searchSections.length} 个搜索章节）`,
);
