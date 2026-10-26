import { kindNames, type BriefContent, type Kind } from './types.ts';
import { dateLabel, localDate, timeLabel } from './periods.ts';
import { orderedSources, sourceName } from './source-presentation.ts';
import { editionCalendar, sectionGroups, weekday } from './brief-presentation.ts';
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
  const monthly = kind === 'monthly';
  const review = kind === 'weekly' && content.format === 'weekly-review-v1';
  const date = edition.date ?? localDate(new Date(content.rangeEnd));
  const start = localDate(new Date(content.rangeStart));
  const end = localDate(new Date(content.rangeEnd));
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
  const label = `Fin&AI简报·${kindNames[kind]}`;
  const title = `<h1 class="email-title" style="margin:0;font:700 32px/1.55 ${font};color:${accent};letter-spacing:.5px">${escapeHtml(content.title)}</h1>`;
  const calendar = `${paragraph(mark.top, 'font-size:12px;')}${paragraph(mark.number, `font:900 56px/1.1 'Arial Black','Helvetica Neue',Arial,sans-serif;color:${accent};`)}${mark.detail ? paragraph(mark.detail, 'font-size:13px;margin-top:6px;') : ''}`;
  const masthead = table(
    `<tr><td class="email-heading" valign="middle" style="padding:12px 24px 24px 0;">${title}</td><td class="email-calendar" width="130" align="center" valign="middle" style="width:130px;padding:12px 0 24px;color:${muted}">${calendar}${paragraph(issue, 'font-size:13px;margin-top:6px;')}</td></tr>`,
    `border-bottom:3px double ${accent};`,
  );
  const overviews = domains.filter((i) => content.overview[i.id]);
  const overviewCells = overviews.map(
    (industry) =>
      `<td class="email-stack" valign="top" style="padding:0 12px 12px;">${paragraph(escapeHtml(industry.name) + (daily || review ? '' : '观察'), `color:${accent};font-size:14px;font-weight:700;margin-bottom:7px;`)}${paragraph(escapeHtml(content.overview[industry.id]), 'font-size:15px;line-height:1.95;color:#4b5053;')}</td>`,
  );
  const overview = `<div style="background:#eeece5;padding:20px 10px 10px;margin:22px 0 28px;">${table(monthly ? overviewCells.map((cell) => `<tr>${cell}</tr>`).join('') : `<tr>${overviewCells.join('')}</tr>`)}</div>`;
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
    return `<div style="padding:${lead ? '18px 0 22px' : '18px 0'};"><h3 style="margin:0 0 10px;font:700 ${lead ? '23' : '19'}px/1.7 ${font};color:${lead ? accent : '#2b3033'};">${escapeHtml(item.title)}</h3>${paragraph(summary(item), 'font-size:15px;line-height:2;color:#4b5053;')}${progress}${paragraph(sources, `font-size:12px;line-height:1.8;color:${muted};margin-top:12px;`)}</div>`;
  }
  function pair(items: BriefContent['items']) {
    return table(
      `<tr>${items.map((item, index) => `<td class="email-stack" width="50%" valign="top" style="width:50%;padding:${index ? '0 0 0 16px' : '0 16px 0 0'};">${story(item, false)}</td>`).join('')}</tr>`,
      'border-top:1px solid #d7d6cf;',
    );
  }
  const chapters = domains
    .map((industry) => {
      const items = content.items.filter((i) => i.industryId === industry.id);
      if (!items.length) return '';
      const stories = sectionGroups(items, industry.sections)
        .map((group) => {
          const entries = group.items;
          let body = story(entries[0], true);
          if (daily) {
            if (entries.length > 1) body += pair(entries.slice(1, 3));
            body += entries
              .slice(3)
              .map(
                (item) => `<div style="border-top:1px solid #d7d6cf;">${story(item, false)}</div>`,
              )
              .join('');
          } else if (monthly) {
            for (let i = 1; i < entries.length; i += 2) body += pair(entries.slice(i, i + 2));
          } else
            body += entries
              .slice(1)
              .map(
                (item) => `<div style="border-top:1px solid #d7d6cf;">${story(item, false)}</div>`,
              )
              .join('');
          return `<div style="margin-top:22px;">${paragraph(escapeHtml(group.name), `font-size:16px;font-weight:700;color:${accent};`)}${body}</div>`;
        })
        .join('');
      return `<div style="margin:30px 0;">${table(`<tr><td style="padding-bottom:14px;"><h2 style="margin:0;color:${accent};font-size:22px;line-height:1.5;">${escapeHtml(industry.name)}要情</h2>${paragraph(escapeHtml(industry.sections.join(' / ')), `font-size:12px;color:${muted};margin-top:5px;`)}</td><td width="65" align="right" style="width:65px;color:${muted};font-size:12px;">${daily ? '本版' : ''}${items.length}条</td></tr>`, `border-bottom:1px solid ${accent};`)}${stories}</div>`;
    })
    .join('');
  const range = daily
    ? `${dateLabel(content.rangeStart)} ${timeLabel(content.rangeStart)}—${dateLabel(content.rangeEnd)} ${timeLabel(content.rangeEnd)}（北京时间）`
    : `${dateLabel(start)} — ${dateLabel(end)}`;
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
    `<tr><td width="31%" style="width:31%;padding:14px 0;font-size:13px;font-weight:700;color:${accent};white-space:nowrap;">${escapeHtml(label)}</td><td width="10%" align="center" style="width:10%;padding:14px 0;font-size:12px;color:${muted};white-space:nowrap;">本期完</td><td width="59%" align="right" style="width:59%;padding:14px 0;font-size:13px;color:${accent};white-space:nowrap;"><strong style="font-weight:600;">数智化转型办公室·智创组</strong>　<span style="color:${muted};">编制</span></td></tr>`,
    `border-top:1px solid #d7d6cf;border-bottom:3px double ${accent};`,
  ).replace('<table ', '<table class="email-footer" ');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.title)}</title><style>@media(max-width:600px){.email-footer td{font-size:10px!important;padding:12px 0!important}.email-paper{padding:20px 12px!important}.email-title{font-size:26px!important}.email-heading{display:block!important;width:100%!important;padding-right:0!important}.email-calendar{display:none!important}.email-date-compact{display:block!important}.email-stack{display:block!important;width:100%!important;box-sizing:border-box!important;padding-left:0!important;padding-right:0!important}}</style></head><body style="margin:0;padding:0;background:#f7f5ef;color:#2b3033;font:15px/1.9 ${font};">${table(`<tr><td align="center"><table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:1040px;margin:0 auto;border-collapse:collapse;table-layout:fixed;"><tr><td class="email-paper" style="padding:28px 28px;overflow-wrap:break-word;word-wrap:break-word;">${masthead}<div class="email-date-compact" style="display:none;padding:12px 0;color:${muted};font-size:12px;">${escapeHtml(daily ? `${dateLabel(date)}　${weekday(date).replace('周', '星期')}　${issue}` : `${range}　${issue}`)}</div>${overview}${chapters}${timeline}${paragraph(`<a href="${escapeHtml(issueUrl)}" style="color:${accent};text-decoration:underline;">网页阅读</a>　<a href="${escapeHtml(cancelUrl)}" style="color:${accent};text-decoration:underline;">取消订阅</a>`, 'margin:24px 0 18px;font-size:12px;')}${footer}${paragraph(`统计范围：${escapeHtml(dateLabel(content.rangeStart))} ${escapeHtml(timeLabel(content.rangeStart))}—${escapeHtml(dateLabel(content.rangeEnd))} ${escapeHtml(timeLabel(content.rangeEnd))}（北京时间）。正文为来源摘要，原始资料与事实边界以所附来源为准。`, 'margin-top:10px;text-align:right;color:#74797b;font-size:11px;line-height:1.7;')}</td></tr></table></td></tr>`)}</body></html>`;
}
