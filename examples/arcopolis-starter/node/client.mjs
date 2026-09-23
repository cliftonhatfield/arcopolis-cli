/** Small server-side client. Every request is bounded; POST requests are never retried. */
export const DEFAULT_BASE = 'https://api.arcopolis.ai/v1';

export class ApiError extends Error {
  constructor(status, code, message, retryAfter = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * The visitor drive key: ARCOPOLIS_VISITOR_API_KEY, else ARCOPOLIS_API_KEY
 * (older starter copies and `arcopolis exec --visitor` put the drive key there).
 */
export function visitorKeyFromEnvironment(env = process.env) {
  const visitorKey = typeof env.ARCOPOLIS_VISITOR_API_KEY === 'string' ? env.ARCOPOLIS_VISITOR_API_KEY.trim() : '';
  return visitorKey || env.ARCOPOLIS_API_KEY;
}

export function normalizeBase(value = DEFAULT_BASE) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('ARCOPOLIS_API_BASE must be an HTTPS API URL (HTTP is allowed only on localhost), without credentials, query, or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

function retrySeconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

export class ArcopolisClient {
  constructor({ apiKey, baseUrl = DEFAULT_BASE, timeoutMs = 15_000, fetchImpl = fetch }) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Set ARCOPOLIS_API_KEY for --live. Demo mode needs no key.');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive.');
    this.apiKey = apiKey.trim();
    this.baseUrl = normalizeBase(baseUrl);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', body, idempotencyKey } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Use a relative API path beginning with one slash.');
    const headers = { Accept: 'application/json', 'User-Agent': 'ArcopolisStarter/1.0', 'X-API-Key': this.apiKey };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method, headers, redirect: 'manual', signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const retryAfter = retrySeconds(response.headers.get('Retry-After'));
      if (response.status >= 300 && response.status < 400) {
        throw new ApiError(response.status, 'REDIRECT_REJECTED', 'The API redirected this request. Use the canonical API base; credentials were not forwarded.');
      }
      let payload;
      try { payload = await response.json(); }
      catch {
        if (signal.aborted) throw signal.reason;
        throw new ApiError(response.status, response.ok ? 'INVALID_JSON' : `HTTP_${response.status}`, 'The API returned a non-JSON response.', retryAfter);
      }
      if (!response.ok) {
        throw new ApiError(response.status, payload?.error?.code ?? `HTTP_${response.status}`, payload?.error?.message ?? `API request failed with HTTP ${response.status}.`, retryAfter);
      }
      if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'data')) {
        throw new ApiError(response.status, 'INVALID_RESPONSE', 'The API response did not contain the expected data envelope.');
      }
      return payload;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new ApiError(0, 'TIMEOUT', 'The API request timed out. Preserve the same pending action and idempotency key before retrying.');
      }
      throw new ApiError(0, 'NETWORK_ERROR', 'The API request could not finish. Keep pending action state; no automatic retry was sent.');
    }
  }
}

export function reportError(error) {
  const result = { error: { status: error.status ?? 0, code: error.code ?? 'CLIENT_ERROR', message: error.message } };
  if (error.retryAfter !== null && error.retryAfter !== undefined) result.error.retryAfter = error.retryAfter;
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
