import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SA_ROAD_EVENT_LIMITS,
  adelaideWallClockToInstant,
  cleanText,
  lineKind,
  normalizeSaRoadEventLines,
  normalizeSaRoadEventPoints,
  normalizeSaRoadEventSnapshot,
  pointKind,
  validateSaRoadEventsPayload,
} from './records.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../data/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
const pointsFixture = fixture('trafficsa-points-sample.json');
const linesFixture = fixture('trafficsa-lines.json');

const collection = (features) => ({ type: 'FeatureCollection', features });
const point = (properties = {}, coordinates = [138.6, -34.9]) => ({
  type: 'Feature',
  id: 1,
  geometry: { type: 'Point', coordinates },
  properties: {
    ROADWORKS_AND_INCIDENTS_ID: '100',
    REC_TYPE: 'INCIDENT',
    ...properties,
  },
});
const line = (properties = {}, geometry) => ({
  type: 'Feature',
  id: 7,
  geometry: geometry || {
    type: 'LineString',
    coordinates: [
      [138.6, -34.9],
      [138.61, -34.91],
    ],
  },
  properties: { LOCATION_ID: 7, PLOT_TYPE: 'RD_CLOSURE', ...properties },
});

test('real point rows keep their kind, text, times and coordinates', () => {
  const { records, skipped } = normalizeSaRoadEventPoints(pointsFixture);
  assert.equal(skipped, 0);
  assert.equal(records.length, pointsFixture.features.length);
  const kinds = new Set(records.map(({ kind }) => kind));
  assert.deepEqual([...kinds].sort(), ['incident', 'works', 'works24']);
  const incident = records.find(({ kind }) => kind === 'incident');
  assert.equal(incident.id, '3398487668');
  assert.equal(incident.description, 'Ferry Closed');
  assert.equal(incident.road, 'Birdsville Track');
  assert.equal(incident.endMs, null, 'an open-ended incident has no end');
  assert.equal(incident.startMs, Date.parse('2026-04-08T15:40:50+09:30'));
  assert.equal(incident.direction, null);
  assert.ok(Math.abs(incident.lon - 138.6395252) < 1e-6);
  assert.ok(Math.abs(incident.lat - -28.7112356) < 1e-6);
  const works = records.find(({ id }) => id === '3398487791');
  assert.equal(works.kind, 'works');
  assert.equal(works.sideStreet, 'Patricia St');
  assert.equal(works.suburb, 'Woodville South');
  assert.equal(works.direction, 'South Bound');
  assert.equal(works.lanesClosed, 'One Lane');
  assert.equal(works.speedLimit, '40');
  assert.equal(works.endMs, Date.parse('2026-10-19T16:00:00+10:30'));
  assert.equal(works.startMs, Date.parse('2026-10-05T09:00:00+10:30'));
});

test('upstream wall-clock times become real instants across daylight saving', () => {
  const wall = (iso) => Date.parse(`${iso}Z`);
  // Winter (ACST, +09:30) and summer (ACDT, +10:30).
  assert.equal(
    adelaideWallClockToInstant(wall('2025-09-01T20:00:00')),
    Date.parse('2025-09-01T20:00:00+09:30'),
  );
  assert.equal(
    adelaideWallClockToInstant(wall('2026-01-15T08:00:00')),
    Date.parse('2026-01-15T08:00:00+10:30'),
  );
  // The weekend daylight saving starts (4 Oct 2026, 02:00 -> 03:00).
  assert.equal(
    adelaideWallClockToInstant(wall('2026-10-04T01:59:00')),
    Date.parse('2026-10-04T01:59:00+09:30'),
  );
  assert.equal(
    adelaideWallClockToInstant(wall('2026-10-04T03:30:00')),
    Date.parse('2026-10-04T03:30:00+10:30'),
  );
  for (const bad of [null, undefined, NaN, 'x', Infinity, 1e20])
    assert.equal(adelaideWallClockToInstant(bad), null);
});

test('REC_TYPE and PLOT_TYPE map to kinds; anything new is unknown', () => {
  assert.equal(pointKind('INCIDENT'), 'incident');
  assert.equal(pointKind(' 24hr roadworks '), 'works24');
  assert.equal(pointKind('ROADWORKS'), 'works');
  assert.equal(pointKind('FLOODING'), 'unknown');
  assert.equal(pointKind(null), 'unknown');
  assert.equal(lineKind('RD_CLOSURE'), 'closure');
  assert.equal(lineKind('RD_DETOUR'), 'detour');
  assert.equal(lineKind('SOMETHING_ELSE'), 'unknown');
  assert.equal(lineKind(undefined), 'unknown');
});

test('real closure lines normalize, including a null END_DATE and CRLF details', () => {
  const { records, skipped } = normalizeSaRoadEventLines(linesFixture);
  assert.equal(skipped, 0);
  assert.equal(records.length, 8);
  assert.ok(records.every(({ kind }) => kind === 'closure'));
  const flood = records.find(({ id }) => id === '105527');
  assert.equal(flood.endMs, null);
  assert.equal(flood.road, 'MORGAN VALE ROAD');
  assert.deepEqual(flood.startStreets, ['PINE VALLEY RD']);
  assert.deepEqual(flood.endStreets, ['MORGAN MAIL RD']);
  assert.equal(flood.startSuburb, 'PINE VALLEY STATION');
  assert.equal(flood.endSuburb, 'CANEGRASS');
  assert.equal(
    flood.details,
    'MORGAN MAIL RD Closed due to flooding over road\n\nRef# 2138578',
    'CRLF becomes newlines and no carriage return survives',
  );
  assert.ok(!records.some(({ details }) => details?.includes('\r')));
  const dated = records.find(({ id }) => id === '105525');
  assert.equal(dated.endMs, 1806604620000 - 10.5 * 3600000);
  assert.ok(
    !dated.details.includes('<br>'),
    'markup inside PLOT_DETAILS is not kept',
  );
  assert.equal(flood.lines.length, 1);
  assert.equal(flood.lines[0].length, 13);
  assert.deepEqual(flood.anchor, flood.lines[0][6]);
});

test('MultiLineString geometry is accepted as several lines of one event', () => {
  const result = normalizeSaRoadEventLines(
    collection([
      line(
        {},
        {
          type: 'MultiLineString',
          coordinates: [
            [
              [138.6, -34.9],
              [138.61, -34.91],
            ],
            [
              [138.7, -34.8],
              [138.71, -34.81],
            ],
          ],
        },
      ),
    ]),
  );
  assert.equal(result.records[0].lines.length, 2);
});

test('text is plain: markup, controls and oversize input are neutralised', () => {
  assert.equal(
    cleanText('<script>alert(1)</script>Hello<br/>World <b>now</b>'),
    'alert(1) Hello\nWorld now',
  );
  assert.equal(
    cleanText('  a\u0000b\u202ec \r\n\r\n\r\n\r\nd  '),
    'a b c\n\nd',
  );
  assert.equal(cleanText('   '), null);
  assert.equal(cleanText(42), null);
  assert.equal(cleanText('x'.repeat(500), 10).length, 10);
  assert.ok(cleanText('x'.repeat(500), 10).endsWith('…'));
  const { records } = normalizeSaRoadEventPoints(
    collection([
      point({ DESCRIPTION: '<img src=x onerror=alert(1)>Crash', SUBURB: ' ' }),
    ]),
  );
  assert.equal(records[0].description, 'Crash');
  assert.equal(records[0].suburb, null);
});

test('rows with bad geometry, ids or coordinates are skipped, not fatal', () => {
  const id = (value) => ({ ROADWORKS_AND_INCIDENTS_ID: value });
  const { records, skipped } = normalizeSaRoadEventPoints(
    collection([
      point(id('1')),
      null,
      { type: 'Feature', geometry: null, properties: {} },
      point(id('2'), [NaN, -34.9]),
      point(id('3'), [151.2, -33.9]),
      point(id('4'), [138.6, 34.9]),
      point(id('5'), [138.6]),
      { ...point(id('6')), properties: [] },
      { ...point(id('7')), geometry: { type: 'LineString', coordinates: [] } },
      point(id('bad id!')),
      { ...point(id(null)), id: undefined },
    ]),
  );
  assert.deepEqual(
    records.map((record) => record.id),
    ['1'],
  );
  assert.equal(skipped, 10);
});

test('the SA bounds include the state edges and reject neighbours', () => {
  const at = (lon, lat) =>
    normalizeSaRoadEventPoints(collection([point({}, [lon, lat])]));
  assert.ok(at(129.0, -31.7), 'Nullarbor edge');
  assert.ok(at(140.9, -37.5), 'Mount Gambier');
  assert.ok(at(135.8, -25.9), 'northern border');
  assert.equal(at(145, -37.8), null, 'Melbourne');
  assert.equal(at(115.9, -31.9), null, 'Perth');
  assert.equal(at(0, 0), null, 'null island');
});

test('duplicate ids keep the first row only', () => {
  const { records, skipped } = normalizeSaRoadEventPoints(
    collection([
      point({ DESCRIPTION: 'first' }),
      point({ DESCRIPTION: 'second' }),
    ]),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].description, 'first');
  assert.equal(skipped, 1);
  const lines = normalizeSaRoadEventLines(
    collection([line({}), line({ PLOT_DETAILS: 'again' })]),
  );
  assert.equal(lines.records.length, 1);
  assert.equal(lines.skipped, 1);
});

test('the numeric feature id is used when the id property is missing', () => {
  const { records } = normalizeSaRoadEventPoints(
    collection([point({ ROADWORKS_AND_INCIDENTS_ID: undefined })]),
  );
  assert.equal(records[0].id, '1');
});

test('payloads that are not feature collections are rejected whole', () => {
  const empty = collection([]);
  for (const bad of [
    null,
    undefined,
    [],
    'File Unavailable',
    { error: { code: 400, message: 'Failed to execute query.' } },
    { type: 'Feature', features: [] },
    { type: 'FeatureCollection' },
    { type: 'FeatureCollection', features: {} },
  ]) {
    assert.equal(normalizeSaRoadEventPoints(bad), null);
    assert.equal(normalizeSaRoadEventLines(bad), null);
    assert.equal(
      normalizeSaRoadEventSnapshot({ points: bad, lines: empty }),
      null,
    );
    assert.equal(
      normalizeSaRoadEventSnapshot({ points: empty, lines: bad }),
      null,
    );
  }
  assert.equal(normalizeSaRoadEventSnapshot(null), null);
});

test('a collection with rows but no usable row is a failure; an empty one is not', () => {
  assert.equal(
    normalizeSaRoadEventPoints(
      collection([{ type: 'Feature', properties: {}, geometry: null }]),
    ),
    null,
    'a schema change must not look like an empty network',
  );
  assert.deepEqual(normalizeSaRoadEventPoints(collection([])), {
    records: [],
    skipped: 0,
  });
  assert.deepEqual(
    normalizeSaRoadEventSnapshot({
      points: collection([point()]),
      lines: collection([]),
    }).lines,
    [],
    'no active closures is a valid state',
  );
});

test('long lines are thinned to the vertex bound and keep both endpoints', () => {
  const coordinates = Array.from({ length: 5000 }, (_, i) => [
    138 + i / 10000,
    -34.5,
  ]);
  const { records } = normalizeSaRoadEventLines(
    collection([line({}, { type: 'LineString', coordinates })]),
  );
  const [vertices] = records[0].lines;
  assert.ok(vertices.length <= SA_ROAD_EVENT_LIMITS.maxLineVertices + 1);
  assert.deepEqual(vertices[0], [138, -34.5]);
  assert.deepEqual(vertices.at(-1), [138.4999, -34.5]);
});

test('the snapshot-wide vertex budget skips lines instead of growing without bound', () => {
  const longLine = (id) =>
    line(
      { LOCATION_ID: id },
      {
        type: 'LineString',
        coordinates: Array.from({ length: 1000 }, (_, i) => [
          138 + i / 100000,
          -34.5,
        ]),
      },
    );
  const features = Array.from({ length: 80 }, (_, i) => longLine(i + 1));
  const { records, skipped } = normalizeSaRoadEventLines(collection(features));
  const vertices = records.reduce(
    (sum, record) => sum + record.lines.reduce((n, l) => n + l.length, 0),
    0,
  );
  assert.ok(vertices <= SA_ROAD_EVENT_LIMITS.maxTotalVertices);
  assert.ok(skipped > 0);
});

test('lines with out-of-state, malformed or too-short geometry are skipped', () => {
  const bad = (geometry, id) => line({ LOCATION_ID: id }, geometry);
  const { records, skipped } = normalizeSaRoadEventLines(
    collection([
      line({ LOCATION_ID: 1 }),
      bad({ type: 'Point', coordinates: [138.6, -34.9] }, 2),
      bad({ type: 'LineString', coordinates: [[138.6, -34.9]] }, 3),
      bad(
        {
          type: 'LineString',
          coordinates: [
            [138.6, -34.9],
            [151.2, -33.9],
          ],
        },
        4,
      ),
      bad({ type: 'LineString', coordinates: 'nope' }, 5),
      bad({ type: 'MultiLineString', coordinates: [] }, 6),
    ]),
  );
  assert.deepEqual(
    records.map((record) => record.id),
    ['1'],
  );
  assert.equal(skipped, 5);
});

test('validatePayload accepts a proxy-shaped body and refuses anything malformed', () => {
  const points = normalizeSaRoadEventPoints(pointsFixture).records;
  const lines = normalizeSaRoadEventLines(linesFixture).records;
  const body = { points, lines, fetchedAt: 1_700_000_000_000 };
  const ok = validateSaRoadEventsPayload({
    ...body,
    stale: true,
    mirror: true,
  });
  assert.equal(ok.points.length, points.length);
  assert.equal(ok.stale, true);
  assert.equal(ok.mirror, true);
  assert.equal(validateSaRoadEventsPayload(body).stale, false);

  const mutate = (change) => {
    const next = structuredClone(body);
    change(next);
    return next;
  };
  for (const bad of [
    null,
    [],
    {},
    mutate((b) => delete b.points),
    mutate((b) => (b.lines = {})),
    mutate((b) => (b.fetchedAt = 'now')),
    mutate((b) => (b.fetchedAt = NaN)),
    mutate((b) => (b.points[0].kind = 'volcano')),
    mutate((b) => (b.points[0].lon = 0)),
    mutate((b) => (b.points[0].id = '../x')),
    mutate((b) => (b.points[1].id = b.points[0].id)),
    mutate((b) => (b.points[0].description = 5)),
    mutate((b) => (b.points[0].startMs = '2026')),
    mutate((b) => (b.lines[0].lines = [])),
    mutate((b) => (b.lines[0].lines[0][0] = [0, 0])),
    mutate((b) => (b.lines[0].startStreets = 'x')),
    mutate((b) => (b.lines[0].anchor = null)),
    mutate((b) => (b.lines[1].id = b.lines[0].id)),
  ])
    assert.equal(validateSaRoadEventsPayload(bad), null);
});
