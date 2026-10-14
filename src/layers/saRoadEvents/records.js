/**
 * Traffic SA roadworks, incidents and closures: normalization and validation.
 *
 * Pure (no Cesium, no I/O) and shared by the server proxy, the browser source
 * and the tests. Upstream rows are individually untrusted: a bad row is
 * skipped, never fatal. Only a payload that is not a feature collection at all
 * (or that has rows but not one usable row) rejects the whole snapshot, so a
 * schema change fails loudly into the proxy's last-good path instead of
 * blanking the layer.
 *
 * Every text field is plain text. HTML-looking markup in upstream descriptions
 * is stripped here and the overlay card draws text only.
 */

/** Point kinds, from the upstream REC_TYPE. */
export const SA_ROAD_POINT_KINDS = Object.freeze([
  'incident',
  'works24',
  'works',
  'unknown',
]);
/** Line kinds, from the upstream PLOT_TYPE. */
export const SA_ROAD_LINE_KINDS = Object.freeze([
  'closure',
  'detour',
  'unknown',
]);

/** South Australia with margin (covers the state and offshore waters). */
export const SA_BOUNDS = Object.freeze({
  west: 128.5,
  east: 141.5,
  south: -38.6,
  north: -25.5,
});

/** Hard bounds on what one snapshot can carry. */
export const SA_ROAD_EVENT_LIMITS = Object.freeze({
  maxPoints: 20_000,
  maxLines: 2_000,
  maxLineVertices: 1_000,
  maxTotalVertices: 60_000,
  maxLinesPerFeature: 50,
});

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const SHORT_TEXT = 160;
const LONG_TEXT = 1_500;

/**
 * Reduce an untrusted upstream string to bounded plain text.
 * @param {*} value - Candidate text.
 * @param {number} [max] - Maximum characters kept.
 * @returns {string|null} Clean text, or null when nothing readable remains.
 */
export function cleanText(value, max = SHORT_TEXT) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?[a-z!][^>]*>/gi, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
      ' ',
    )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const ADELAIDE_FIELDS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Australia/Adelaide',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function adelaideOffsetMs(instant) {
  const p = Object.fromEntries(
    ADELAIDE_FIELDS.formatToParts(instant).map(({ type, value }) => [
      type,
      Number(value),
    ]),
  );
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(instant / 1000) * 1000
  );
}

/**
 * Traffic SA stores Adelaide wall-clock times in its date fields as if they
 * were UTC (START_DATE_STRING "Mon 01 Sep 2025 08:00 PM" arrives as the epoch
 * of 2025-09-01T20:00Z). Convert such a value to the real instant.
 * @param {*} wallMs - Epoch ms whose UTC fields are Adelaide local time.
 * @returns {number|null} UTC epoch ms, or null when not a usable time.
 */
export function adelaideWallClockToInstant(wallMs) {
  if (!Number.isFinite(wallMs)) return null;
  try {
    const guess = wallMs - adelaideOffsetMs(wallMs);
    const instant = wallMs - adelaideOffsetMs(guess);
    return Number.isFinite(instant) ? instant : null;
  } catch {
    return null;
  }
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

function recordId(feature, ...candidates) {
  for (const value of [...candidates, feature?.id]) {
    const text =
      typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : typeof value === 'string'
          ? value.trim()
          : '';
    if (ID_PATTERN.test(text)) return text;
  }
  return null;
}

/** True when a lon/lat pair is finite and inside the South Australia bounds. */
export function inSaBounds(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= SA_BOUNDS.west &&
    lon <= SA_BOUNDS.east &&
    lat >= SA_BOUNDS.south &&
    lat <= SA_BOUNDS.north
  );
}

/** Round to ~1 cm; keeps the wire payload small and signatures stable. */
const round = (value) => Math.round(value * 1e7) / 1e7;

/**
 * Map the upstream REC_TYPE to a point kind.
 * @param {*} recType - Upstream REC_TYPE.
 * @returns {'incident'|'works24'|'works'|'unknown'}
 */
export function pointKind(recType) {
  const text = typeof recType === 'string' ? recType.trim().toUpperCase() : '';
  if (text === 'INCIDENT') return 'incident';
  if (text === '24HR ROADWORKS') return 'works24';
  if (text === 'ROADWORKS') return 'works';
  return 'unknown';
}

/**
 * Map the upstream PLOT_TYPE to a line kind.
 * @param {*} plotType - Upstream PLOT_TYPE (e.g. "RD_CLOSURE").
 * @returns {'closure'|'detour'|'unknown'}
 */
export function lineKind(plotType) {
  const text = typeof plotType === 'string' ? plotType.trim() : '';
  if (/detour/i.test(text)) return 'detour';
  if (/clos/i.test(text)) return 'closure';
  return 'unknown';
}

function normalizePoint(feature) {
  const properties = feature?.properties;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  )
    return null;
  const geometry = feature.geometry;
  if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates))
    return null;
  const [lon, lat] = geometry.coordinates;
  if (!inSaBounds(lon, lat)) return null;
  const id = recordId(feature, properties.ROADWORKS_AND_INCIDENTS_ID);
  if (!id) return null;
  return {
    id,
    kind: pointKind(properties.REC_TYPE),
    description: cleanText(properties.DESCRIPTION, LONG_TEXT),
    road: cleanText(properties.LOCAL_ROAD),
    sideStreet: cleanText(properties.SIDE_STREET),
    suburb: cleanText(properties.SUBURB),
    direction: cleanText(properties.TRAFFIC_DIR, 40),
    lanesClosed: cleanText(properties.NO_LANES_CLOSED, 40),
    speedLimit: cleanText(
      typeof properties.SPEED_LIMIT === 'number'
        ? String(properties.SPEED_LIMIT)
        : properties.SPEED_LIMIT,
      40,
    ),
    startMs: adelaideWallClockToInstant(properties.START_DATE),
    endMs: adelaideWallClockToInstant(properties.END_DATE),
    lon: round(lon),
    lat: round(lat),
  };
}

/** Normalize one GeoJSON line geometry to arrays of [lon, lat] vertices. */
function normalizeLineGeometry(geometry, budget) {
  let parts;
  if (geometry?.type === 'LineString') parts = [geometry.coordinates];
  else if (geometry?.type === 'MultiLineString') parts = geometry.coordinates;
  else return null;
  if (
    !Array.isArray(parts) ||
    !parts.length ||
    parts.length > SA_ROAD_EVENT_LIMITS.maxLinesPerFeature
  )
    return null;
  const lines = [];
  let vertices = 0;
  for (const part of parts) {
    if (!Array.isArray(part) || part.length < 2) return null;
    const stride = Math.max(
      1,
      Math.ceil((part.length - 1) / (SA_ROAD_EVENT_LIMITS.maxLineVertices - 1)),
    );
    const line = [];
    for (let i = 0; i < part.length; i += stride) line.push(part[i]);
    // Thinning keeps the first and last vertex so the closure still joins up.
    if (line[line.length - 1] !== part[part.length - 1])
      line.push(part[part.length - 1]);
    for (const position of line) {
      if (!Array.isArray(position) || !inSaBounds(position[0], position[1]))
        return null;
    }
    vertices += line.length;
    lines.push(line.map(([lon, lat]) => [round(lon), round(lat)]));
  }
  if (vertices > budget) return null;
  return { lines, vertices };
}

const streets = (properties, prefix) =>
  [1, 2, 3]
    .map((n) => cleanText(properties[`${prefix}_SIDE_STREET_NAME${n}`]))
    .filter(Boolean);

function normalizeLine(feature, budget) {
  const properties = feature?.properties;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  )
    return null;
  const id = recordId(feature, properties.LOCATION_ID);
  if (!id) return null;
  const geometry = normalizeLineGeometry(feature.geometry, budget);
  if (!geometry) return null;
  const middle = geometry.lines[0][Math.floor(geometry.lines[0].length / 2)];
  return {
    record: {
      id,
      kind: lineKind(properties.PLOT_TYPE),
      details: cleanText(
        properties.PLOT_DETAILS || properties.PLOT_ALT_TEXT,
        LONG_TEXT,
      ),
      road: cleanText(properties.LOCAL_ROAD_NAME),
      startStreets: streets(properties, 'START'),
      startSuburb: cleanText(properties.START_SUBURB),
      endStreets: streets(properties, 'END'),
      endSuburb: cleanText(properties.END_SUBURB),
      startMs: adelaideWallClockToInstant(properties.START_DATE),
      endMs: adelaideWallClockToInstant(properties.END_DATE),
      anchor: middle,
      lines: geometry.lines,
    },
    vertices: geometry.vertices,
  };
}

const isFeatureCollection = (value) =>
  value?.type === 'FeatureCollection' && Array.isArray(value.features);

/**
 * Normalize the roadworks/incidents point collection.
 * @param {object} collection - GeoJSON FeatureCollection (pages already joined).
 * @returns {{records: object[], skipped: number}|null} null when the payload
 *   is not a feature collection or none of its rows is usable.
 */
export function normalizeSaRoadEventPoints(collection) {
  if (!isFeatureCollection(collection)) return null;
  const records = [];
  const ids = new Set();
  let skipped = 0;
  for (const feature of collection.features) {
    const record =
      records.length < SA_ROAD_EVENT_LIMITS.maxPoints
        ? normalizePoint(feature)
        : null;
    if (!record || ids.has(record.id)) {
      skipped++;
      continue;
    }
    ids.add(record.id);
    records.push(record);
  }
  if (collection.features.length && !records.length) return null;
  return { records, skipped };
}

/**
 * Normalize the closures/detours line collection.
 * @param {object} collection - GeoJSON FeatureCollection.
 * @returns {{records: object[], skipped: number}|null} null when the payload
 *   is not a feature collection or none of its rows is usable.
 */
export function normalizeSaRoadEventLines(collection) {
  if (!isFeatureCollection(collection)) return null;
  const records = [];
  const ids = new Set();
  let skipped = 0;
  let vertices = 0;
  for (const feature of collection.features) {
    const result =
      records.length < SA_ROAD_EVENT_LIMITS.maxLines
        ? normalizeLine(
            feature,
            SA_ROAD_EVENT_LIMITS.maxTotalVertices - vertices,
          )
        : null;
    if (!result || ids.has(result.record.id)) {
      skipped++;
      continue;
    }
    ids.add(result.record.id);
    vertices += result.vertices;
    records.push(result.record);
  }
  if (collection.features.length && !records.length) return null;
  return { records, skipped };
}

/**
 * Normalize both Traffic SA collections into one snapshot body.
 * @param {{points: object, lines: object}} collections - Joined FeatureCollections.
 * @returns {{points: object[], lines: object[]}|null} null when either
 *   collection is unusable (the caller keeps its last good snapshot).
 */
export function normalizeSaRoadEventSnapshot(collections) {
  const points = normalizeSaRoadEventPoints(collections?.points);
  const lines = normalizeSaRoadEventLines(collections?.lines);
  if (!points || !lines) return null;
  return { points: points.records, lines: lines.records };
}

const textOrNull = (value, max) =>
  value === null || (typeof value === 'string' && value.length <= max);

/** Strict check of a record that already went through the normalizer. */
function validPointRecord(record) {
  return (
    Boolean(record) &&
    typeof record === 'object' &&
    ID_PATTERN.test(record.id) &&
    SA_ROAD_POINT_KINDS.includes(record.kind) &&
    inSaBounds(record.lon, record.lat) &&
    textOrNull(record.description, LONG_TEXT) &&
    textOrNull(record.road, SHORT_TEXT) &&
    textOrNull(record.sideStreet, SHORT_TEXT) &&
    textOrNull(record.suburb, SHORT_TEXT) &&
    textOrNull(record.direction, 40) &&
    textOrNull(record.lanesClosed, 40) &&
    textOrNull(record.speedLimit, 40) &&
    (record.startMs === null || Number.isFinite(record.startMs)) &&
    (record.endMs === null || Number.isFinite(record.endMs))
  );
}

function validLineRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (!ID_PATTERN.test(record.id) || !SA_ROAD_LINE_KINDS.includes(record.kind))
    return false;
  if (
    !textOrNull(record.details, LONG_TEXT) ||
    !textOrNull(record.road, SHORT_TEXT) ||
    !textOrNull(record.startSuburb, SHORT_TEXT) ||
    !textOrNull(record.endSuburb, SHORT_TEXT) ||
    !Array.isArray(record.startStreets) ||
    !Array.isArray(record.endStreets) ||
    record.startStreets.length > 3 ||
    record.endStreets.length > 3 ||
    ![...record.startStreets, ...record.endStreets].every(
      (name) => typeof name === 'string' && name.length <= SHORT_TEXT,
    )
  )
    return false;
  if (
    (record.startMs !== null && !Number.isFinite(record.startMs)) ||
    (record.endMs !== null && !Number.isFinite(record.endMs))
  )
    return false;
  if (
    !Array.isArray(record.anchor) ||
    !inSaBounds(record.anchor[0], record.anchor[1])
  )
    return false;
  if (
    !Array.isArray(record.lines) ||
    !record.lines.length ||
    record.lines.length > SA_ROAD_EVENT_LIMITS.maxLinesPerFeature
  )
    return false;
  return record.lines.every(
    (line) =>
      Array.isArray(line) &&
      line.length >= 2 &&
      line.length <= SA_ROAD_EVENT_LIMITS.maxLineVertices + 1 &&
      line.every(
        (position) =>
          Array.isArray(position) && inSaBounds(position[0], position[1]),
      ),
  );
}

/**
 * Validate a proxy response body as a whole before anything is rendered.
 * Unlike the upstream normalizer this never skips: a single malformed record
 * means the payload is not from our proxy, so the whole snapshot is refused.
 * @param {*} payload - Parsed `/api/sa-road-events` body.
 * @returns {{points: object[], lines: object[], fetchedAt: number,
 *   stale: boolean, mirror: boolean}|null} The snapshot, or null if malformed.
 */
export function validateSaRoadEventsPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { points, lines, fetchedAt } = payload;
  if (!Array.isArray(points) || !Array.isArray(lines)) return null;
  if (!Number.isFinite(fetchedAt)) return null;
  if (
    points.length > SA_ROAD_EVENT_LIMITS.maxPoints ||
    lines.length > SA_ROAD_EVENT_LIMITS.maxLines
  )
    return null;
  const ids = new Set();
  for (const record of points) {
    if (!validPointRecord(record) || ids.has(record.id)) return null;
    ids.add(record.id);
  }
  ids.clear();
  let vertices = 0;
  for (const record of lines) {
    if (!validLineRecord(record) || ids.has(record.id)) return null;
    ids.add(record.id);
    for (const line of record.lines) vertices += line.length;
  }
  if (vertices > SA_ROAD_EVENT_LIMITS.maxTotalVertices) return null;
  return {
    points,
    lines,
    fetchedAt,
    stale: payload.stale === true,
    mirror: payload.mirror === true,
  };
}
