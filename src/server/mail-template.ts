import { kindNames, type BriefContent, type Kind } from './types.ts';
import { dateLabel, localDate } from './periods.ts';
import { orderedSources, sourceName } from './source-presentation.ts';
import { editionCalendar, sectionGroups, dailySections, weekday } from './brief-presentation.ts';
import { displayRating } from './editorial.ts';
function stars(value: number) {
  const rating = displayRating(value);
  const icons = Array.from({ length: 5 }, (_, i) => {
    const fill = Math.max(0, Math.min(1, rating - i));
    return `<span style="display:inline-block;position:relative;width:14px;color:#233c53;">☆<span style="position:absolute;left:0;top:0;display:inline-block;overflow:hidden;white-space:nowrap;width:${fill * 100}%;">★</span></span>`;
  }).join('');
  return `<span aria-label="${rating}分，满分5分" style="font-size:13px;white-space:nowrap;">${icons}</span>`;
}
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
type Industry = { id: string; name: string; sections: string[] };
export type EmailEdition = {
  kind?: Kind;
  date?: string;
  issueNumber?: number | null;
  industries?: Industry[];
};
const font =
  "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','HarmonyOS Sans SC','Microsoft YaHei',sans-serif";
const muted = '#626967';
const table = (body: string, extra = '') =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;table-layout:fixed;${extra}">${body}</table>`;
const paragraph = (text: string, style = '') => `<p style="margin:0;${style}">${text}</p>`;
function summary(item: BriefContent['items'][number]) {
  const phrases = item.emphasis?.filter((phrase) => phrase && item.summary.includes(phrase)) ?? [];
  if (!phrases.length) return escapeHtml(item.summary);
  const pattern = new RegExp(
    `(${phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'g',
  );
  return item.summary
    .split(pattern)
    .map((part) =>
      phrases.includes(part)
        ? `<strong style="font-weight:700;color:#2b3033">${escapeHtml(part)}</strong>`
        : escapeHtml(part),
    )
    .join('');
}
export function renderEmail(
  content: BriefContent,
  issueUrl: string,
  cancelUrl: string,
  edition: EmailEdition = {},
) {
  const kind = edition.kind ?? 'daily';
  const daily = kind === 'daily';
  const aiDaily = content.format === 'ai-daily-v1';
  const monthly = kind === 'monthly';
  const review = kind === 'weekly' && content.format === 'weekly-review-v1';
  const date = edition.date ?? localDate(new Date(content.rangeEnd));
  const accent = '#233c53';
  const mark = editionCalendar(kind, date, content);
  const known = edition.industries ?? [];
  const ids = [
    ...new Set([
      ...known.map((i) => i.id),
      ...Object.keys(content.overview),
      ...content.items.map((i) => i.industryId),
    ]),
  ];
  const domains = ids
    .map(
      (id) =>
        known.find((i) => i.id === id) ?? {
          id,
          name: id === 'finance' ? '金融' : id === 'ai' ? 'AI' : id,
          sections: [
            ...new Set(content.items.filter((i) => i.industryId === id).map((i) => i.section)),
          ],
        },
    )
    .filter(
      (i) => content.overview[i.id] || content.items.some((item) => item.industryId === i.id),
    );
  const issue = edition.issueNumber ? `第${String(edition.issueNumber).padStart(3, '0')}期` : '';
  const label = daily ? '数智参阅' : `数智参阅·${kindNames[kind]}`;
  const title = `<h1 class="email-title" style="margin:0;font:700 32px/1.55 ${font};color:${accent};letter-spacing:.5px">${escapeHtml(content.title)}</h1>`;
  const calendar = `${paragraph(mark.top, 'font-size:12px;')}${paragraph(mark.number, `font:900 56px/1.1 'Arial Black','Helvetica Neue',Arial,sans-serif;color:${accent};`)}${mark.detail ? paragraph(mark.detail, 'font-size:13px;margin-top:6px;') : ''}`;
  const masthead = daily
    ? table(
        `<tr><td colspan="3" style="padding:12px 0 22px;">${title}</td></tr><tr><td width="33%" align="left" valign="middle" style="padding:0 8px 20px 0;font-size:12px;color:${muted};">${escapeHtml(dateLabel(date))}　${weekday(date).replace('周', '星期')}</td><td width="34%" align="center" valign="middle" style="padding:0 4px 20px;font-size:12px;color:${muted};">《${escapeHtml(label)}》${issue}</td><td width="33%" align="right" valign="middle" style="padding:0 0 20px 8px;font-size:12px;color:${muted};">主办：数智化转型办公室 AI工作组</td></tr>`,
        `border-bottom:3px double ${accent};`,
      )
    : table(
        `<tr><td class="email-heading" valign="middle" style="padding:12px 24px 24px 0;">${title}</td><td class="email-calendar" width="130" align="center" valign="middle" style="width:130px;padding:12px 0 24px;color:${muted}">${calendar}${paragraph(`《${escapeHtml(label)}》${issue}`, 'font-size:13px;margin-top:6px;')}</td></tr>`,
        `border-bottom:3px double ${accent};`,
      );
  const overviews = domains.filter((i) => content.overview[i.id]);
  const overviewCells = overviews.map(
    (industry) =>
      `<td class="email-stack" valign="top" style="padding:0 12px 12px;">${paragraph(escapeHtml(industry.name) + (daily || review ? '' : '观察'), `color:${accent};font-size:14px;font-weight:700;margin-bottom:7px;`)}${paragraph(escapeHtml(content.overview[industry.id]), 'font-size:15px;line-height:1.95;color:#4b5053;')}</td>`,
  );
  const overview = aiDaily
    ? (content.highlights?.length
        ? `<div style="background:#eeede6;padding:22px 24px;margin:28px 0 40px;"><h2 style="margin:0 0 12px;font-size:15px;color:${accent}">${escapeHtml(content.highlightsTitle ?? '今日要览')}</h2>${table(content.highlights.map((h) => `<tr><td valign="top" style="padding:5px 12px 5px 0;font-size:14px;line-height:1.8;">${escapeHtml(h.text)}</td><td width="76" align="right" valign="top" style="width:76px;padding:5px 0;">${stars(h.rating)}</td></tr>`).join(''))}</div>`
        : '') + (content.note ? paragraph(escapeHtml(content.note), 'margin:24px 0;') : '')
    : `<div style="background:#eeece5;padding:20px 10px 10px;margin:22px 0 28px;">${table(monthly ? overviewCells.map((cell) => `<tr>${cell}</tr>`).join('') : `<tr>${overviewCells.join('')}</tr>`)}</div>`;
  function story(item: BriefContent['items'][number], lead: boolean) {
    const sources = orderedSources(item.sources)
      .map(
        (s) =>
          `<a href="${escapeHtml(s.url)}" style="color:${accent};text-decoration:underline;text-underline-offset:3px;">${escapeHtml(sourceName(s.name))}</a>`,
      )
      .join(' / ');
    const progress =
      review && item.progress?.length
        ? `<div style="margin:18px 0 0;"><p style="margin:0 0 8px;font-size:13px;font-weight:700;color:${accent};">本周进展</p>${table(item.progress.map((node) => `<tr><td width="64" valign="top" style="width:64px;padding:7px 12px 7px 0;color:${muted};font-size:12px;">${escapeHtml(node.date.slice(5).replace('-', '.'))}${node.endDate ? `<br>—${escapeHtml(node.endDate.slice(5).replace('-', '.'))}` : ''}<br>报道</td><td valign="top" style="padding:7px 0;font-size:14px;line-height:1.9;color:#4b5053;">${escapeHtml(node.text)}${paragraph(node.sourceUrls.map((url, i) => `<a href="${escapeHtml(url)}" style="color:${accent};font-size:12px;">依据${i + 1}</a>`).join('　'), 'margin-top:3px;')}</td></tr>`).join(''))}</div>`
        : '';
    const heading = `<h3 style="margin:0;font:600 ${aiDaily ? '21' : lead ? '23' : '19'}px/1.6 ${font};color:${aiDaily ? '#2b3033' : lead ? accent : '#2b3033'};">${escapeHtml(item.title)}</h3>`;
    const rating = item.rating !== undefined ? stars(item.rating) : '';
    const storyHeading = aiDaily
      ? table(
          `<tr><td class="email-story-heading" valign="top" style="padding-right:12px;">${heading}</td>${rating ? `<td class="email-story-rating" width="76" valign="top" align="right" style="width:76px;padding-top:3px;">${rating}</td>` : ''}</tr>`,
        )
      : heading + rating;
    return `<div style="padding:24px 0;">${storyHeading}${paragraph(summary(item), 'margin-top:10px;font-size:15px;line-height:1.95;color:#4b5053;')}${progress}${paragraph(sources, `font-size:12px;line-height:1.8;color:${muted};margin-top:12px;`)}</div>`;
  }
  function pair(items: BriefContent['items']) {
    return table(
      `<tr>${items.map((item, index) => `<td class="email-stack" width="50%" valign="top" style="width:50%;padding:${index ? '0 0 0 16px' : '0 16px 0 0'};">${story(item, false)}</td>`).join('')}</tr>`,
      'border-top:1px solid #d7d6cf;',
    );
  }
  const renderGroup = (group: { name: string; items: BriefContent['items'] }) => {
    const entries = group.items;
    let body = story(entries[0], true);
    if (aiDaily) {
      body += entries
        .slice(1)
        .map((item) => `<div style="border-top:1px solid #d7d6cf;">${story(item, false)}</div>`)
        .join('');
    } else if (daily) {
      if (entries.length > 1) body += pair(entries.slice(1, 3));
      body += entries
        .slice(3)
        .map((item) => `<div style="border-top:1px solid #d7d6cf;">${story(item, false)}</div>`)
        .join('');
    } else if (monthly) {
      for (let i = 1; i < entries.length; i += 2) body += pair(entries.slice(i, i + 2));
    } else
      body += entries
        .slice(1)
        .map((item) => `<div style="border-top:1px solid #d7d6cf;">${story(item, false)}</div>`)
        .join('');
    return `<div style="margin-top:40px;">${paragraph(escapeHtml(group.name), `font-size:17px;font-weight:600;color:${accent};padding-bottom:12px;border-bottom:1px solid #d7d6cf;`)}${body}</div>`;
  };
  const chapters = domains
    .map((industry) => {
      const items = content.items.filter((i) => i.industryId === industry.id);
      if (!items.length) return '';
      const stories = sectionGroups(items, industry.sections).map(renderGroup).join('');
      return `<div style="margin:30px 0;">${aiDaily ? '' : table(`<tr><td style="padding-bottom:14px;"><h2 style="margin:0;color:${accent};font-size:22px;line-height:1.5;">${escapeHtml(industry.name)}要情</h2>${paragraph(escapeHtml(industry.sections.join(' / ')), `font-size:12px;color:${muted};margin-top:5px;`)}</td><td width="65" align="right" style="width:65px;color:${muted};font-size:12px;">${daily ? '本版' : ''}${items.length}条</td></tr>`, `border-bottom:1px solid ${accent};`)}${stories}</div>`;
    })
    .join('');
  const renderRotation = (r: NonNullable<BriefContent['rotations']>[number]) =>
    `<div style="margin:30px 0;"><h2 style="font-size:20px;color:${accent};">${escapeHtml(r.displayName ?? r.name)}</h2>${paragraph(escapeHtml(r.text).replace(/\n/g, '<br>'), 'line-height:2;')}${paragraph(r.sources.map((source) => `<a href="${escapeHtml(source.url)}" style="color:${accent}">${escapeHtml(source.name)}</a>`).join(' / '), 'margin-top:12px;font-size:12px;')}</div>`;
  const rotationMarkup = (content.rotations ?? []).map(renderRotation).join('');
  const bodySections = aiDaily
    ? dailySections(content)
        .map((group) => (group.kind === 'fixed' ? renderGroup(group) : renderRotation(group)))
        .join('')
    : chapters + rotationMarkup;
  const timeline =
    daily || review
      ? ''
      : `<div style="margin:30px 0;"><h2 style="margin:0 0 14px;padding-bottom:10px;border-bottom:1px solid ${accent};font-size:20px;color:${accent};">${monthly ? '月内时间轴' : '一周进程'}</h2>${table(
          content.items
            .map((item) => ({
              item,
              day: item.sources
                .map((s) =>
                  s.publishedAt.length === 10 ? s.publishedAt : localDate(new Date(s.publishedAt)),
                )
                .sort()[0],
            }))
            .sort((a, b) => a.day.localeCompare(b.day))
            .map(
              ({ item, day }) =>
                `<tr><td width="55" valign="top" style="width:55px;padding:9px 0;color:${accent};font-size:13px;">${day.slice(5).replace('-', '.')}</td><td style="padding:9px 0;font-size:13px;">${escapeHtml(item.title)}</td></tr>`,
            )
            .join(''),
        )}</div>`;
  const footer = table(
    `<tr><td align="center" style="padding:20px 0;color:${muted};font-size:12px;">本期完</td></tr>`,
    `border-top:3px double ${accent};`,
  ).replace('<table ', '<table class="email-footer" ');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.title)}</title><style>@media(max-width:600px){.email-story-heading,.email-story-rating{display:block!important;width:100%!important;padding-right:0!important;text-align:left!important}.email-story-rating{padding-top:6px!important}.email-footer td{font-size:10px!important;padding:12px 0!important}.email-paper{padding:20px 12px!important}.email-title{font-size:26px!important}.email-heading{display:block!important;width:100%!important;padding-right:0!important}.email-calendar{display:none!important}.email-date-compact{display:block!important}.email-stack{display:block!important;width:100%!important;box-sizing:border-box!important;padding-left:0!important;padding-right:0!important}}</style></head><body style="margin:0;padding:0;background:#f7f5ef;color:#2b3033;font:15px/1.9 ${font};">${table(`<tr><td align="center"><table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:960px;margin:0 auto;border-collapse:collapse;table-layout:fixed;"><tr><td class="email-paper" style="padding:28px 28px;overflow-wrap:break-word;word-wrap:break-word;">${masthead}${overview}${bodySections}${timeline}${paragraph(`<a href="${escapeHtml(issueUrl)}" style="color:${accent};text-decoration:underline;">网页阅读</a>　<a href="${escapeHtml(cancelUrl)}" style="color:${accent};text-decoration:underline;">取消订阅</a>`, 'margin:24px 0 18px;font-size:12px;')}${footer}</td></tr></table></td></tr>`)}</body></html>`;
}
