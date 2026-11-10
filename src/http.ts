import type { ApiErrorBody, DnsRecord } from "./types.js";

export const DEFAULT_BASE_URL = "https://app.easel.sh";
export const SDK_VERSION = "0.1.2";

/** A non-2xx response from the Easel API. */
export class EaselApiError extends Error {
  readonly status: number;
  /** Machine-readable reason, such as `domain_in_use` or `token_scope`. */
  readonly code: string | undefined;
  /** DNS records that fix the problem, when there are any. */
  readonly records: DnsRecord[] | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error || `Request failed (${status})`);
    this.name = "EaselApiError";
    this.status = status;
    this.code = body.code;
    this.records = body.records;
  }
}

export interface ClientOptions {
  /** An Easel API token (`easel_…`): a workspace token or a scoped one. */
  token: string;
  /** Defaults to `https://app.easel.sh`, or `EASEL_API_URL` when set. */
  baseUrl?: string;
  /** Sent as `User-Agent`; defaults to `easel-sdk/<version>`. */
  userAgent?: string;
  /** Custom `fetch`, for tests or runtimes without a global one. */
  fetch?: typeof fetch;
  /** Attempts for rate-limited, 5xx and network failures. Default 4. */
  maxAttempts?: number;
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query;
  /** JSON body. */
  json?: unknown;
  /** Raw body (archive uploads). */
  body?: BodyInit;
  headers?: Record<string, string>;
  /**
   * Sent as `Idempotency-Key`. A request with a key is safe to retry after a
   * 5xx or network failure; one without is only retried when nothing was sent.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function envBaseUrl(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.EASEL_API_URL?.trim() || undefined;
}

/** Resolve after `ms`, or reject with the signal's reason once it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isReplayableBody(body: BodyInit | undefined): boolean {
  return body === undefined || typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Blob;
}

export type Http = {
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  baseUrl: string;
};

/** The transport every resource uses: auth, JSON, error mapping and retries. */
export function createHttp(options: ClientOptions): Http {
  if (!options.token) throw new Error("createClient: token is required");
  const baseUrl = (options.baseUrl ?? envBaseUrl() ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const userAgent = options.userAgent ?? `easel-sdk/${SDK_VERSION}`;

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${baseUrl}/api${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === null || value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/json",
      "User-Agent": userAgent,
      ...opts.headers,
    };
    let body = opts.body;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    // A stream can only be sent once; everything else can be resent.
    const canResend = isReplayableBody(body);
    const safeToRetryAfterSend = method === "GET" || Boolean(opts.idempotencyKey);

    for (let attempt = 1; ; attempt++) {
      const last = attempt >= maxAttempts || !canResend;
      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers,
          body,
          signal: opts.signal,
          // Required by fetch for streamed request bodies.
          ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
        } as RequestInit);
      } catch (error) {
        if (last || opts.signal?.aborted || !safeToRetryAfterSend) throw error;
        await sleep(backoff(attempt), opts.signal);
        continue;
      }

      const retryable = response.status === 429 || (response.status >= 500 && safeToRetryAfterSend);
      if (retryable && !last) {
        await sleep(retryDelay(response, attempt), opts.signal);
        continue;
      }

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => ({}))) as Partial<ApiErrorBody>;
        throw new EaselApiError(response.status, {
          error: errorBody.error ?? `Request failed (${response.status})`,
          code: errorBody.code,
          records: errorBody.records,
        });
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  return { request, baseUrl };
}

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** (attempt - 1));
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(60_000, retryAfter * 1000);
  return backoff(attempt);
}

/** A random idempotency key. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}
