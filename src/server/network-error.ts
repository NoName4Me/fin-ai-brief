const networkCodes = new Set([
  'ABORT_ERR',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, status } = error as Error & { code?: string; status?: number };
  return (
    error.name === 'TimeoutError' ||
    (code !== undefined && networkCodes.has(code)) ||
    (status !== undefined && [408, 500, 502, 503, 504].includes(status)) ||
    isTransientNetworkError(error.cause) ||
    (error instanceof AggregateError && error.errors.some(isTransientNetworkError))
  );
}
