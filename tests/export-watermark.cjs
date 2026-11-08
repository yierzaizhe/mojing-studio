'use strict';

// Real PNG/JPEG encoders plus the same bundled PSD parser and worker used in
// the offline HTML. The native canvas adapter is test-only.
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
  surface.close = () => {};
  surface.convertToBlob = async ({ type = 'image/png', quality = .92 } = {}) => {
    const bytes = type === 'image/jpeg' ? surface.toBuffer(type, Math.round(quality * 100)) : surface.toBuffer(type);
    return new Blob([bytes], { type });
  };
  return surface;
}
async function createBitmap(source, ...args) {
  if (source instanceof Blob) source = await loadImage(Buffer.from(await source.arrayBuffer()));
  if (source instanceof ImageData) {
    const surface = offscreen(source.width, source.height);
    surface.getContext('2d').putImageData(source, 0, 0); source = surface;
  }
  let sx = 0, sy = 0, sw = source.width, sh = source.height, options = {};
  if (args.length >= 4) [sx, sy, sw, sh, options = {}] = args; else options = args[0] || {};
  const result = offscreen(options.resizeWidth || sw, options.resizeHeight || sh);
  result.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, result.width, result.height);
  return result;
}
let counter = 0;
const pending = new Map();
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
function success(result) { assert(result.ok, result.error); return result; }
async function decoded(result) { return createBitmap(success(result).blob); }
function pixels(surface) { return surface.getContext('2d').getImageData(0, 0, surface.width, surface.height).data; }
function pixel(surface, x, y) { return [...surface.getContext('2d').getImageData(x, y, 1, 1).data]; }
function changes(a, b) {
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  const left = pixels(a), right = pixels(b);
  const box = { left: a.width, top: a.height, right: -1, bottom: -1, count: 0, quadrants: new Set() };
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4;
    if (left[i] === right[i] && left[i + 1] === right[i + 1] && left[i + 2] === right[i + 2] && left[i + 3] === right[i + 3]) continue;
    box.count++; box.left = Math.min(box.left, x); box.top = Math.min(box.top, y); box.right = Math.max(box.right, x); box.bottom = Math.max(box.bottom, y);
    box.quadrants.add((x >= a.width / 2 ? 1 : 0) + (y >= a.height / 2 ? 2 : 0));
  }
  return box;
}
const merged = createCanvas(600, 400);
merged.getContext('2d').fillStyle = '#145a72'; merged.getContext('2d').fillRect(200, 120, 200, 160);
const subject = createCanvas(200, 160); subject.getContext('2d').fillStyle = '#145a72'; subject.getContext('2d').fillRect(0, 0, 200, 160);
const source = ag.writePsdBuffer({ width: 600, height: 400, canvas: merged, children: [{ name: 'teal island', left: 200, top: 120, canvas: subject }] }, { noBackground: true });
const mark = { enabled: true, text: 'Review only', position: 'bottom-right', opacity: .6, size: 12, color: '#ffffff' };
let checks = 0;
function passed(name) { checks++; console.log(`PASS ${name}`); }

async function verify() {
  success(await request('open', { file: new File([source], 'watermark-test.psd') }));
  const baselineResult = success(await request('export', { mode: 'original' }));
  const baseline = await decoded(baselineResult);
  assert.equal(baselineResult.blob.type, 'image/png');
  assert.equal(baseline.width, 600); assert.equal(baseline.height, 400);
  assert.deepEqual(pixel(baseline, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(baseline, 300, 200), [20, 90, 114, 255]);
  passed('default export remains original-size transparent PNG');

  const jpegResult = success(await request('export', { mode: 'original', format: 'jpeg', quality: .8 }));
  const jpeg = await decoded(jpegResult), jpegBytes = new Uint8Array(await jpegResult.blob.arrayBuffer());
  assert.equal(jpegResult.blob.type, 'image/jpeg'); assert.equal(jpegBytes[0], 255); assert.equal(jpegBytes[1], 216);
  assert.equal(jpeg.width, 600); assert.equal(jpeg.height, 400);
  assert.deepEqual(pixel(jpeg, 0, 0), [255, 255, 255, 255]);
  passed('JPG uses a real JPEG encoder and opaque white background');

  const customJpeg = await decoded(await request('export', { mode: 'original', format: 'jpeg', background: '#17314c' }));
  const background = pixel(customJpeg, 0, 0);
  assert(background.every((v, i) => Math.abs(v - [23, 49, 76, 255][i]) < 4));
  passed('JPG custom background replaces transparent regions');

  const jpegPreview = success(await request('exportPreview', { mode: 'original', format: 'jpeg', quality: .8, maxSize: 600 }));
  assert.equal(changes(jpeg, jpegPreview.bitmap).count, 0);
  const lowerQuality = success(await request('exportPreview', { mode: 'original', format: 'jpeg', quality: .6, maxSize: 600 }));
  const higherQuality = success(await request('exportPreview', { mode: 'original', format: 'jpeg', quality: 1, maxSize: 600 }));
  assert(changes(lowerQuality.bitmap, higherQuality.bitmap).count > 0);
  passed('JPG preview passes through the selected JPEG quality encoder');

  const stamped = await decoded(await request('export', { mode: 'original', watermark: mark }));
  const stampChanges = changes(baseline, stamped);
  assert(stampChanges.count > 100); assert(stampChanges.left > 300); assert(stampChanges.top > 300);
  assert(stampChanges.right < 600 && stampChanges.bottom < 400);
  assert.deepEqual(pixel(stamped, 0, 0), [0, 0, 0, 0]);
  passed('watermark changes only the requested corner and PNG keeps transparency');

  const stampedJpeg = await decoded(await request('export', { mode: 'original', format: 'jpeg', watermark: mark }));
  assert(changes(await decoded(await request('export', { mode: 'original', format: 'jpeg' })), stampedJpeg).count > 100);
  assert.deepEqual(pixel(stampedJpeg, 0, 0), [255, 255, 255, 255]);
  passed('JPG watermarks are encoded into the image while retaining an opaque background');

  for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'tile']) {
    const marked = await decoded(await request('export', { mode: 'original', watermark: { ...mark, position } }));
    const box = changes(baseline, marked); assert(box.count > 100, `${position} watermark is absent`);
    if (position === 'tile') assert.equal(box.quadrants.size, 4, 'tiled watermarks must cover all quadrants');
    else {
      if (position.startsWith('top')) assert(box.bottom < 100);
      if (position.startsWith('bottom')) assert(box.top > 300);
      if (position.endsWith('left')) assert(box.right < 300);
      if (position.endsWith('right')) assert(box.left > 300);
      if (position === 'center') assert(Math.abs((box.left + box.right) / 2 - 300) < 4 && Math.abs((box.top + box.bottom) / 2 - 200) < 4);
    }
  }
  passed('all five single positions and diagonal tiling place visible text correctly');

  const zero = await decoded(await request('export', { mode: 'original', watermark: { ...mark, opacity: 0 } }));
  assert.equal(changes(baseline, zero).count, 0);
  passed('zero opacity leaves exported pixels unchanged');
  const subsequent = success(await request('render', { mode: 'original', maxSize: 600 })).bitmap;
  assert.equal(changes(baseline, subsequent).count, 0);
  passed('watermark does not contaminate original or cached preview pixels');

  const preview = success(await request('exportPreview', { mode: 'original', watermark: mark, maxSize: 600 }));
  assert.equal(preview.exportWidth, 600); assert.equal(preview.exportHeight, 400); assert(preview.canExport);
  assert.equal(changes(stamped, preview.bitmap).count, 0);
  passed('same-size preview and exported PNG have identical watermark pixels');
  const smallPreview = success(await request('exportPreview', { mode: 'original', watermark: mark, maxSize: 300 }));
  const smallBaseline = success(await request('exportPreview', { mode: 'original', maxSize: 300 })).bitmap;
  const smallBox = changes(smallBaseline, smallPreview.bitmap);
  assert(Math.abs(smallBox.left / 300 - stampChanges.left / 600) < .03);
  assert(Math.abs(smallBox.bottom / 200 - stampChanges.bottom / 400) < .03);
  passed('reduced preview preserves proportional watermark placement');

  const shrunk = success(await request('export', { mode: 'original', exportSize: 300, watermark: mark }));
  const shrunkImage = await decoded(shrunk);
  assert.equal(shrunkImage.width, 300); assert.equal(shrunkImage.height, 200);
  const noEnlarge = success(await request('export', { mode: 'original', exportSize: 1200 }));
  assert.equal(noEnlarge.width, 600); assert.equal(noEnlarge.height, 400);
  passed('exportSize shrinks to the requested long edge and never enlarges');

  const empty = await request('export', { mode: 'original', watermark: { enabled: true, text: '   ' } });
  assert(!empty.ok && empty.error.includes('水印文字'));
  const invalid = await request('export', { mode: 'original', format: 'webp' });
  assert(!invalid.ok && invalid.error.includes('PNG'));
  passed('empty enabled watermark and unsupported format return readable errors');

  const longText = await decoded(await request('export', { mode: 'original', watermark: { ...mark, text: 'A long watermark '.repeat(9) } }));
  const longBox = changes(baseline, longText);
  assert(longBox.count > 20 && longBox.left >= 0 && longBox.right < 600);
  passed('long watermarks remain inside the output image');

  sandbox.self.fonts.ready = new Promise(() => {});
  const fontWaitStarted = Date.now();
  const fontFallback = success(await request('exportPreview', { mode: 'original', watermark: mark, maxSize: 600 }));
  assert(Date.now() - fontWaitStarted < 1000);
  assert(changes(baseline, fontFallback.bitmap).count > 100);
  sandbox.self.fonts.ready = Promise.resolve();
  passed('a pending Worker FontFaceSet cannot block the export queue indefinitely');

  // Enlarge only document bounds while preserving the tiny test layer. A
  // composite render never reads this fixture's deliberately stale merged
  // bitmap, allowing the size-budget branch to be checked without 80MP RAM.
  const large = Buffer.from(source); large.writeUInt32BE(8000, 14); large.writeUInt32BE(10000, 18);
  success(await request('open', { file: new File([large], 'large-export-bounds.psd') }));
  const refused = await request('export', { mode: 'composite' });
  assert(!refused.ok && refused.error.includes('6400'));
  const largePreview = success(await request('exportPreview', { mode: 'composite', watermark: mark }));
  assert.equal(largePreview.exportWidth, 10000); assert.equal(largePreview.exportHeight, 8000);
  assert.equal(largePreview.canExport, false); assert(largePreview.bitmap.width <= 900);
  const reduced = success(await request('export', { mode: 'composite', exportSize: 1200, format: 'jpeg', watermark: mark }));
  assert.equal(reduced.width, 1200); assert.equal(reduced.height, 960);
  assert.equal(reduced.blob.type, 'image/jpeg');
  passed('oversize documents can preview and shrink-export while original-size budget remains enforced');
  console.log(`${checks} export/watermark checks passed.`);
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
