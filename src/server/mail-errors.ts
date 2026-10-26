type SmtpError = { code?: string; command?: string; responseCode?: number; message?: string };
export function mailFailure(error: unknown) {
  const value = (error && typeof error === 'object' ? error : {}) as SmtpError;
  const command = String(value.command ?? '').toUpperCase();
  // 仅在确定没有提交邮件，或服务器明确拒收时，认定发送失败。
  const beforeSubmission = /^(CONN|EHLO|HELO|STARTTLS|AUTH(?: .*)?|MAIL FROM|RCPT TO|API)$/.test(
    command,
  );
  const rejected = Number(value.responseCode) >= 400 && Number(value.responseCode) < 600;
  const state = beforeSubmission || rejected || value.code === 'EAUTH' ? 'failed' : 'uncertain';
  let message = String(value.message ?? '未知发送错误');
  for (const secret of [process.env.SMTP_PASSWORD, process.env.SMTP_USER]) {
    if (!secret) continue;
    for (const text of [secret, Buffer.from(secret).toString('base64'), encodeURIComponent(secret)])
      message = message.split(text).join('<REDACTED>');
  }
  message = message
    .replace(/\b(?:smtps?|https?):\/\/[^\s]+/gi, '<URL>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<EMAIL>');
  const detail = [value.code, command, message].filter(Boolean).join(' · ').slice(0, 1000);
  return {
    state,
    error: `${state === 'failed' ? '发送失败' : '发送未确认，请核对发信服务记录'}：${detail}`,
  };
}
