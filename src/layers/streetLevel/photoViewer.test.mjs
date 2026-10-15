import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhotoViewer } from './photoViewer.js';
import { fakeHost, until } from '../../testSupport/kartaViewFakes.mjs';

const PHOTOS = {
  a: { id: 'a', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: true },
  b: { id: 'b', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: true },
  f: { id: 'f', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: false },
};

/** Sources whose panoramas and sharper flat versions are named after the photo. */
const SOURCES = {
  hasPano: (photo) => photo.isPano,
  panoFirst: (photo) => ({ url: `${photo.id}-first`, width: 2048 }),
  panoSharp: (photo) => ({ url: `${photo.id}-sharp` }),
  flatFirst: (photo) => [`${photo.id}-first`],
  flatSharp: (photo, pixels) => (pixels > 1000 ? `${photo.id}-sharp` : null),
  describe: () => ({ externalUrl: 'https://example.org' }),
};

/** A viewer whose loads wait until `release(url)` (or fail with `fail(url)`). */
function setup() {
  const pending = new Map();
  const loads = [];
  const images = [];
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    load: (url) =>
      new Promise((resolve, reject) => {
        loads.push(url);
        pending.set(url, { resolve, reject });
      }),
    createRenderer: () => ({
      setImage: (image) => images.push(image.src),
      setView() {},
      getView: () => ({ yaw: 0, pitch: 0, fov: 80 }),
      resize() {},
      clear() {},
      destroy() {},
    }),
  });
  const release = (url) => {
    const closed = { value: false };
    pending.get(url).resolve({ src: url, close: () => (closed.value = true) });
    pending.delete(url);
    return closed;
  };
  const fail = (url) => {
    pending.get(url).reject(new Error('gone'));
    pending.delete(url);
  };
  return { viewer, loads, images, release, fail, host: fakeHost() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const parts = (host) => {
  const [picture, canvas] = host.children[0].children;
  return { picture, canvas };
};

test('a panorama that arrives after another photo opened is released, not shown', async () => {
  const env = setup();
  await env.viewer.mount(env.host);
  const first = env.viewer.open('a');
  await tick();
  const second = env.viewer.open('b');
  await tick();
  const stale = env.release('a-first');
  await first;
  assert.equal(stale.value, true, 'its bitmap is closed');
  env.release('b-first');
  await second;
  assert.deepEqual(env.images, ['b-first']);
});

test('one sharp panorama download per open, even across a quick switch and a burst of resizes', async (t) => {
  const env = setup();
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  await env.viewer.mount(env.host);
  const { canvas } = parts(env.host);
  canvas.clientWidth = 1800;
  const opening = env.viewer.open('a');
  await tick();
  env.release('a-first');
  await opening;
  await tick();
  assert.ok(env.loads.includes('a-sharp'), 'expanded: the sharp one is asked');
  // Photo b opens while a's sharp version is still on its way.
  const next = env.viewer.open('b');
  await tick();
  env.release('b-first');
  await next;
  await tick();
  assert.ok(env.loads.includes('b-sharp'));
  // a's download finishes late; resizes must not ask for b's again.
  env.release('a-sharp');
  await tick();
  env.viewer.resize();
  env.viewer.resize();
  await tick();
  assert.equal(env.loads.filter((url) => url === 'b-sharp').length, 1);
  env.release('b-sharp');
  await tick();
  assert.deepEqual(env.images, ['a-first', 'b-first', 'b-sharp']);
});

test('a sharper flat version that failed is tried again on the next resize', async (t) => {
  const env = setup();
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  await env.viewer.mount(env.host);
  const { picture } = parts(env.host);
  picture.clientWidth = 1200;
  const opening = env.viewer.open('f');
  await tick();
  env.release('f-first');
  await opening;
  await tick();
  env.fail('f-sharp');
  await tick();
  assert.equal(picture.src, 'f-first');
  env.viewer.resize();
  await tick();
  assert.equal(env.loads.filter((url) => url === 'f-sharp').length, 2);
  env.release('f-sharp');
  assert.ok(await until(() => picture.src === 'f-sharp'));
});

test('Esc: the docked viewer offers it to the provider first; expanded, it is the dialog’s', async () => {
  let asked = 0;
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    onEscape: () => ++asked > 0,
    load: async (url) => ({ src: url }),
  });
  const host = fakeHost();
  await viewer.mount(host);
  const root = host.children[0];
  const press = () => {
    const event = { key: 'Escape', prevented: false, stopped: false };
    event.preventDefault = () => (event.prevented = true);
    event.stopPropagation = () => (event.stopped = true);
    root.fire('keydown', event);
    return event;
  };
  const docked = press();
  assert.equal(asked, 1);
  assert.equal(docked.prevented && docked.stopped, true);
  root.closest = (selector) =>
    selector.includes('sl-viewer-wrap-expanded') ? {} : null;
  const expanded = press();
  assert.equal(asked, 1, 'not asked while expanded');
  assert.equal(expanded.prevented, false);
});

test('a sharp panorama still downloading when another photo opens is aborted', async (t) => {
  const signals = [];
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    load: (url, options) =>
      url.endsWith('-sharp')
        ? new Promise((_, reject) => {
            signals.push(options.signal);
            options.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          })
        : Promise.resolve({ src: url }),
    createRenderer: () => ({
      setImage() {},
      setView() {},
      getView: () => ({ yaw: 0, pitch: 0, fov: 80 }),
      resize() {},
      clear() {},
      destroy() {},
    }),
  });
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  const host = fakeHost();
  await viewer.mount(host);
  parts(host).canvas.clientWidth = 1800;
  await viewer.open('a');
  await tick();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  await viewer.open('f');
  assert.equal(signals[0].aborted, true, 'not needed any more');
});

test('a lost WebGL context while the first panorama loads releases its bitmap', async () => {
  let closed = false;
  let built = 0;
  let land = null;
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    load: (url) =>
      new Promise((resolve) => {
        land = () => resolve({ src: url, close: () => (closed = true) });
      }),
    // The first renderer is lost mid-load; a new one cannot be built.
    createRenderer: () => {
      built++;
      if (built > 1) throw new Error('context lost');
      return {
        setImage() {},
        setView() {},
        getView: () => ({ yaw: 0, pitch: 0, fov: 80 }),
        resize() {},
        clear() {},
        destroy() {},
      };
    },
  });
  const host = fakeHost();
  await viewer.mount(host);
  const opening = viewer.open('a');
  assert.ok(await until(() => land !== null), 'the panorama is loading');
  parts(host).canvas.fire('webglcontextlost', {});
  const first = land;
  first();
  // The panorama failed: the front view is loaded flat instead.
  assert.ok(await until(() => land !== first), 'the flat fallback loads');
  land();
  await opening;
  assert.equal(built, 2, 'a new renderer was tried');
  assert.equal(closed, true, 'the bitmap no renderer took is closed');
});

test('docked, Esc anywhere in the viewer’s box (toolbar, caption) is offered to the provider', async () => {
  let asked = 0;
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    onEscape: () => ++asked > 0,
    load: async (url) => ({ src: url }),
  });
  const host = fakeHost();
  const wrap = fakeHost();
  host.closest = (selector) => (selector === '.sl-viewer-wrap' ? wrap : null);
  await viewer.mount(host);
  const flags = { stopped: false, prevented: false };
  // Focus back on EXPAND after a shrink: the key reaches the wrap, not the photo.
  wrap.fire('keydown', {
    key: 'Escape',
    stopPropagation: () => (flags.stopped = true),
    preventDefault: () => (flags.prevented = true),
  });
  assert.equal(asked, 1);
  assert.deepEqual(flags, { stopped: true, prevented: true });
  viewer.unmount();
  wrap.fire('keydown', { key: 'Escape' });
  assert.equal(asked, 1, 'unmounted: the listener is gone');
});

test('a picture file or bitmap past any real photo’s size is refused', async (t) => {
  const { loadImage, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } =
    await import('./photoViewer.js');
  const saved = {
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
  };
  t.after(() => Object.assign(globalThis, saved));
  let closed = 0;
  const bitmap = (width, height) => ({ width, height, close: () => closed++ });
  globalThis.createImageBitmap = async (blob) => blob.bitmap;
  const respond = ({ length, size, width = 100, height = 50 }) =>
    (globalThis.fetch = async () => ({
      ok: true,
      headers: new Map([['content-length', String(length ?? '')]]),
      blob: async () => ({ size: size ?? 10, bitmap: bitmap(width, height) }),
    }));
  respond({ length: MAX_IMAGE_BYTES + 1 });
  await assert.rejects(loadImage('https://x/a.jpg'), /could not be loaded/);
  respond({ size: MAX_IMAGE_BYTES + 1 });
  await assert.rejects(loadImage('https://x/a.jpg'), /could not be loaded/);
  respond({ width: MAX_IMAGE_SIDE + 1 });
  await assert.rejects(loadImage('https://x/a.jpg'), /could not be loaded/);
  assert.equal(closed, 1, 'the oversize bitmap is released');
  // No length given, a body that keeps coming: cut off while it streams.
  let pulled = 0;
  globalThis.fetch = async () => ({
    ok: true,
    headers: new Map(),
    body: new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      },
    }),
  });
  await assert.rejects(loadImage('https://x/a.jpg'), /could not be loaded/);
  assert.ok(pulled * 8 * 1024 * 1024 <= MAX_IMAGE_BYTES + 16 * 1024 * 1024);
  respond({});
  assert.equal((await loadImage('https://x/a.jpg')).width, 100);
});
