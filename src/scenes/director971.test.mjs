import assert from 'node:assert/strict';
import test from 'node:test';
import { SceneDirector } from './director.js';

const STORAGE_KEY = 'godsEyeView.sceneProject.v2';
const CHECKPOINT_KEY = 'godsEyeView.sceneProject.checkpoint.v1';
const pose = {
  lat: 10,
  lon: 20,
  alt: 500000,
  heading: 0,
  pitch: -40,
  roll: 0,
};
const shot = (id) => ({
  id,
  title: id,
  durationSec: 0.2,
  holdSec: 0,
  camera: pose,
  visual: { style: 'normal' },
  layers: {},
});
const project = JSON.stringify({
  version: 3,
  scenes: [{ id: 's', title: 'S', shots: [shot('a'), shot('b')] }],
});

function classList() {
  return {
    add() {},
    remove() {},
    toggle() {},
    contains: () => false,
  };
}

function installDocument() {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({
      classList: classList(),
      style: {},
      dataset: {},
      appendChild() {},
      remove() {},
      click() {},
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
    }),
    addEventListener() {},
    removeEventListener() {},
    body: { classList: classList(), appendChild() {} },
  };
}

function make(initial, { styleOverrides = {}, dataOverrides = {} } = {}) {
  const stored = new Map(Object.entries(initial));
  const storage = {
    stored,
    full: false,
    getItem: (key) => stored.get(key) ?? null,
    setItem(key, value) {
      if (this.full)
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      stored.set(key, String(value));
    },
    removeItem: (key) => stored.delete(key),
  };
  globalThis.localStorage = storage;
  const viewer = {
    camera: {
      flyTo: (options) => Promise.resolve().then(() => options.complete?.()),
      cancelFlight() {},
    },
  };
  const style = {
    runImmediateNavigation: (_name, run) => run(),
    getCameraState: () => pose,
    getVisualState: () => ({ style: 'normal' }),
    setRecordingMode() {},
    applyVisualState: async () => true,
    ...styleOverrides,
  };
  const data = {
    getAll: () => [],
    getLayerParams: () => null,
    setEnabled: async () => true,
    setLayerParams: () => true,
    ...dataOverrides,
  };
  return { director: new SceneDirector(viewer, style, data), storage };
}

function observeStatus(director) {
  let status = '';
  director.subscribe(({ state }) => {
    status = state.status;
  });
  return () => status;
}

test('SceneDirector keeps recovery data and failed-save status accurate (#971)', async (t) => {
  const priorDocument = globalThis.document;
  const priorStorage = globalThis.localStorage;
  const priorWarn = console.warn;
  console.warn = () => {};
  installDocument();
  t.after(() => {
    console.warn = priorWarn;
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
  });

  let made = make({
    [STORAGE_KEY]: '{"version":99,"scenes":[]}',
    [CHECKPOINT_KEY]: 'EARLIER-CHECKPOINT',
  });
  assert.equal(
    made.storage.stored.get(STORAGE_KEY),
    '{"version":99,"scenes":[]}',
  );
  assert.equal(made.storage.stored.get(CHECKPOINT_KEY), 'EARLIER-CHECKPOINT');
  await made.director.destroy();

  made = make({ [STORAGE_KEY]: project });
  const status = observeStatus(made.director);
  made.storage.full = true;

  made.director.captureShot();
  assert.match(status(), /^Scene not saved/);

  made.director.updateSelectedShot();
  assert.match(status(), /^Scene not saved/);

  assert.equal(
    await made.director.importProjectFile(
      { name: 'fixture.json' },
      { prepared: { project: JSON.parse(project), assets: [] } },
    ),
    true,
  );
  assert.match(status(), /^Scene not saved/);
  await made.director.destroy();
});

test('SceneDirector returns results, resolves implicit ids, and counts scenes', async (t) => {
  const priorDocument = globalThis.document;
  const priorStorage = globalThis.localStorage;
  installDocument();
  t.after(() => {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
  });

  const made = make({ [STORAGE_KEY]: project });
  const options = { single: true, preview: false };
  assert.deepEqual(await made.director.startScene('s', options), {
    started: true,
    shots: 2,
  });
  assert.equal(made.director._lastRun.scenesRun, 1);
  assert.deepEqual(
    await made.director.startScene(undefined, {
      ...options,
      afterShotId: 'a',
    }),
    { started: true, shots: 1 },
  );
  await made.director.destroy();
});

test('SceneDirector does not report caught failures as success', async (t) => {
  const priorDocument = globalThis.document;
  const priorStorage = globalThis.localStorage;
  const priorWarn = console.warn;
  console.warn = () => {};
  installDocument();
  t.after(() => {
    console.warn = priorWarn;
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
  });

  const made = make(
    { [STORAGE_KEY]: project },
    {
      styleOverrides: {
        applyVisualState: async () => {
          throw new Error('visual failed');
        },
      },
    },
  );
  assert.deepEqual(
    await made.director.startScene('s', {
      single: true,
      preview: false,
    }),
    { started: false, reason: 'run-failed' },
  );
  await made.director.destroy();
});
