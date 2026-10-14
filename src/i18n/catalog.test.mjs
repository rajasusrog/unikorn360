import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkCatalog,
  extractMessages,
  findUnmarked,
  readCatalog,
  shippedLocales,
  unmarkedMarkup,
  unmarkedScript,
} from '../../scripts/i18n.mjs';
import { LOCALES } from './locale.js';

const messages = extractMessages();

test('every catalog file is a shipped locale and every non-English locale has a catalog', () => {
  assert.deepEqual(
    shippedLocales().sort(),
    LOCALES.filter((locale) => locale !== 'en').sort(),
  );
});

for (const locale of shippedLocales()) {
  test(`${locale} catalog matches the code (npm run i18n)`, () => {
    const { missing, stale, errors } = checkCatalog(
      locale,
      readCatalog(locale),
      messages,
    );
    assert.deepEqual(
      { missing, stale, errors },
      { missing: [], stale: [], errors: [] },
    );
  });
}

test('every UI string is marked for translation or kept on purpose (npm run i18n)', () => {
  assert.deepEqual(
    findUnmarked().map(({ where, text }) => `${where}  ${text}`),
    [],
  );
});

test('checkCatalog reports missing, stale, placeholder and plural problems', () => {
  const fixture = new Map([
    ['Saved {name}', { plural: false }],
    ['{count} keys', { plural: true, one: '{count} key' }],
    ['Untranslated', { plural: false }],
  ]);
  const result = checkCatalog(
    'ru',
    {
      'Saved {name}': 'Сохранено {nmae}',
      '{count} keys': {
        one: '{count} ключ',
        few: '{count} ключа',
        many: '{count} ключей',
      },
      Removed: 'Удалено',
    },
    fixture,
  );
  assert.deepEqual(result.missing, ['Untranslated']);
  assert.deepEqual(result.stale, ['Removed']);
  assert.equal(result.errors.length, 2);
});

test('checkCatalog reports a translation left in English unless it is allowed', () => {
  const fixture = new Map([
    ['Bloom', { plural: false }],
    ['HDG', { plural: false }],
    ['voice|READY', { plural: false }],
    ['{state} · {source}', { plural: false }],
  ]);
  const catalog = {
    Bloom: 'Bloom',
    HDG: 'HDG',
    'voice|READY': 'READY',
    '{state} · {source}': '{state} · {source}',
  };
  const errors = (allowed) =>
    checkCatalog('es', catalog, fixture, new Set(allowed)).errors;
  assert.deepEqual(
    errors([]).map((error) => error.split(' is still English')[0]),
    ['"Bloom"', '"HDG"', '"voice|READY"'],
  );
  assert.deepEqual(errors(['Bloom', 'HDG', 'voice|READY']), []);
});

test('unmarkedMarkup finds text and attributes without data-i18n*', () => {
  const texts = (html) => unmarkedMarkup('f.html', html).map((f) => f.text);
  assert.deepEqual(texts('<span>Close</span>'), ['Close']);
  assert.deepEqual(texts('<span data-i18n>Close</span>'), []);
  assert.deepEqual(texts('<button title="Pin it">x</button>'), [
    'title="Pin it"',
  ]);
  assert.deepEqual(
    texts('<button title="Pin it" data-i18n-title>x</button>'),
    [],
  );
  assert.deepEqual(
    texts('<select translate="no"><option>0.9 dB</option></select>'),
    [],
  );
  assert.deepEqual(texts('<b data-i18n-runtime><i>OFF</i></b>'), []);
  assert.deepEqual(
    texts('<span class="material-symbols-outlined">public</span>'),
    [],
  );
  assert.deepEqual(texts('<!-- Note --><span>— 42 —</span>'), []);
});

test('unmarkedScript finds literals that reach the page without t/tn/msg', () => {
  const texts = (js) => unmarkedScript('f.js', js).map((f) => f.text);
  assert.deepEqual(texts("el.textContent = 'Saved';"), ['Saved']);
  assert.deepEqual(texts("el.textContent = t('Saved');"), []);
  assert.deepEqual(texts("el.textContent = on ? 'On air' : 'Off air';"), [
    'On air',
    'Off air',
  ]);
  assert.deepEqual(texts("el.setAttribute('aria-label', `Open ${name}`);"), [
    'Open',
  ]);
  assert.deepEqual(
    texts("const row = { label: msg('Wind'), id: 'wind' };"),
    [],
  );
  assert.deepEqual(texts("const row = { label: 'Wind' };"), ['Wind']);
  assert.deepEqual(texts("el.textContent = labelFor('flights');"), []);
  assert.deepEqual(texts("el.className = 'is-active';"), []);
  assert.deepEqual(texts("el.title = mode === 'Auto mode' ? a : b;"), []);
  assert.deepEqual(texts("// el.textContent = 'Old copy';"), []);
  assert.deepEqual(
    texts("// i18n-ignore: product name\nel.textContent = 'OpenSky';"),
    [],
  );
});
