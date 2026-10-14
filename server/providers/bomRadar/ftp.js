import { Writable } from 'node:stream';

/** The only host this feature ever contacts. */
export const BOM_FTP_HOST = 'ftp.bom.gov.au';

const IDLE_CLOSE_MS = 60_000;
const OPERATION_TIMEOUT_MS = 20_000;
const MAX_QUEUED = 64;

/** Load basic-ftp on first use so a disabled feature never imports it. */
async function defaultClientFactory() {
  const { Client } = await import('basic-ftp');
  return new Client(OPERATION_TIMEOUT_MS);
}

/** Collect a download in memory, failing as soon as it passes `maxBytes`. */
function cappedSink(maxBytes) {
  const chunks = [];
  let total = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) return callback(new Error('too_large'));
      chunks.push(chunk);
      callback();
    },
  });
  // The transfer rejects with the failure; an unobserved 'error' must not throw.
  sink.on('error', () => {});
  return { sink, bytes: () => Buffer.concat(chunks) };
}

/**
 * One shared, anonymous, passive-mode FTP session to the Bureau of Meteorology.
 *
 * basic-ftp clients are not concurrent, so every operation runs through one
 * queue. The connection is opened on demand, closed after a minute of
 * inactivity, and dropped on any error so the next operation reconnects; an
 * operation that fails on a connection that had already been used (the server
 * may have closed it while idle) is retried once on a fresh one.
 * @param {object} [options]
 * @param {() => Promise<object>} [options.clientFactory] Builds a basic-ftp-compatible
 *   client (`access`, `list`, `downloadTo`, `close`); injected by tests.
 * @param {number} [options.idleMs] Idle time before the connection is closed.
 * @param {number} [options.timeoutMs] Deadline for one connect or operation.
 * @param {number} [options.maxQueued] Operations accepted while one is running.
 */
export function createBomFtp({
  clientFactory = defaultClientFactory,
  idleMs = IDLE_CLOSE_MS,
  timeoutMs = OPERATION_TIMEOUT_MS,
  maxQueued = MAX_QUEUED,
} = {}) {
  let client = null;
  let idleTimer = null;
  let tail = Promise.resolve();
  let queued = 0;

  function drop() {
    clearTimeout(idleTimer);
    idleTimer = null;
    const closing = client;
    client = null;
    try {
      closing?.close();
    } catch {
      // Closing a broken connection must not mask the original failure.
    }
  }
  function arm() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!client) return;
    idleTimer = setTimeout(drop, idleMs);
    idleTimer.unref?.();
  }
  function deadline(promise) {
    let timer;
    const expired = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        // Closing the sockets also rejects the abandoned operation.
        drop();
        reject(new Error('ftp_timeout'));
      }, timeoutMs);
      timer.unref?.();
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  }
  async function connect() {
    if (client) return { connection: client, reused: true };
    const next = await clientFactory();
    try {
      await deadline(
        next.access({
          host: BOM_FTP_HOST,
          user: 'anonymous',
          password: 'guest',
          secure: false,
        }),
      );
    } catch (error) {
      try {
        next.close?.();
      } catch {
        // Already closed.
      }
      throw error;
    }
    client = next;
    return { connection: next, reused: false };
  }
  async function attempt(task, canRetry) {
    clearTimeout(idleTimer);
    const { connection, reused } = await connect();
    try {
      return await deadline(task(connection));
    } catch (error) {
      drop();
      if (reused && canRetry) return attempt(task, false);
      throw error;
    }
  }
  function enqueue(task) {
    if (queued >= maxQueued)
      return Promise.reject(Object.assign(new Error('busy'), { status: 429 }));
    queued++;
    const run = tail.then(() => attempt(task, true));
    tail = run.then(
      () => {},
      () => {},
    );
    return run.finally(() => {
      queued--;
      // Only the last queued operation starts the idle countdown.
      if (queued === 0) arm();
    });
  }

  return {
    /** File names (not directories) in a remote directory. */
    list(directory) {
      return enqueue(async (connection) => {
        const entries = await connection.list(directory);
        return entries
          .filter((entry) => entry.isFile === true || entry.type === 1)
          .map((entry) => entry.name);
      });
    },
    /** A remote file's bytes, failing with `too_large` past `maxBytes`. */
    download(remotePath, maxBytes) {
      return enqueue(async (connection) => {
        const { sink, bytes } = cappedSink(maxBytes);
        await connection.downloadTo(sink, remotePath);
        return bytes();
      });
    },
    /** Close the connection now; later operations reconnect. */
    close() {
      drop();
    },
    stats: () => ({ connected: client !== null, queued }),
  };
}
