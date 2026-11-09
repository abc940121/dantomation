// The API client. Our own file (MIT). Absolute paths, JSON only, Bearer header.
// A 401 clears the token and flips `auth` to "unauthorized", which makes the pairing gate show.
import { clearToken, currentToken } from "./token";

export type AuthState = "ok" | "unauthorized";
let authState: AuthState = currentToken() ? "ok" : "unauthorized";
const authListeners = new Set<() => void>();

export const auth = {
  get: (): AuthState => authState,
  set(next: AuthState): void {
    if (next === authState) return;
    authState = next;
    for (const fn of authListeners) fn();
  },
  subscribe(fn: () => void): () => void {
    authListeners.add(fn);
    return () => void authListeners.delete(fn);
  },
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Client {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** An open response for a streaming endpoint (SSE). Throws ApiError on a non-2xx status. */
  stream(path: string, init?: { signal?: AbortSignal }): Promise<Response>;
}

function headers(json: boolean, accept: string): Record<string, string> {
  const h: Record<string, string> = { Accept: accept };
  if (json) h["Content-Type"] = "application/json";
  const token = currentToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function checkPath(path: string): void {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Error("client: path must be absolute (start with a single /)");
}

async function failure(res: Response): Promise<ApiError> {
  if (res.status === 401) {
    clearToken();
    auth.set("unauthorized");
  }
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, message);
}

async function json<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  checkPath(path);
  const res = await fetch(path, {
    method,
    headers: headers(method === "POST", "application/json"),
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

export function createClient(): Client {
  return {
    get: (path) => json("GET", path),
    post: (path, body) => json("POST", path, body),
    async stream(path, init) {
      checkPath(path);
      const res = await fetch(path, { headers: headers(false, "text/event-stream"), signal: init?.signal });
      if (!res.ok) throw await failure(res);
      return res;
    },
  };
}

export const client: Client = createClient();
