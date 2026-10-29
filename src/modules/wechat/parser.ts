import { load } from 'cheerio';
import { WechatError } from './errors.ts';
import type { WechatAccount, WechatArticleSummary } from './types.ts';

function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return object(JSON.parse(value));
    } catch {
      throw new WechatError('微信文章列表格式已变化', 'format');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WechatError('微信文章列表格式已变化', 'format');
  return value as Record<string, unknown>;
}

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

export function parseWechatAccounts(payload: unknown): WechatAccount[] {
  const body = object(payload);
  if (!Array.isArray(body.list)) throw new WechatError('公众号搜索格式已变化', 'format');
  return body.list.flatMap((value) => {
    const row = object(value);
    const fakeid = text(row.fakeid);
    const nickname = text(row.nickname).trim();
    if (!fakeid || !nickname) return [];
    return [
      {
        fakeid,
        nickname: nickname.slice(0, 200),
        alias: text(row.alias).slice(0, 200),
        avatarUrl: text(row.round_head_img).slice(0, 2000),
      },
    ];
  });
}

export function parseWechatArticleList(payload: unknown): WechatArticleSummary[] {
  const page = object(object(payload).publish_page);
  if (!Array.isArray(page.publish_list)) throw new WechatError('微信文章列表格式已变化', 'format');
  const articles: WechatArticleSummary[] = [];
  for (const value of page.publish_list) {
    const info = object(object(value).publish_info);
    if (!Array.isArray(info.appmsgex)) continue;
    for (const entry of info.appmsgex) {
      const row = object(entry);
      const url = text(row.link);
      const title = text(row.title).trim();
      const timestamp = Number(row.create_time || row.update_time);
      if (!url || !title || !Number.isFinite(timestamp) || timestamp <= 0) continue;
      const parsedUrl = new URL(url);
      if (
        parsedUrl.hostname !== 'mp.weixin.qq.com' ||
        !['http:', 'https:'].includes(parsedUrl.protocol)
      )
        continue;
      parsedUrl.protocol = 'https:';
      articles.push({
        aid: text(row.aid),
        title: title.slice(0, 500),
        url: parsedUrl.href,
        excerpt: (text(row.digest).trim() || title).slice(0, 16000),
        publishedAt: new Date(timestamp * 1000).toISOString(),
      });
    }
  }
  return articles;
}

export function parseWechatArticle(html: string) {
  if (/verifycode|请输入图片中的字符|<title>环境异常/i.test(html))
    throw new WechatError('微信文章触发了访问验证，请稍后重试', 'verification');
  if (/该内容已被发布者删除|此内容因违规无法查看|参数错误/.test(html))
    throw new WechatError('微信文章已删除或不可访问', 'format');
  const $ = load(html);
  const content = $('#js_content').first();
  if (!content.length) throw new WechatError('未读取到微信正文，可能需要访问验证', 'verification');
  content.find('script,style,iframe,[style*="display:none"],[style*="display: none"]').remove();
  content.find('br,p,section,li,h1,h2,h3,h4,blockquote').each((_, element) => {
    $(element).append('\n');
  });
  const excerpt = content
    .text()
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (excerpt.length < 20) throw new WechatError('微信正文不足或仅包含图片', 'format');
  const title = (
    $('#activity-name').text() ||
    $('meta[property="og:title"]').attr('content') ||
    ''
  ).trim();
  return {
    excerpt: excerpt.slice(0, 12000),
    ...(title ? { title: title.slice(0, 500) } : {}),
  };
}

export function parseWechatNickname(html: string) {
  return /nick_name\s*[:=]\s*["']([^"']+)["']/.exec(html)?.[1]?.slice(0, 200) ?? '';
}
