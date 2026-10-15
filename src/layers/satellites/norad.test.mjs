import test from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec } from 'satellite.js';
import { noradIdFromSatnum } from './policy.js';

test('noradIdFromSatnum leaves five-digit fields unchanged', () => {
  assert.equal(noradIdFromSatnum('25544'), 25544);
  assert.equal(noradIdFromSatnum('00005'), 5);
  assert.equal(noradIdFromSatnum(25544), 25544);
});

test('noradIdFromSatnum decodes Alpha-5 leaders A-Z skipping I and O', () => {
  assert.equal(noradIdFromSatnum('A0000'), 100000);
  assert.equal(noradIdFromSatnum('Z9999'), 339999);
  // I and O are skipped: H -> 17, J -> 18, N -> 22, P -> 23.
  assert.equal(noradIdFromSatnum('H9999'), 179999);
  assert.equal(noradIdFromSatnum('J0000'), 180000);
  assert.equal(noradIdFromSatnum('N9999'), 229999);
  assert.equal(noradIdFromSatnum('P0000'), 230000);
});

test('noradIdFromSatnum falls back to Number for anything else', () => {
  // I and O never start an Alpha-5 field; behavior is unchanged (NaN).
  assert.ok(Number.isNaN(noradIdFromSatnum('I0000')));
  assert.ok(Number.isNaN(noradIdFromSatnum('O0000')));
  assert.ok(Number.isNaN(noradIdFromSatnum('A000')));
  // Short or empty fields go through Number exactly as before.
  assert.equal(noradIdFromSatnum(''), 0);
});

test('Alpha-5 satnums no longer collapse onto one NaN dedupe key', () => {
  const l1 = '1 A0000U 26067CY  26195.90649229  .00004770  00000+0  22159-3 0  9994';
  const l2 = '2 A0000  97.4593 154.0970 0005590 270.5113  89.5482 15.20467281 15911';
  const ids = ['A0000', 'A0001'].map((satnum) => {
    const rec = twoline2satrec(l1.replaceAll('A0000', satnum), l2.replaceAll('A0000', satnum));
    return noradIdFromSatnum(rec.satnum);
  });
  assert.deepEqual(ids, [100000, 100001]);
  assert.equal(new Set(ids).size, 2);
});
