import { escapeHtml } from './mail-template.ts';

export function renderSubscriptionConfirmation(url: string) {
  const link = escapeHtml(url);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f7f5ef;color:#282f33;font-family:'PingFang SC','Microsoft YaHei',sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;"><tr><td style="padding-bottom:20px;border-bottom:1px solid #233c53;font-size:24px;font-weight:700;color:#233c53;">数智参阅</td></tr>
<tr><td style="padding:32px 0 16px;"><h1 style="margin:0 0 20px;font-size:24px;">确认邮箱订阅</h1><p style="margin:0;line-height:1.9;">点击下方按钮，开始接收《数智参阅》。<br>确认链接24小时内有效。</p></td></tr>
<tr><td style="padding:12px 0 28px;"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#233c53"><a href="${link}" style="display:inline-block;padding:14px 28px;border:1px solid #233c53;color:#ffffff;font-size:16px;text-decoration:none;">确认订阅</a></td></tr></table></td></tr>
<tr><td style="padding-bottom:28px;font-size:13px;line-height:1.9;color:#626967;">如果按钮无法打开，请复制以下链接到浏览器地址栏访问：<br><a href="${link}" style="color:#233c53;word-break:break-all;">${link}</a></td></tr>
<tr><td style="padding-top:20px;border-top:1px solid #d8d5cc;color:#626967;font-size:12px;line-height:1.9;">如果不是你本人申请，请忽略此邮件，订阅不会生效。</td></tr></table>
</td></tr></table></body></html>`;
}
