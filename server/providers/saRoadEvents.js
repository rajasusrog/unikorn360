import { normalizeSaRoadEventSnapshot } from '../../src/layers/saRoadEvents/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Traffic SA open data (Department for Infrastructure and Transport,
// Government of South Australia): a keyless ArcGIS MapServer. The second
// service is an identical mirror, used only when the primary fails.
const SERVICE_ROOT =
  'https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport';
const PRIMARY = `${SERVICE_ROOT}/TrafficSAOpenData/MapServer`;
const MIRROR = `${SERVICE_ROOT}/TrafficSAOpenData2/MapServer`;
const USER_AGENT =
  'gods-eye-view-sa-road-events-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

// Layer 0 holds roadworks and incidents (points, OID ESRI_OID); layer 1 holds
// closures and detours (lines, OID LOCATION_ID). Paging needs a stable order.
const LAYERS = Object.freeze({
  points: Object.freeze({ index: 0, orderBy: 'ESRI_OID' }),
  lines: Object.freeze({ index: 1, orderBy: 'LOCATION_ID' }),
});
const PAGE_SIZE = 1000;
// ~1,300 points today (two pages); ten pages is 7x headroom, and a feed that
// still claims more is treated as broken rather than silently truncated.
const MAX_PAGES = 10;
const MIB = 1024 * 1024;

/** Cache, backoff and bounds; exported for tests and docs. */
export const SA_ROAD_EVENTS_POLICY = Object.freeze({
  freshMs: 120_000,
  retryAfterFailureMs: 60_000,
  maxRetryAfterMs: 900_000,
  // Closures and incidents change within hours; past six hours a "last good"
  // snapshot is more likely to show reopened roads than useful context.
  staleLimitMs: 6 * 3_600_000,
  // One budget for every page of one attempt (primary or mirror).
  timeoutMs: 40_000,
  maxPageBytes: 6 * MIB,
});

const exceededTransferLimit = (payload) =>
  payload?.exceededTransferLimit === true ||
  payload?.properties?.exceededTransferLimit === true;

function pageUrl(base, { index, orderBy }, offset) {
  const url = new URL(`${base}/${index}/query`);
  url.search = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
    orderByFields: orderBy,
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
  }).toString();
  return url.href;
}

/** Seconds from a Retry-After header, as bounded milliseconds (or null). */
function retryAfterMs(response, policy) {
  const seconds = Number(response.headers?.get?.('retry-after'));
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(
    Math.max(seconds * 1000, policy.retryAfterFailureMs),
    policy.maxRetryAfterMs,
  );
}

/** Fixed-origin, cached Traffic SA road-events route for dev and preview. */
export function saRoadEventsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  policy = SA_ROAD_EVENTS_POLICY,
} = {}) {
  let cache = null;
  let retryAt = -Infinity;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  /** Every page of one layer, or a throw: a partial layer is never returned. */
  async function fetchLayer(base, layer, signal) {
    const features = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetchImpl(pageUrl(base, layer, features.length), {
        signal,
        redirect: 'error',
        headers: {
          Accept: 'application/geo+json,application/json',
          'User-Agent': USER_AGENT,
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error('sa_upstream_unavailable'), {
          status: response.status,
          ...(response.status === 429
            ? { retryAfterMs: retryAfterMs(response, policy) }
            : {}),
        });
      }
      if (!/json/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        throw new Error('sa_upstream_not_json');
      }
      const payload = await readResponseJsonCapped(
        response,
        policy.maxPageBytes,
        signal,
      );
      if (
        payload?.type !== 'FeatureCollection' ||
        !Array.isArray(payload.features)
      )
        throw new Error('sa_invalid_page');
      features.push(...payload.features);
      if (!exceededTransferLimit(payload))
        return { type: 'FeatureCollection', features };
      if (!payload.features.length) throw new Error('sa_empty_truncated_page');
    }
    throw new Error('sa_too_many_pages');
  }

  async function fetchFrom(base, mirror) {
    const signal = AbortSignal.timeout(policy.timeoutMs);
    const points = await fetchLayer(base, LAYERS.points, signal);
    const lines = await fetchLayer(base, LAYERS.lines, signal);
    const snapshot = normalizeSaRoadEventSnapshot({ points, lines });
    if (!snapshot) throw new Error('sa_invalid_snapshot');
    return { fetchedAt: now(), ...snapshot, mirror };
  }

  /** Primary first; the mirror only after a non-429 failure. */
  async function fetchSnapshot() {
    try {
      return await fetchFrom(PRIMARY, false);
    } catch (error) {
      // A rate limit applies to this client, not the host: do not shop around.
      if (error.status === 429) throw error;
      return await fetchFrom(MIRROR, true);
    }
  }

  /** Fresh cache, else one shared upstream read; failures back off. */
  async function acquire() {
    if (cache && now() - cache.fetchedAt < policy.freshMs)
      return { value: cache, stale: false };
    if (!inFlight.size && now() < retryAt) {
      if (cache) return { value: cache, stale: true };
      throw new Error('sa_retry_later');
    }
    try {
      const { promise } = coalesceProxyRequest(
        inFlight,
        'snapshot',
        async () => {
          try {
            cache = await fetchSnapshot();
            retryAt = -Infinity;
            return cache;
          } catch (error) {
            retryAt =
              now() + (error.retryAfterMs ?? policy.retryAfterFailureMs);
            throw error;
          }
        },
      );
      return { value: await promise, stale: false };
    } catch (error) {
      if (cache) return { value: cache, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, extra = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...extra,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire();
      if (stale && now() - value.fetchedAt > policy.staleLimitMs)
        return json(502, { error: 'sa_road_events_unavailable' });
      json(
        200,
        {
          points: value.points,
          lines: value.lines,
          fetchedAt: value.fetchedAt,
          stale,
          mirror: value.mirror,
        },
        stale ? { 'X-Data-Stale': 'true' } : {},
      );
    } catch {
      json(502, { error: 'sa_road_events_unavailable' });
    }
  }

  return {
    name: 'sa-road-events',
    configureServer({ middlewares }) {
      middlewares.use('/api/sa-road-events', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sa-road-events', handler);
    },
  };
}
