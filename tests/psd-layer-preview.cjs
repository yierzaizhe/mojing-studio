'use strict';

// Exercise the shipped PSD parser and worker. Allocation failures model browser
// ImageBitmap pressure; resource cleanup is observed through canvas lifetimes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const { createCanvas, ImageData, Path2D } = require(process.env.PSD_TEST_CANVAS || '@napi-rs/canvas');
const ag = require(process.env.PSD_TEST_MODULE || 'ag-psd');
ag.initializeCanvas(createCanvas, (w, h) => new ImageData(w, h));
const workerSource = fs.readFileSync(path.join(ROOT, 'src/worker.js'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, 'compositing.psd'));
const flat = nodes => (nodes || []).flatMap(node => [node, ...flat(node.children)]);

function makeWorker({ failBitmapAt = 0, failDecode = false } = {}) {
  const surfaces = [], bitmaps = [], pending = new Map();
  let sequence = 0, bitmapCalls = 0;
  function offscreen(width, height) {
    const surface = createCanvas(width, height);
    surfaces.push(surface);
    return surface;
  }
  async function createBitmap(source, ...args) {
    const call = ++bitmapCalls;
    if (call === failBitmapAt) throw new Error('injected bitmap allocation failure');
    if (source instanceof ImageData) {
      const image = createCanvas(source.width, source.height);
      image.getContext('2d').putImageData(source, 0, 0);
      source = image;
    }
    let x = 0, y = 0, width = source.width, height = source.height, options = {};
    if (args.length >= 4) [x, y, width, height, options = {}] = args;
    else options = args[0] || {};
    const bitmap = createCanvas(options.resizeWidth || width, options.resizeHeight || height);
    bitmap.getContext('2d').drawImage(source, x, y, width, height, 0, 0, bitmap.width, bitmap.height);
    bitmap.call = call;
    bitmap.closed = false;
    bitmap.close = () => { bitmap.closed = true; bitmap.width = bitmap.height = 1; };
    bitmaps.push(bitmap);
    return bitmap;
  }
  const parser = { ...ag, getLayerImageData(layer) {
    if (failDecode) { failDecode = false; throw new Error('injected layer decode failure'); }
    return ag.getLayerImageData(layer);
  } };
  const sandbox = {
    agPsd: parser, OffscreenCanvas: offscreen, createImageBitmap: createBitmap,
    ImageData, Path2D, Blob, File, DataView, ArrayBuffer, Uint8Array,
    Uint8ClampedArray, Uint16Array, Float32Array,
    self: { postMessage(result) { pending.get(result.id)(result); pending.delete(result.id); } }
  };
  vm.createContext(sandbox);
  vm.runInContext(workerSource, sandbox);
  return {
    surfaces, bitmaps, get bitmapCalls() { return bitmapCalls; },
    request(type, payload = {}) {
      return new Promise(resolve => {
        const id = ++sequence;
        pending.set(id, resolve);
        sandbox.self.onmessage({ data: { id, type, ...payload } });
      });
    }
  };
}

async function opened(worker, bytes = core) {
  const result = await worker.request('open', { file: new File([bytes], 'layer-preview.psd') });
  assert(result.ok, result.error);
  return flat(result.doc.children);
}
function pixels(bitmap, x = 1, y = 1) {
  return Array.from(bitmap.getContext('2d').getImageData(x, y, 1, 1).data);
}
let checks = 0;
function passed(message) { checks++; console.log('PASS ' + message); }

async function verify() {
  const worker = makeWorker();
  const nodes = await opened(worker);
  for (const [name, explanation] of [
    ['brightness adjustment without pixels', '调整图层'],
    ['empty group', '像素范围']
  ]) {
    const node = nodes.find(node => node.name === name);
    assert.equal(node.previewable, false);
    assert(node.previewReason.includes(explanation));
    const before = worker.bitmapCalls;
    const thumbnail = await worker.request('thumbnail', { layerId: node.id });
    assert(thumbnail.ok && thumbnail.empty);
    assert.equal(worker.bitmapCalls, before, 'metadata-only nodes must not allocate bitmaps');
    const direct = await worker.request('render', { mode: 'layer', layerId: node.id });
    assert(!direct.ok && direct.error === node.previewReason);
    passed(name + ' advertises metadata-only preview without thumbnail errors');
  }
  const cached = nodes.find(node => node.name === 'red square');
  const group = nodes.find(node => node.name === 'isolated group at 50%');
  assert.equal(cached.previewable, true);
  assert.equal(group.previewable, true);
  const afterError = await worker.request('render', { mode: 'layer', layerId: cached.id });
  assert(afterError.ok, afterError.error);
  assert.deepEqual(pixels(afterError.bitmap), [255, 0, 0, 255]);
  afterError.bitmap.close();
  passed('cached layers and populated groups remain previewable after metadata-only requests');

  const vector = ag.writePsdBuffer({ width: 20, height: 20, children: [{
    name: 'uncached native vector',
    vectorFill: { type: 'color', color: { r: 30, g: 160, b: 90 } },
    vectorMask: { fillStartsWithAllPixels: false, paths: [{
      open: false, operation: 'combine', fillRule: 'non-zero',
      knots: [[2,2], [18,2], [18,18], [2,18]].map(([x,y]) => ({ linked: false, points: [x,y,x,y,x,y] }))
    }] }
  }] });
  const [shape] = await opened(worker, vector);
  assert.equal(shape.hasPixels, false);
  assert.equal(shape.previewable, true);
  const shapeRender = await worker.request('render', { mode: 'layer', layerId: shape.id });
  assert(shapeRender.ok, shapeRender.error);
  assert.deepEqual(pixels(shapeRender.bitmap, 8, 8), [30, 160, 90, 255]);
  shapeRender.bitmap.close();
  passed('uncached supported vector fill remains independently previewable');

  const metadataOnly = ag.writePsdBuffer({ width: 20, height: 20, children: [{
    name: 'group with metadata only', children: [{
      name: 'uncached layer with bounds', left: 2, top: 2, right: 18, bottom: 18,
      rawData: { colorMode: 3, bitsPerChannel: 8, large: false,
        channels: [-1, 0, 1, 2].map(id => ({ id, compression: 0 })) }
    }]
  }] });
  const metadataNodes = await opened(worker, metadataOnly);
  assert(metadataNodes.every(node => node.width > 0 && node.height > 0));
  assert(metadataNodes.every(node => node.previewable === false && node.previewReason));
  for (const node of metadataNodes) {
    const thumbnail = await worker.request('thumbnail', { layerId: node.id });
    assert(thumbnail.ok && thumbnail.empty);
  }
  passed('nonempty bounds do not imply pixel availability for a layer or its parent group');

  const swatch = createCanvas(4, 4);
  swatch.getContext('2d').fillStyle = '#f00';
  swatch.getContext('2d').fillRect(0, 0, 4, 4);
  const manyLayers = ag.writePsdBuffer({ width: 4, height: 4, children:
    Array.from({ length: 66 }, (_, index) => ({ name: 'pixel ' + index, left: 0, top: 0, canvas: swatch }))
  });
  const allocation = makeWorker({ failBitmapAt: 3 });
  const many = await opened(allocation, manyLayers);
  const failed = await allocation.request('thumbnail', { layerId: many[0].id });
  assert(!failed.ok && failed.error.includes('injected bitmap'));
  const cachedPixels = allocation.bitmaps.find(bitmap => bitmap.call === 2);
  assert(cachedPixels && !cachedPixels.closed);
  for (const node of many.slice(1)) {
    const result = await allocation.request('thumbnail', { layerId: node.id });
    assert(result.ok, result.error);
    result.bitmap?.close();
  }
  assert.equal(cachedPixels.closed, true, 'failed thumbnail must unpin its pixel cache so LRU can evict it');
  passed('failed thumbnail releases its cache pin and later requests can evict it');

  const copying = makeWorker({ failBitmapAt: 4 });
  const [first] = await opened(copying, manyLayers);
  const copyFailure = await copying.request('thumbnail', { layerId: first.id });
  assert(!copyFailure.ok);
  assert.equal(copying.bitmaps.find(bitmap => bitmap.call === 3)?.closed, true);
  const retry = await copying.request('render', { mode: 'layer', layerId: first.id });
  assert(retry.ok, retry.error);
  assert.deepEqual(pixels(retry.bitmap), [255, 0, 0, 255]);
  retry.bitmap.close();
  passed('failed thumbnail copy closes its temporary bitmap and the queue recovers');

  for (const config of [{ failBitmapAt: 3 }, { failDecode: true }]) {
    const failing = makeWorker(config);
    const [node] = await opened(failing, manyLayers);
    const result = await failing.request(config.failDecode ? 'thumbnail' : 'render', { mode: 'layer', layerId: node.id });
    assert(!result.ok);
    assert(failing.surfaces.every(surface => surface.width === 1 && surface.height === 1), 'failed requests must release their offscreen surfaces');
  }
  passed('layer decode and final preview allocation failures release temporary canvases');
  console.log(checks + ' PSD layer-preview checks passed.');
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
