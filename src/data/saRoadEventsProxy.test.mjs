import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SA_ROAD_EVENTS_POLICY,
  saRoadEventsProxy,
} from '../../server/providers/saRoadEvents.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  );
const sampleFeature = fixture('trafficsa-points-sample.json').features[1];
const lineCollection = fixture('trafficsa-lines.json');

const pointFeature = (n) => ({
  ...sampleFeature,
  id: n,
  properties: {
    ...sampleFeature.properties,
    ROADWORKS_AND_INCIDENTS_ID: String(1000 + n),
    ESRI_OID: n,
  },
});
const pointFeatures = (count) =>
  Array.from({ length: count }, (_, i) => pointFeature(i + 1));

/** Parse an ArcGIS query URL the proxy requested. */
function parse(url) {
  const parsed = new URL(url);
  const [, service, layer] =
    parsed.pathname.match(/\/(TrafficSAOpenData2?)\/MapServer\/(\d)\/query$/) ||
    [];
  return {
    origin: parsed.origin,
    service,
    layer: Number(layer),
    offset: Number(parsed.searchParams.get('resultOffset')),
    params: parsed.searchParams,
  };
}

/**
 * A fake Traffic SA service. `points` is the full upstream point list (paged
 * 1000 at a time, like the real maxRecordCount); `fail(request)` may return a
 * Response to replace the normal answer.
 */
function upstream({ points = pointFeatures(3), fail, flag = 'top' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = parse(url);
    calls.push({ ...request, url, options });
    const failure = fail?.(request, calls.length);
    if (failure) return failure;
    if (request.layer === 1)
      return Response.json(lineCollection, {
        headers: { 'content-type': 'application/geo+json;charset=UTF-8' },
      });
    const page = points.slice(request.offset, request.offset + 1000);
    const truncated = request.offset + 1000 < points.length;
    const body =
      flag === 'properties'
        ? {
            type: 'FeatureCollection',
            features: page,
            ...(truncated
              ? { properties: { exceededTransferLimit: true } }
              : {}),
          }
        : {
            type: 'FeatureCollection',
            features: page,
            ...(truncated ? { exceededTransferLimit: true } : {}),
          };
    return Response.json(body);
  };
  return { calls, fetchImpl };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = saRoadEventsProxy(options);
  assert.equal(plugin.name, 'sa-road-events');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/sa-road-events');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: fixed upstream, normalized body, no browser-chosen URL`, async () => {
    const service = upstream();
    const request = install(
      { now: () => 5000, fetchImpl: service.fetchImpl },
      hook,
    );
    const res = await request('/?url=https://evil.example/x&f=html');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Data-Stale'], undefined);
    assert.equal(res.body.stale, false);
    assert.equal(res.body.mirror, false);
    assert.equal(res.body.fetchedAt, 5000);
    assert.equal(res.body.points.length, 3);
    assert.equal(res.body.lines.length, 8);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'fetchedAt',
      'lines',
      'mirror',
      'points',
      'stale',
    ]);
    assert.equal(service.calls.length, 2);
    for (const call of service.calls) {
      assert.equal(call.origin, 'https://maps.sa.gov.au');
      assert.equal(call.service, 'TrafficSAOpenData');
      assert.equal(call.params.get('f'), 'geojson');
      assert.equal(call.params.get('outSR'), '4326');
      assert.equal(call.params.get('outFields'), '*');
      assert.equal(call.params.get('resultRecordCount'), '1000');
      assert.equal(call.params.get('url'), null);
      assert.ok(call.options.signal instanceof AbortSignal);
      assert.equal(call.options.redirect, 'error');
      assert.match(
        call.options.headers['User-Agent'],
        /^gods-eye-view-sa-road-events-proxy\/1\.0 /,
      );
    }
    assert.deepEqual(
      service.calls.map((call) => [
        call.layer,
        call.params.get('orderByFields'),
      ]),
      [
        [0, 'ESRI_OID'],
        [1, 'LOCATION_ID'],
      ],
      'each layer pages on its own object-id field',
    );
  });
}

for (const flag of ['top', 'properties']) {
  test(`pages are followed while exceededTransferLimit is set (${flag} flag) and joined whole`, async () => {
    const service = upstream({ points: pointFeatures(2300), flag });
    const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
    const res = await request();
    assert.equal(res.status, 200);
    assert.equal(res.body.points.length, 2300);
    assert.deepEqual(
      service.calls
        .filter((call) => call.layer === 0)
        .map((call) => call.offset),
      [0, 1000, 2000],
    );
    assert.equal(new Set(res.body.points.map((p) => p.id)).size, 2300);
  });
}

test('a failing page fails the whole refresh: last good is served, never a partial set', async () => {
  let clock = 0;
  let breakSecondPage = false;
  const service = upstream({
    points: pointFeatures(1500),
    fail: (request) =>
      breakSecondPage && request.layer === 0 && request.offset === 1000
        ? new Response('boom', { status: 500 })
        : null,
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  const first = await request();
  assert.equal(first.body.points.length, 1500);
  breakSecondPage = true;
  clock = SA_ROAD_EVENTS_POLICY.freshMs;
  const second = await request();
  assert.equal(second.status, 200);
  assert.equal(second.body.stale, true);
  assert.equal(second.headers['X-Data-Stale'], 'true');
  assert.equal(second.body.points.length, 1500, 'previous complete snapshot');
  assert.equal(second.body.fetchedAt, first.body.fetchedAt);
});

test('a first failure on the second page is a sanitized 502, not partial data', async () => {
  const service = upstream({
    points: pointFeatures(1500),
    fail: (request) =>
      request.layer === 0 && request.offset === 1000
        ? new Response('boom', { status: 500 })
        : null,
  });
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'sa_road_events_unavailable' });
});

test('the mirror answers only after the primary fails, and is flagged', async () => {
  const service = upstream({
    fail: (request) =>
      request.service === 'TrafficSAOpenData'
        ? new Response('down', { status: 503 })
        : null,
  });
  const request = install({ now: () => 7, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.body.mirror, true);
  assert.equal(res.body.stale, false);
  assert.equal(res.body.points.length, 3);
  assert.deepEqual(
    service.calls.map((call) => call.service),
    ['TrafficSAOpenData', 'TrafficSAOpenData2', 'TrafficSAOpenData2'],
    'a failed page abandons the primary; the mirror serves both layers',
  );
  assert.ok(
    service.calls.every((call) => call.origin === 'https://maps.sa.gov.au'),
  );
});

test('a healthy primary never touches the mirror', async () => {
  const service = upstream();
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  await request();
  assert.ok(
    service.calls.every((call) => call.service === 'TrafficSAOpenData'),
  );
});

test('the mirror is not a partial answer either: a mirror page failure falls back to last good', async () => {
  let clock = 0;
  let degraded = false;
  const service = upstream({
    points: pointFeatures(1200),
    fail: (request) => {
      if (!degraded) return null;
      if (request.service === 'TrafficSAOpenData')
        return new Response('down', { status: 503 });
      return request.layer === 0 && request.offset === 1000
        ? new Response('down', { status: 503 })
        : null;
    },
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  await request();
  degraded = true;
  clock = SA_ROAD_EVENTS_POLICY.freshMs;
  const res = await request();
  assert.equal(res.body.stale, true);
  assert.equal(res.body.mirror, false);
  assert.equal(res.body.points.length, 1200);
});

test('unusable upstream answers are failures, not empty data', async () => {
  const cases = {
    'HTML error page': () =>
      new Response('<html>File Unavailable</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    'JSON content-type with a non-JSON body': () =>
      new Response('File Unavailable', {
        headers: { 'content-type': 'application/json' },
      }),
    'ArcGIS error object': () =>
      Response.json({
        error: { code: 400, message: 'Failed to execute query.' },
      }),
    'non-collection JSON': () => Response.json([]),
    'collection of unusable rows': () =>
      Response.json({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: null, properties: {} }],
      }),
  };
  for (const [name, answer] of Object.entries(cases)) {
    const service = upstream({ fail: () => answer() });
    const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
    const res = await request();
    assert.equal(res.status, 502, name);
  }
});

test('a feed that never stops claiming more pages is a failure, not a truncation', async () => {
  const service = upstream({
    fail: (request) =>
      request.layer === 0
        ? Response.json({
            type: 'FeatureCollection',
            features: pointFeatures(1),
            exceededTransferLimit: true,
          })
        : null,
  });
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  assert.equal((await request()).status, 502);
  assert.equal(
    service.calls.filter(
      (call) => call.service === 'TrafficSAOpenData' && call.layer === 0,
    ).length,
    10,
    'bounded by MAX_PAGES',
  );
});

test('an empty page that still claims truncation fails instead of looping', async () => {
  const service = upstream({
    fail: (request) =>
      request.layer === 0
        ? Response.json({
            type: 'FeatureCollection',
            features: [],
            exceededTransferLimit: true,
          })
        : null,
  });
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  assert.equal((await request()).status, 502);
  assert.ok(service.calls.length <= 4);
});

test('snapshots are cached for the fresh window and shared by concurrent callers', async () => {
  let clock = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const service = upstream();
  const request = install({
    now: () => clock,
    fetchImpl: async (...args) => {
      await gate;
      return service.fetchImpl(...args);
    },
  });
  const pending = [request('/', 'GET', 'a'), request('/', 'GET', 'b')];
  release();
  const [a, b] = await Promise.all(pending);
  assert.equal(service.calls.length, 2, 'two layers, once, for both callers');
  assert.deepEqual(a.body, b.body);
  clock = SA_ROAD_EVENTS_POLICY.freshMs - 1;
  const cached = await request();
  assert.equal(service.calls.length, 2, 'fresh cache is reused');
  assert.equal(cached.body.fetchedAt, 0);
  clock = SA_ROAD_EVENTS_POLICY.freshMs;
  const refreshed = await request();
  assert.equal(service.calls.length, 4);
  assert.equal(refreshed.body.fetchedAt, SA_ROAD_EVENTS_POLICY.freshMs);
});

test('failures serve stale data, back off, then recover', async () => {
  let clock = 0;
  let down = false;
  const service = upstream({
    fail: () => (down ? new Response('down', { status: 503 }) : null),
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  await request();
  down = true;
  clock = SA_ROAD_EVENTS_POLICY.freshMs;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  const callsAfterFailure = service.calls.length;
  clock += SA_ROAD_EVENTS_POLICY.retryAfterFailureMs - 1;
  const backedOff = await request();
  assert.equal(backedOff.body.stale, true);
  assert.equal(
    service.calls.length,
    callsAfterFailure,
    'no retry inside the backoff',
  );
  down = false;
  clock += 1;
  const recovered = await request();
  assert.equal(recovered.body.stale, false);
  assert.equal(recovered.headers['X-Data-Stale'], undefined);
  assert.equal(recovered.body.fetchedAt, clock);
});

test('last good older than the stale limit is withdrawn with a 502', async () => {
  let clock = 0;
  let down = false;
  const service = upstream({
    fail: () => (down ? new Response('down', { status: 503 }) : null),
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  await request();
  down = true;
  clock = SA_ROAD_EVENTS_POLICY.staleLimitMs;
  assert.equal((await request()).status, 200, 'still inside the limit');
  clock = SA_ROAD_EVENTS_POLICY.staleLimitMs + 1;
  const expired = await request();
  assert.equal(expired.status, 502);
  assert.deepEqual(expired.body, { error: 'sa_road_events_unavailable' });
  assert.equal(SA_ROAD_EVENTS_POLICY.staleLimitMs, 6 * 3_600_000);
});

test('a cold failure is a sanitized 502 and backs off', async () => {
  let clock = 0;
  const service = upstream({
    fail: () => new Response('down', { status: 500 }),
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  const first = await request();
  assert.equal(first.status, 502);
  assert.deepEqual(first.body, { error: 'sa_road_events_unavailable' });
  const calls = service.calls.length;
  clock = SA_ROAD_EVENTS_POLICY.retryAfterFailureMs - 1;
  assert.equal((await request()).status, 502);
  assert.equal(service.calls.length, calls, 'backed off');
  clock = SA_ROAD_EVENTS_POLICY.retryAfterFailureMs;
  await request();
  assert.ok(service.calls.length > calls, 'retries after the backoff');
});

test('a 429 is honoured: bounded Retry-After backoff and no mirror shopping', async () => {
  let clock = 0;
  const service = upstream({
    fail: () =>
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '300' },
      }),
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  assert.equal((await request()).status, 502);
  assert.equal(
    service.calls.length,
    1,
    'the mirror is not tried on a rate limit',
  );
  clock = 299_999;
  await request();
  assert.equal(service.calls.length, 1, 'waits out Retry-After');
  clock = 300_000;
  await request();
  assert.equal(service.calls.length, 2);

  const huge = upstream({
    fail: () =>
      new Response('', { status: 429, headers: { 'retry-after': '999999' } }),
  });
  clock = 0;
  const bounded = install({ now: () => clock, fetchImpl: huge.fetchImpl });
  await bounded();
  clock = SA_ROAD_EVENTS_POLICY.maxRetryAfterMs;
  await bounded();
  assert.equal(huge.calls.length, 2, 'Retry-After is capped');
});

test('a non-OK upstream body is cancelled and an oversized one is refused', async () => {
  let cancelled = 0;
  const service = upstream({
    fail: (request) =>
      request.service === 'TrafficSAOpenData'
        ? {
            ok: false,
            status: 500,
            headers: new Headers(),
            body: {
              cancel: async () => {
                cancelled++;
              },
            },
          }
        : null,
  });
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.equal(res.body.mirror, true, 'the mirror covers the failed primary');
  assert.equal(cancelled, 1);

  const big = upstream({ points: pointFeatures(200) });
  const small = install({
    now: () => 0,
    policy: { ...SA_ROAD_EVENTS_POLICY, maxPageBytes: 1024 },
    fetchImpl: big.fetchImpl,
  });
  assert.equal((await small()).status, 502);
});

test('methods, routes and per-client rate limits are enforced', async () => {
  const service = upstream();
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal((await request('/other')).status, 404);
  assert.deepEqual((await request('/other')).body, { error: 'unknown_route' });
  assert.equal(
    service.calls.length,
    0,
    'rejected requests never reach the upstream',
  );
  for (let i = 0; i < 30; i++)
    assert.equal((await request('/', 'GET', 'busy')).status, 200);
  const limited = await request('/', 'GET', 'busy');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Retry-After'], '60');
  assert.equal((await request('/', 'GET', 'other')).status, 200);
});
