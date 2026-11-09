// Device token handling. Our own file (MIT). Never logs the token.
//   #t=<token>  from a link: kept in localStorage, the hash is removed from the address bar
//   #p=<code>   a pairing code: POSTed to /m/device-pairing/redeem, the token that comes back is kept
export const TOKEN_KEY = "dantomation.token";

let memoryToken: string | null = null;

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  memoryToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage blocked: the token only lives until the page closes */
  }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** The token to send: the stored one, or the in-memory one when storage is blocked. */
export function currentToken(): string | null {
  return getToken() ?? memoryToken;
}

function stripHash(): void {
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    /* the address bar keeps the hash; harmless */
  }
}

/** Turns a pairing code into a stored token. Returns true when it worked. */
export async function redeemCode(code: string, label = "app-ui"): Promise<boolean> {
  try {
    const res = await fetch("/m/device-pairing/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code: code.trim(), label }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) return false;
    setToken(body.token);
    return true;
  } catch {
    return false;
  }
}

/** Reads #t= / #p= once at startup. Resolves after the hash is gone and any token is stored. */
export async function consumeHash(): Promise<void> {
  let hash = "";
  try {
    hash = location.hash.replace(/^#/, "");
  } catch {
    return;
  }
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const token = params.get("t");
  const code = params.get("p");
  if (!token && !code) return;
  stripHash();
  if (token) setToken(token);
  else if (code) await redeemCode(code);
}
