'use strict';

// Native image encoders exercise the raster handoff without opening a PSD.
// SVG parsing/rasterization is covered separately by the browser SVG tests.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const { createCanvas, ImageData, Path2D, loadImage } = require(process.env.PSD_TEST_CANVAS || '@napi-rs/canvas');
const ag = require(process.env.PSD_TEST_MODULE || 'ag-psd');
ag.initializeCanvas(createCanvas, (w, h) => new ImageData(w, h));

function offscreen(width, height) {
  const surface = createCanvas(width, height);
  surface.closeCount = 0;
  surface.close = () => { surface.closeCount++; };
  surface.convertToBlob = async ({ type = 'image/png', quality = .92 } = {}) => new Blob([
    type === 'image/jpeg' ? surface.toBuffer(type, Math.round(quality * 100)) : surface.toBuffer(type),
  ], { type });
  return surface;
}
async function createBitmap(source, ...args) {
  if (source instanceof Blob) source = await loadImage(Buffer.from(await source.arrayBuffer()));
  if (source instanceof ImageData) {
    const canvas = offscreen(source.width, source.height);
    canvas.getContext('2d').putImageData(source, 0, 0); source = canvas;
  }
  let sx = 0, sy = 0, sw = source.width, sh = source.height, options = {};
  if (args.length >= 4) [sx, sy, sw, sh, options = {}] = args; else options = args[0] || {};
  const output = offscreen(options.resizeWidth || sw, options.resizeHeight || sh);
  output.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, output.width, output.height);
  return output;
}
const pending = new Map(); let counter = 0;
const sandbox = {
  agPsd: ag, OffscreenCanvas: offscreen, ImageData, Path2D, createImageBitmap: createBitmap,
  Blob, File, DataView, ArrayBuffer, Uint8Array, Uint8ClampedArray, Uint16Array, Float32Array, setTimeout,
  self: { fonts: { ready: Promise.resolve() }, postMessage(result) { pending.get(result.id)(result); pending.delete(result.id); } },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/worker.js'), 'utf8'), sandbox);
function request(type, payload = {}) {
  return new Promise(resolve => { const id = ++counter; pending.set(id, resolve); sandbox.self.onmessage({ data: { id, type, ...payload } }); });
}
const success = result => { assert(result.ok, result.error); return result; };
const pixel = (surface, x, y) => [...surface.getContext('2d').getImageData(x, y, 1, 1).data];
const pixels = surface => surface.getContext('2d').getImageData(0, 0, surface.width, surface.height).data;
const differences = (a, b) => {
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  const left = pixels(a), right = pixels(b);
  const box = { count: 0, left: a.width, top: a.height, right: -1, bottom: -1 };
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4;
    if (left[i] === right[i] && left[i + 1] === right[i + 1] && left[i + 2] === right[i + 2] && left[i + 3] === right[i + 3]) continue;
    box.count++; box.left = Math.min(box.left, x); box.top = Math.min(box.top, y); box.right = Math.max(box.right, x); box.bottom = Math.max(box.bottom, y);
  }
  return box;
};
function input(width = 320, height = 240) {
  const surface = offscreen(width, height), ctx = surface.getContext('2d');
  ctx.fillStyle = '#145a72'; ctx.fillRect(width * .2, height * .2, width * .3, height * .3);
  return surface;
}
const mark = { enabled: true, text: 'SVG proof', position: 'bottom-right', opacity: .8, size: 12, color: '#ffffff' };
let count = 0;
const passed = name => { count++; console.log(`PASS ${name}`); };

async function verify() {
  const pngInput = input(), sourceBefore = new Uint8ClampedArray(pixels(pngInput));
  const pngResult = success(await request('rasterExport', { bitmap: pngInput, exportWidth: 320, exportHeight: 240 }));
  const png = await createBitmap(pngResult.blob), pngBytes = new Uint8Array(await pngResult.blob.arrayBuffer());
  assert.equal(pngResult.blob.type, 'image/png'); assert.equal(pngResult.width, 320); assert.equal(pngResult.height, 240);
  assert.deepEqual([...pngBytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(pixel(png, 0, 0), [0, 0, 0, 0]); assert.deepEqual(pixel(png, 100, 80), [20, 90, 114, 255]);
  assert.equal(pngInput.closeCount, 1); assert.deepEqual(pixels(pngInput), sourceBefore);
  passed('raster PNG works without a PSD, preserves transparency and closes its unmodified input');

  const jpegInput = input();
  const jpegResult = success(await request('rasterExport', { bitmap: jpegInput, format: 'jpeg', background: '#17314c', exportWidth: 320, exportHeight: 240 }));
  const jpeg = await createBitmap(jpegResult.blob), jpegBytes = new Uint8Array(await jpegResult.blob.arrayBuffer());
  assert.equal(jpegResult.blob.type, 'image/jpeg'); assert.deepEqual([...jpegBytes.slice(0, 3)], [255, 216, 255]);
  assert(pixel(jpeg, 0, 0).every((v, i) => Math.abs(v - [23, 49, 76, 255][i]) < 4));
  assert.equal(jpegInput.closeCount, 1);
  passed('raster JPG uses the real JPEG encoder and requested opaque background');

  const stampedInput = input();
  const stamped = await createBitmap(success(await request('rasterExport', { bitmap: stampedInput, exportWidth: 320, exportHeight: 240, watermark: mark })).blob);
  const box = differences(png, stamped);
  assert(box.count > 50 && box.left > 120 && box.top > 180 && box.right < 320 && box.bottom < 240);
  assert.deepEqual(pixel(stamped, 0, 0), [0, 0, 0, 0]); assert.equal(stampedInput.closeCount, 1);
  assert.deepEqual(pixels(stampedInput), sourceBefore);
  passed('raster watermark occupies the requested corner without changing source pixels');

  const previewInput = input(160, 120);
  const preview = success(await request('rasterExport', { bitmap: previewInput, preview: true, exportWidth: 320, exportHeight: 240, watermark: mark }));
  assert.equal(preview.width, 160); assert.equal(preview.height, 120); assert.equal(preview.exportWidth, 320); assert.equal(preview.exportHeight, 240); assert(preview.canExport);
  assert.equal(previewInput.closeCount, 1);
  const smallBaseline = success(await request('rasterExport', { bitmap: input(160, 120), preview: true, exportWidth: 320, exportHeight: 240 }));
  const smallBox = differences(smallBaseline.bitmap, preview.bitmap);
  assert(smallBox.count > 20 && Math.abs(smallBox.left / 160 - box.left / 320) < .04 && Math.abs(smallBox.bottom / 120 - box.bottom / 240) < .04, JSON.stringify({box,smallBox}));
  passed('reduced raster preview uses planned output coordinates for watermark placement');

  const jpegPreviewInput = input();
  const jpegPreview = success(await request('rasterExport', { bitmap: jpegPreviewInput, preview: true, exportWidth: 320, exportHeight: 240, format: 'jpeg', background: '#17314c' }));
  assert.equal(differences(jpeg, jpegPreview.bitmap).count, 0); assert.equal(jpegPreviewInput.closeCount, 1);
  passed('raster JPG preview passes through the actual JPEG encoder');

  const bigPlanInput = input(400, 320);
  const bigPlan = success(await request('rasterExport', { bitmap: bigPlanInput, preview: true, exportWidth: 10000, exportHeight: 8000, watermark: mark }));
  assert.equal(bigPlan.canExport, false); assert.equal(bigPlan.exportWidth, 10000); assert.equal(bigPlan.exportHeight, 8000); assert(bigPlan.warnings.length);
  assert.equal(bigPlanInput.closeCount, 1);
  passed('oversize raster export plans can preview with explicit safe-degradation metadata');

  for (const payload of [
    { bitmap: input(), exportWidth: 10000, exportHeight: 8000 },
    { bitmap: input(), exportWidth: 640, exportHeight: 480 },
    { bitmap: input(), exportWidth: 0, exportHeight: 240 },
    { bitmap: input(), exportWidth: 320, exportHeight: 240, format: 'webp' },
    { bitmap: input(), exportWidth: 320, exportHeight: 240, watermark: { enabled: true, text: ' ' } },
  ]) {
    const result = await request('rasterExport', payload);
    assert(!result.ok && result.error); assert.equal(payload.bitmap.closeCount, 1);
  }
  const invalid = { width: 0, height: 10, closeCount: 0, close() { this.closeCount++; } };
  assert.equal((await request('rasterExport', { bitmap: invalid })).ok, false); assert.equal(invalid.closeCount, 1);
  const excessive = { width: 32768, height: 1, closeCount: 0, close() { this.closeCount++; } };
  assert.equal((await request('rasterExport', { bitmap: excessive })).ok, false); assert.equal(excessive.closeCount, 1);
  passed('invalid options, unsafe sizes and source-size mismatches reject and release their inputs');

  const noDocument = await request('render', { mode: 'original' });
  assert(!noDocument.ok && noDocument.error.includes('PSD'));
  passed('raster handoff does not create or mutate a PSD document');
  console.log(`${count} SVG raster-export checks passed.`);
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
