import { logger } from '@ja/shared';

export interface HttpClient {
  getJson<T = unknown>(url: string, opts?: { headers?: Record<string, string> }): Promise<T>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
  }
}

interface Options {
  timeoutMs?: number;
  retries?: number;
  /** Minimum gap between requests to the same host. */
  minIntervalMs?: number;
  userAgent?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strips credentials from a URL before it is logged or stored in an error. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of ['app_key', 'app_id', 'api_key', 'key', 'token'])
      if (u.searchParams.has(key)) u.searchParams.set(key, '***');
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * fetch wrapper with timeout, retries on 429/5xx/network errors (honouring Retry-After),
 * and a per-host minimum interval so one source never hammers an API.
 */
export function createHttpClient(opts: Options = {}): HttpClient {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const retries = opts.retries ?? 3;
  const minIntervalMs = opts.minIntervalMs ?? 1_000;
  const userAgent = opts.userAgent ?? 'job-autopilot/0.1 (personal job search tool)';
  const nextSlot = new Map<string, number>();

  async function waitForHost(host: string) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + minIntervalMs);
    if (slot > now) await sleep(slot - now);
  }

  return {
    async getJson<T>(url: string, o: { headers?: Record<string, string> } = {}): Promise<T> {
      const host = new URL(url).host;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        await waitForHost(host);
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': userAgent, Accept: 'application/json', ...o.headers },
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.ok) return (await res.json()) as T;

          const retryable = res.status === 429 || res.status >= 500;
          const body = (await res.text().catch(() => '')).slice(0, 300);
          lastErr = new HttpError(
            `HTTP ${res.status} for ${redactUrl(url)}: ${body}`,
            res.status,
            redactUrl(url),
          );
          if (!retryable || attempt === retries) throw lastErr;

          const retryAfter = Number(res.headers.get('retry-after'));
          const delay =
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
          logger.warn({ url: redactUrl(url), status: res.status, delay }, 'http retry');
          await sleep(Math.min(delay, 60_000));
        } catch (err) {
          if (err instanceof HttpError) throw err;
          lastErr = err;
          if (attempt === retries) break;
          logger.warn(
            { url: redactUrl(url), err: (err as Error).message },
            'http network error, retrying',
          );
          await sleep(1000 * 2 ** attempt);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}
