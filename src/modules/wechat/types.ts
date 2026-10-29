export type WechatCredentials = {
  token: string;
  cookie: string;
  nickname: string;
  accountFakeid: string;
  expiresAt: Date;
};

export type WechatAccount = {
  fakeid: string;
  nickname: string;
  alias: string;
  avatarUrl: string;
};

export type WechatArticleSummary = {
  aid: string;
  title: string;
  url: string;
  excerpt: string;
  publishedAt: string;
};

export type WechatLoginStatus = {
  state: 'waiting' | 'scanned' | 'success';
  message: string;
  nickname?: string;
};
