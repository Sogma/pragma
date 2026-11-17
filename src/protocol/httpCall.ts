/** Wraps `fetch()` for pragma's own outbound calls to external services (not
 * `/api/*`): timing and outcome metadata alongside the response, so a caller
 * can tell a rejected response apart from a call that never got one.
 *
 * Lives in `protocol/`, not `server/`, despite only server callers: it has no
 * Node dependency, and `protocol/` never imports from `server/`.
 *
 * Model completions bypass it (the AI SDK owns their retries and error
 * types); provider model discovery, a plain GET, does not. */

export interface HttpCallMeta {
  method: string;
  url: string;
  status: number;
  ok: boolean;
  durationMs: number;
}

export interface HttpCallResult {
  response: Response;
  meta: HttpCallMeta;
}

export async function httpCall(url: string, init?: RequestInit): Promise<HttpCallResult> {
  const method = init?.method ?? "GET";
  const start = Date.now();
  const response = await fetch(url, init);
  return { response, meta: { method, url, status: response.status, ok: response.ok, durationMs: Date.now() - start } };
}
