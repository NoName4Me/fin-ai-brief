export function sourceRequestUrl(input: string) {
  const listing = new URL(input);
  if (
    listing.origin === 'https://www.nfra.gov.cn' &&
    listing.pathname === '/cn/view/pages/ItemList.html'
  ) {
    const id = listing.searchParams.get('itemId');
    if (!id || !/^\d+$/.test(id)) throw new Error('金融监管总局栏目编号无效');
    return `https://www.nfra.gov.cn/cbircweb/DocInfo/SelectDocByItemIdAndChild?itemId=${id}&pageSize=18&pageIndex=1`;
  }
  if (listing.origin === 'https://www.ndrc.gov.cn' && listing.pathname === '/xxgk/wjk/index.html') {
    const endpoint = new URL('https://fwfx.ndrc.gov.cn/api/query');
    endpoint.search = new URLSearchParams({
      qt: listing.searchParams.get('qt') ?? '',
      tab: listing.searchParams.get('tab') ?? 'all',
      page: '1',
      pageSize: '20',
      siteCode: 'bm04000fgk',
      sort: 'dateDesc',
      timeOption: '0',
    }).toString();
    return endpoint.href;
  }
  if (listing.origin === 'https://www.cbimc.cn') {
    const channel = /^\/channel\/(\d+)\/(\d+)$/.exec(listing.pathname);
    if (channel) {
      const endpoint = new URL('https://rm-api.cfmc.cn/web/news/getChannelNewsList');
      endpoint.searchParams.set(
        'data',
        JSON.stringify({
          channel_id: Number(channel[2]),
          channel_type: Number(channel[1]),
          page: 1,
          page_size: 20,
          webOrg: 2,
          needTop: true,
          needOrdinary: true,
          needBanner: true,
        }),
      );
      return endpoint.href;
    }
  }
  return input;
}

export function sourceRequestOptions(input: string): {
  method?: 'POST';
  body?: string;
  headers?: Record<string, string>;
} {
  const url = new URL(input);
  if (url.origin === 'https://www.cbimc.cn' && /^\/channel\/\d+\/\d+$/.test(url.pathname))
    return { method: 'POST', headers: { tenantId: '37' } };
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
