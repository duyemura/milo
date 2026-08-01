import { accessToken, type ServiceAccount, type TokenFetchFn } from "./googleAuth.ts";

export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<HttpResponse>;

/** Authorized call wrapper — SA access token + scope, typed errors, injectable fetch.
 *  The injected fetchFn covers BOTH the token exchange and the API call (tests never
 *  touch Google). */
export async function apiCall(opts: {
  sa: ServiceAccount;
  scope: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  fetchFn?: FetchLike;
}): Promise<{ status: number; data: unknown }> {
  const fetchFn: FetchLike = opts.fetchFn ?? ((url, init) => fetch(url, init as never) as never);
  const token = await accessToken(
    opts.sa,
    opts.scope,
    (url, init) => fetchFn(url, { ...init, method: init.method }) as never,
  );
  const res = await fetchFn(opts.url, {
    method: opts.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export class ApiError extends Error {
  readonly api: string;
  readonly status: number;
  readonly data: unknown;
  constructor(api: string, status: number, data: unknown, message: string) {
    super(`${api} ${status}: ${message}`);
    this.api = api;
    this.status = status;
    this.data = data;
  }
}

export function requireOk(api: string, r: { status: number; data: unknown }, okStatuses: number[]): unknown {
  if (!okStatuses.includes(r.status)) {
    const desc =
      (r.data as { error?: { message?: string } })?.error?.message ??
      JSON.stringify(r.data).slice(0, 200);
    throw new ApiError(api, r.status, r.data, desc);
  }
  return r.data;
}
