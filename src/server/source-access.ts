export function isJiqizhixinRss(input: string) {
  const url = new URL(input);
  return url.origin === 'https://mcp.applications.jiqizhixin.com' && url.pathname === '/rss';
}
export function validateSourceAccess(source: {
  url: string;
  format: string;
  intervalMinutes: number;
}) {
  if (!isJiqizhixinRss(source.url)) return;
  if (source.format !== 'rss' || source.intervalMinutes < 60)
    throw new Error('机器之心RSS采集间隔至少60分钟');
  if (new URL(source.url).searchParams.has('token'))
    throw new Error('机器之心令牌请配置在服务端 JIQIZHIXIN_RSS_TOKEN，订阅地址不要包含token');
}
export function sourceRequestUrl(input: string) {
  if (!isJiqizhixinRss(input)) return input;
  const token = process.env.JIQIZHIXIN_RSS_TOKEN;
  if (!token) throw new Error('尚未配置机器之心RSS访问令牌');
  const url = new URL(input);
  url.searchParams.set('token', token);
  return url.href;
}

export function sourceRequestOptions(input: string): {
  method?: 'POST';
  body?: string;
  headers?: Record<string, string>;
} {
  const url = new URL(input);
  if (
    url.origin !== 'https://rm-api.cfmc.cn' ||
    !['/web/home/news', '/web/news/getDetail'].includes(url.pathname)
  )
    return {};
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', tenantId: '37' };
  if (url.pathname === '/web/news/getDetail') return { headers };
  const channels = [27, 28, 30, 275, 34, 3261].map((channel_id) => ({
    channel_id,
    channel_type: 4,
    page: 1,
    page_size: 10,
    needTop: true,
    needBanner: false,
    needOrdinary: true,
    needFirst: false,
    webOrg: 2,
  }));
  return {
    headers,
    method: 'POST',
    body: new URLSearchParams({ data: JSON.stringify(channels) }).toString(),
  };
}
