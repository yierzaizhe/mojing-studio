'use strict';

// Browser file-I/O behavior in isolation: no PSD parser, canvas or Worker
// mocks are involved. Native MessageChannel checks the returned buffer's
// ownership transfer independently of the browser adapter.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { MessageChannel } = require('node:worker_threads');
const { once } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../src/file-read.js'), 'utf8');
const sample = Uint8Array.from([56, 66, 80, 83, 1, 2, 3, 4]);
const ioError = () => new DOMException('The I/O read operation failed.', 'NotReadableError');
const tick = () => new Promise(resolve => setImmediate(resolve));

function makeFile(arrayBuffer) {
  const file = new File([sample], 'local-source.psd', { type: 'image/vnd.adobe.photoshop' });
  Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer });
  return file;
}
function makeRuntime(onRead) {
  const readers = [];
  class Reader {
    constructor() {
      this.readyState = 0;
      this.result = null;
      this.error = null;
      this.abortCalls = 0;
      this.listeners = new Map();
      readers.push(this);
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type) {
      const event = { type, target: this };
      this['on' + type]?.(event);
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
    readAsArrayBuffer(file) {
      this.file = file;
      this.readyState = 1;
      onRead?.(this, file);
    }
    succeed(buffer) {
      this.result = buffer;
      this.readyState = 2;
      this.emit('load');
      this.emit('loadend');
    }
    fail(error = ioError()) {
      this.error = error;
      this.readyState = 2;
      this.emit('error');
      this.emit('loadend');
    }
    abort() {
      this.abortCalls++;
      this.readyState = 2;
      this.emit('abort');
      this.emit('loadend');
    }
  }
  Object.assign(Reader, { EMPTY: 0, LOADING: 1, DONE: 2 });
  Object.assign(Reader.prototype, { EMPTY: 0, LOADING: 1, DONE: 2 });
  const sandbox = {
    FileReader: Reader, File, Blob, ArrayBuffer, Uint8Array,
    DOMException, AbortController, AbortSignal, Promise, Error, TypeError,
    setTimeout, clearTimeout, queueMicrotask, console
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'file-read.js' });
  assert.equal(typeof sandbox.window.LayerDeskLocalFile?.read, 'function');
  return { read: sandbox.window.LayerDeskLocalFile.read, readers };
}

async function settlesSoon(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation did not settle while file I/O was pending.')), 200); })
    ]);
  } finally { clearTimeout(timer); }
}
function assertReadGuidance(error) {
  assert.notEqual(error.name, 'AbortError');
  assert.match(error.message, /读取|读取文件|访问/);
  assert.match(error.message, /重新选择|重新打开/);
  assert.match(error.message, /本机|本地/);
  assert.doesNotMatch(error.message, /PSD.*(?:损坏|无效)|结构异常|文件不完整/);
  return true;
}
let checks = 0;
function passed(name) { checks++; console.log('PASS ' + name); }

async function verify() {
  const owned = sample.slice().buffer;
  const direct = makeRuntime(() => { throw new Error('FileReader must not run after a successful read'); });
  const received = await direct.read(makeFile(async () => owned));
  assert.strictEqual(received, owned, 'successful arrayBuffer must not be copied');
  assert.equal(direct.readers.length, 0);
  passed('successful arrayBuffer returns the original transferable buffer');

  for (const synchronous of [false, true]) {
    const fallbackBytes = sample.slice().buffer;
    const fallback = makeRuntime(reader => queueMicrotask(() => reader.succeed(fallbackBytes)));
    const file = makeFile(synchronous ? () => { throw ioError(); } : async () => { throw ioError(); });
    const result = await fallback.read(file);
    assert.strictEqual(result, fallbackBytes, 'FileReader result must not be copied');
    assert.equal(fallback.readers.length, 1);
    assert.strictEqual(fallback.readers[0].file, file);
    assert.deepEqual(Array.from(new Uint8Array(result)), Array.from(sample));
  }
  passed('synchronous and asynchronous NotReadableError recover through FileReader');

  const denied = makeRuntime(reader => queueMicrotask(() => reader.fail()));
  await assert.rejects(() => denied.read(makeFile(async () => { throw ioError(); })), assertReadGuidance);
  const throwingReader = makeRuntime(() => { throw new DOMException('Access denied', 'SecurityError'); });
  await assert.rejects(() => throwingReader.read(makeFile(async () => { throw ioError(); })), assertReadGuidance);
  passed('both read methods failing produce actionable I/O guidance rather than a corrupt-PSD error');

  const intact = sample.slice().buffer;
  const partial = makeRuntime(reader => queueMicrotask(() => reader.succeed(intact)));
  assert.strictEqual(await partial.read(makeFile(async () => new ArrayBuffer(2))), intact);
  const partialBoth = makeRuntime(reader => queueMicrotask(() => reader.succeed(new ArrayBuffer(2))));
  await assert.rejects(() => partialBoth.read(makeFile(async () => new ArrayBuffer(2))), assertReadGuidance);
  passed('truncated reads retry and never forward incomplete bytes to a parser');

  const aborting = makeRuntime(() => { throw new Error('An aborted primary read must not retry'); });
  await assert.rejects(() => aborting.read(makeFile(async () => { throw new DOMException('Aborted', 'AbortError'); })), { name: 'AbortError' });
  assert.equal(aborting.readers.length, 0);
  passed('a primary AbortError does not fall back to another read');

  const beforeAbort = new AbortController();
  beforeAbort.abort();
  let primaryCalls = 0;
  const unopened = makeRuntime();
  await assert.rejects(() => unopened.read(makeFile(async () => { primaryCalls++; return sample.slice().buffer; }), { signal: beforeAbort.signal }), { name: 'AbortError' });
  assert.equal(primaryCalls, 0);
  assert.equal(unopened.readers.length, 0);
  passed('an already cancelled read never touches the file');

  let rejectLate;
  const pendingPrimary = new Promise((_, reject) => { rejectLate = reject; });
  const duringAbort = new AbortController();
  const cancelledPrimary = makeRuntime();
  const primaryResult = cancelledPrimary.read(makeFile(() => pendingPrimary), { signal: duringAbort.signal });
  await tick();
  duringAbort.abort();
  await assert.rejects(settlesSoon(primaryResult), { name: 'AbortError' });
  rejectLate(ioError());
  await tick();
  assert.equal(cancelledPrimary.readers.length, 0, 'a late primary error must not start a fallback after cancellation');
  passed('cancelling pending arrayBuffer settles promptly and suppresses a late fallback');

  let started;
  const readingStarted = new Promise(resolve => { started = resolve; });
  const fallbackAbort = new AbortController();
  const cancelledFallback = makeRuntime(reader => started(reader));
  const fallbackResult = cancelledFallback.read(makeFile(async () => { throw ioError(); }), { signal: fallbackAbort.signal });
  const reader = await readingStarted;
  fallbackAbort.abort();
  await assert.rejects(settlesSoon(fallbackResult), { name: 'AbortError' });
  assert.equal(reader.abortCalls, 1, 'pending FileReader must be aborted');
  reader.succeed(sample.slice().buffer);
  await tick();
  passed('cancelling fallback aborts FileReader and ignores its late load callback');

  const controller = new AbortController();
  const completed = makeRuntime(reader => queueMicrotask(() => reader.succeed(sample.slice().buffer)));
  await completed.read(makeFile(async () => { throw ioError(); }), { signal: controller.signal });
  controller.abort();
  assert.equal(completed.readers[0].abortCalls, 0, 'completed reads must remove abort listeners');
  passed('completed fallback removes its cancellation listener');

  const channel = new MessageChannel();
  try {
    const transferred = once(channel.port2, 'message');
    channel.port1.postMessage({ buffer: received }, [received]);
    assert.equal(owned.byteLength, 0, 'native transfer must detach the original read buffer');
    const [message] = await transferred;
    assert.deepEqual(Array.from(new Uint8Array(message.buffer)), Array.from(sample));
  } finally { channel.port1.close(); channel.port2.close(); }
  passed('the unchanged result buffer transfers through native MessageChannel without an adapter copy');
  console.log(checks + ' local file-read checks passed.');
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
