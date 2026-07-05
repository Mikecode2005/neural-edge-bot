/**
 * Deriv OAuth (browser-side).
 * Uses Deriv's simple OAuth flow: redirect to oauth.deriv.com → callback with
 * acct1/token1/cur1 ...acctN/tokenN/curN as query params.
 *
 * https://api.deriv.com/api-explorer (Authentication section)
 */

export interface DerivOAuthAccount {
  loginid: string; // e.g. VRTC1234567 (demo) / CR1234567 (real)
  token: string;
  currency: string;
  account_type: "demo" | "real";
}

const APP_ID =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_DERIV_APP_ID) || "1089";

export function startDerivOAuth(redirectPath = "/auth/deriv-callback") {
  if (typeof window === "undefined") return;
  const redirect = `${window.location.origin}${redirectPath}`;
  const url = `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}&l=EN&brand=deriv&redirect_uri=${encodeURIComponent(redirect)}`;
  window.location.assign(url);
}

/** Parses ?acct1=...&token1=...&cur1=... pairs from a URL search string. */
export function parseDerivCallback(search: string): DerivOAuthAccount[] {
  const params = new URLSearchParams(search);
  const accounts: DerivOAuthAccount[] = [];
  let i = 1;
  while (params.has(`acct${i}`) && params.has(`token${i}`)) {
    const loginid = params.get(`acct${i}`)!;
    const token = params.get(`token${i}`)!;
    const currency = params.get(`cur${i}`) ?? "USD";
    const account_type: "demo" | "real" = loginid.startsWith("VR") ? "demo" : "real";
    accounts.push({ loginid, token, currency, account_type });
    i++;
  }
  return accounts;
}
