/**
 * Same-site request gate for the cost-bearing and log endpoints.
 *
 * The credential panel has its own stricter gate (`admitKeySetupRequest` in
 * keySetupCore.mjs): loopback socket + local Host + exact Origin + JSON
 * Content-Type. The four endpoints here — `/api/realtime/token` (mints an
 * OpenAI Realtime token = spends money), `/api/openai/hud-summary` (OpenAI
 * spend), `/api/google/nearby-places` (Google spend), and
 * `/api/realtime/debug-log` (appends to a local JSONL) — were previously
 * ungated, so a hostile web page open in the same browser could reach them
 * cross-site: a `fetch` carries a foreign `Origin`, and an `<img>`/navigation
 * carries NO `Origin` at all but does carry `Sec-Fetch-Site: cross-site`.
 *
 * This module is the pure core that refuses those shapes while keeping the
 * documented `HOST=0.0.0.0` LAN opt-in and non-browser loopback tools (the two
 * repo QA harnesses POST the token endpoint from Node with no Origin) working.
 * It deliberately does NOT require a loopback remote address (that belongs only
 * to the credential panel), the presence of an `Origin`, or a JSON
 * Content-Type. It touches nothing but its arguments, so every refusal below is
 * pinned by a unit assertion.
 */
/**
 * Reverse-proxy / CDN forwarding headers. Their presence means the request did
 * not originate on this machine, whatever its socket says. This module owns
 * the list for every local gate (the credential panel and /mcp import
 * `hasProxySignals`), and has no imports so it can sit in any package boundary.
 */
export const PROXY_SIGNALS = Object.freeze([
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
]);

/**
 * Parse an allowlist of trusted proxy IP addresses from a configuration string.
 * Supports comma- and space-separated IPv4, IPv6, and IPv4-mapped IPv6 addresses.
 * @param {string} envValue e.g. process.env.GEV_TRUSTED_PROXY_IPS
 * @returns {Set<string>}
 */
export function parseTrustedProxyIps(envValue) {
  if (!envValue || typeof envValue !== 'string') return new Set();
  const tokens = envValue
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const ips = new Set();
  for (const token of tokens) {
    ips.add(token);
    if (token.startsWith('::ffff:')) {
      ips.add(token.slice(7));
    }
  }
  return ips;
}

/**
 * Determine whether a remote socket address is in the trusted proxy allowlist.
 * @param {string} remoteAddress
 * @param {Set<string>} trustedIps
 * @returns {boolean}
 */
export function isTrustedProxyPeer(remoteAddress, trustedIps) {
  if (!remoteAddress || !(trustedIps instanceof Set) || trustedIps.size === 0) {
    return false;
  }
  const raw = String(remoteAddress).trim().toLowerCase();
  if (trustedIps.has(raw)) return true;
  if (raw.startsWith('::ffff:') && trustedIps.has(raw.slice(7))) return true;
  return false;
}

/**
 * Whether a request carries reverse-proxy or CDN forwarding headers. `headers`
 * is keyed by lower-case header name. When `isTrustedProxy` is true, exactly
 * single-hop `x-forwarded-for` and single-scheme `x-forwarded-proto` are allowed;
 * multi-hop or extraneous proxy signals remain refused.
 */
export function hasProxySignals(headers = {}, { isTrustedProxy = false } = {}) {
  if (isTrustedProxy) {
    const prohibited = [
      'forwarded',
      'via',
      'x-forwarded-host',
      'x-forwarded-port',
      'x-real-ip',
      'cf-connecting-ip',
      'cf-ray',
    ];
    if (prohibited.some((name) => String(headers[name] || '').trim() !== '')) {
      return true;
    }
    const proto = String(headers['x-forwarded-proto'] || '')
      .trim()
      .toLowerCase();
    if (proto !== '') {
      if (proto !== 'http' && proto !== 'https') {
        return true;
      }
    }
    return false;
  }
  return PROXY_SIGNALS.some(
    (name) => String(headers[name] || '').trim() !== '',
  );
}

/**
 * Compute a request's own authority (an origin string) from its protocol and
 * Host header. Unlike the credential-panel gate's localhost-restricted
 * `localAuthority`, this returns whatever Host the request actually carries —
 * the LAN opt-in serves a non-loopback Host to LAN browsers, and a same-origin
 * fetch from such a page must still match. Malformed/missing input yields null.
 * @param {string} hostHeader e.g. `req.headers.host`
 * @param {string} protocol `http:` or `https:`
 * @returns {string|null}
 */
function requestAuthority(hostHeader, protocol) {
  const raw = String(hostHeader || '')
    .trim()
    .toLowerCase();
  const scheme = String(protocol || '').toLowerCase();
  if (!raw || !['http:', 'https:'].includes(scheme) || /[\s/?#@]/.test(raw))
    return null;
  try {
    return new URL(`${scheme}//${raw}`).origin;
  } catch {
    return null;
  }
}

/**
 * Decide whether a request to a cost-bearing/log endpoint is same-site enough
 * to admit. Pure: no I/O, no globals.
 *
 * Policy, in order:
 *  1. any reverse-proxy / CDN signal header present (PROXY_SIGNALS) → 403
 *     (unless the socket peer is an explicitly trusted proxy, in which case
 *     one-hop x-forwarded-proto/for are admitted and derive the protocol);
 *  2. `Sec-Fetch-Site` present and not `same-origin` / `none` → 403 (this is
 *     what blocks `<img src=...>` and cross-site navigation, which carry no
 *     Origin but do carry `Sec-Fetch-Site: cross-site`);
 *  3. `Origin` present must exactly equal the request's own authority computed
 *     from protocol + Host — the same exact-origin comparison the credential
 *     gate uses (no userinfo, no path/search/hash). The literal string `null`
 *     is an opaque origin (sandboxed iframe / `data:` URL) and is refused;
 *  4. otherwise ok. Non-browser loopback tools and the LAN opt-in (which may
 *     carry neither `Origin` nor `Sec-Fetch-Site`) pass here.
 *
 * @param {{hostHeader?: string, protocol?: string, origin?: string, secFetchSite?: string, proxyHeaders?: Record<string,string>, isTrustedProxy?: boolean}} req
 * @returns {{ok: true} | {ok: false, status: 403, error: string}}
 */
export function admitSameSiteRequest({
  hostHeader,
  protocol = 'http:',
  origin,
  secFetchSite,
  proxyHeaders = {},
  isTrustedProxy = false,
} = {}) {
  // (1) A request carrying reverse-proxy / CDN forwarding headers did not
  // originate on this machine, whatever its socket says.
  if (hasProxySignals(proxyHeaders, { isTrustedProxy })) {
    return {
      ok: false,
      status: 403,
      error: 'Proxied requests are not accepted',
    };
  }

  // If from an explicitly trusted proxy, derive the scheme from X-Forwarded-Proto
  if (isTrustedProxy) {
    const proto = String(proxyHeaders['x-forwarded-proto'] || '')
      .trim()
      .toLowerCase();
    if (proto === 'http' || proto === 'https') {
      protocol = `${proto}:`;
    }
  }
  // (2) The browser tells us when a request is cross-site. `none` is a typed
  // URL / bookmark; `same-origin` is the app itself. Anything else (cross-site,
  // same-site but cross-origin) is refused.
  const site = String(secFetchSite || '')
    .trim()
    .toLowerCase();
  if (site !== '' && site !== 'same-origin' && site !== 'none') {
    return {
      ok: false,
      status: 403,
      error: 'Cross-site requests are not accepted',
    };
  }
  // (3) If Origin is present it must exactly equal the request's own authority.
  if (origin !== undefined && origin !== null && origin !== '') {
    if (origin === 'null') {
      return {
        ok: false,
        status: 403,
        error: 'Opaque origins are not accepted',
      };
    }
    const authority = requestAuthority(hostHeader, protocol);
    let parsedOrigin;
    try {
      parsedOrigin = new URL(String(origin));
    } catch {
      return { ok: false, status: 403, error: 'Unrecognized Origin refused' };
    }
    const exactOrigin =
      parsedOrigin.username === '' &&
      parsedOrigin.password === '' &&
      parsedOrigin.pathname === '/' &&
      parsedOrigin.search === '' &&
      parsedOrigin.hash === '' &&
      parsedOrigin.origin === authority;
    if (!exactOrigin) {
      return {
        ok: false,
        status: 403,
        error: 'Cross-origin requests are not accepted',
      };
    }
  }
  return { ok: true };
}
