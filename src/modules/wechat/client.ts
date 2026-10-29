import { assertWechatSuccess, WechatError } from './errors.ts';
import { parseCookieHeader, WechatHttpClient } from './http.ts';
import { parseWechatAccounts, parseWechatArticle, parseWechatArticleList } from './parser.ts';
import type { WechatCredentials } from './types.ts';

export class WechatClient {
  private http: WechatHttpClient;

  constructor(private credentials: Pick<WechatCredentials, 'token' | 'cookie'>) {
    this.http = new WechatHttpClient(parseCookieHeader(credentials.cookie));
  }

  async searchAccounts(query: string) {
    const payload = await this.http.json('/cgi-bin/searchbiz', {
      params: {
        action: 'search_biz',
        token: this.credentials.token,
        lang: 'zh_CN',
        f: 'json',
        ajax: 1,
        random: Date.now(),
        query,
        begin: 0,
        count: 5,
      },
    });
    assertWechatSuccess(payload);
    return parseWechatAccounts(payload);
  }

  async latestArticles(fakeid: string, count = 10) {
    const payload = await this.http.json('/cgi-bin/appmsgpublish', {
      params: {
        sub: 'list',
        search_field: 'null',
        begin: 0,
        count,
        query: '',
        fakeid,
        type: '101_1',
        free_publish_type: 1,
        sub_action: 'list_ex',
        token: this.credentials.token,
        lang: 'zh_CN',
        f: 'json',
        ajax: 1,
      },
    });
    assertWechatSuccess(payload);
    return parseWechatArticleList(payload);
  }

  async readArticle(input: string) {
    const url = new URL(input);
    if (url.origin !== 'https://mp.weixin.qq.com') throw new WechatError('微信文章地址无效');
    url.searchParams.set('token', this.credentials.token);
    const { body } = await this.http.request(`${url.pathname}${url.search}`);
    return parseWechatArticle(body.toString('utf8'));
  }
}
