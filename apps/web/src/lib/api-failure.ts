export type ApiFailureCategory = 'CANCELED' | 'TIMEOUT' | 'NETWORK' | 'HTTP' | 'UNKNOWN';

export function classifyApiFailure(error: { code?: string; __CANCEL__?: boolean; response?: unknown }): ApiFailureCategory {
  if (error.code === 'ERR_CANCELED' || error.__CANCEL__) return 'CANCELED';
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return 'TIMEOUT';
  if (error.response) return 'HTTP';
  return error.code === 'ERR_NETWORK' ? 'NETWORK' : 'UNKNOWN';
}
