'use strict';

// Pixel invariants and the actual shared worker routes, using native canvas
// for image encoding/decoding. No browser filter implementation is substituted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const { createCanvas, ImageData, loadImage, Path2D } = require(process.env.PSD_TEST_CANVAS || '@napi-rs/canvas');
const source = fs.readFileSync(path.join(ROOT, 'src/filters.js'), 'utf8');
const pixelContext = vm.createContext({ Uint8ClampedArray, Float32Array, Float64Array, Int32Array, setTimeout, performance });
vm.runInContext(source, pixelContext);
const filters = pixelContext.LayerDeskFilters;
const image = (width, height, color) => {
  const output = new ImageData(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) output.data.set(color(x, y), (y * width + x) * 4);
  return output;
};
const clone = pixels => new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
const alpha = pixels => Array.from(pixels.data).filter((_, i) => i % 4 === 3);
const at = (pixels, x, y) => Array.from(pixels.data.slice((y * pixels.width + x) * 4, (y * pixels.width + x + 1) * 4));
const results = [];
async function check(name, action) { await action(); results.push({ name, passed: true }); }

let created = 0;
function offscreen(width, height) {
  const surface = createCanvas(width, height);
  surface.closed = 0;
  surface.close = () => { surface.closed++; };
  surface.convertToBlob = async ({ type = 'image/png', quality = .92 } = {}) => new Blob([
    type === 'image/jpeg' ? surface.toBuffer('image/jpeg', Math.round(quality * 100)) : surface.toBuffer('image/png'),
  ], { type });
  return surface;
}
async function createBitmap(value) {
  if (value instanceof Blob) value = await loadImage(Buffer.from(await value.arrayBuffer()));
  if (value instanceof ImageData) {
    const pixels = offscreen(value.width, value.height); pixels.getContext('2d').putImageData(value, 0, 0); value = pixels;
  }
  const output = offscreen(value.width, value.height);
  output.getContext('2d').drawImage(value, 0, 0);
  created++;
  return output;
}
const agPsd = require(process.env.PSD_TEST_MODULE || 'ag-psd');
const pending = new Map(); let nextId = 0;
const worker = vm.createContext({
  agPsd, OffscreenCanvas: offscreen, ImageData, Path2D, createImageBitmap: createBitmap,
  Blob, File, ArrayBuffer, DataView, Uint8Array, Uint8ClampedArray, Uint16Array, Int32Array, Float32Array, Float64Array,
  setTimeout, performance, self: { postMessage(result) { const done = pending.get(result.id); pending.delete(result.id); done(result); } },
});
vm.runInContext(source, worker);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/worker.js'), 'utf8'), worker);
const request = (type, payload) => new Promise(resolve => {
  const id = ++nextId; pending.set(id, resolve); worker.self.onmessage({ data: { id, type, ...payload } });
});
const readSurface = surface => surface.getContext('2d').getImageData(0, 0, surface.width, surface.height);
async function fixtureBitmap(pixels) { return createBitmap(pixels); }

(async () => {
  await check('normalization and seven cloneable presets', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(filters.normalize({ brightness: 500, contrast: -200, saturation: NaN, temperature: Infinity, sharpness: -1, strength: 900 }))),
      { brightness: 100, contrast: -100, saturation: 0, temperature: 0, sharpness: 0, strength: 100 });
    assert.equal(filters.PRESETS.length, 7);
    assert.equal(new Set(filters.PRESETS.map(p => p.id)).size, 7);
    for (const preset of filters.PRESETS) {
      assert(preset.name && preset.description);
      assert.equal(Object.keys(structuredClone(preset.settings)).length, 6);
      assert(!filters.isIdentity(preset.settings));
    }
  });
  const sample = image(23, 17, (x, y) => [(x * 19 + y * 7) % 256, (x * 3 + y * 29) % 256, (x * 31 + y * 13) % 256, [0, 64, 128, 255][(x + y) % 4]]);
  await check('identity and strength zero preserve every byte', async () => {
    for (const settings of [{}, { ...filters.PRESETS[0].settings, strength: 0 }]) {
      const output = clone(sample);
      assert.strictEqual(await filters.process(output, settings), output);
      assert.deepEqual(output.data, sample.data);
    }
  });
  await check('brightness contrast saturation and temperature have independent effects', async () => {
    const base = image(2, 1, x => x ? [190, 170, 150, 128] : [60, 80, 100, 255]);
    const brighter = await filters.process(clone(base), { brightness: 20 });
    assert(at(brighter, 0, 0)[0] > 60 && at(brighter, 1, 0)[0] > 190);
    const contrast = await filters.process(clone(base), { contrast: 30 });
    assert(at(contrast, 0, 0)[0] < 60 && at(contrast, 1, 0)[0] > 190);
    const mono = await filters.process(clone(base), { saturation: -100 });
    for (let x = 0; x < 2; x++) { const [r, g, b] = at(mono, x, 0); assert.equal(r, g); assert.equal(g, b); }
    const warm = await filters.process(clone(base), { temperature: 30 });
    assert(at(warm, 0, 0)[0] > 60 && at(warm, 0, 0)[2] < 100);
    assert.deepEqual(alpha(warm), alpha(base));
  });
  await check('portrait preset gently lifts skin and mid-gray with a warm tint and unchanged alpha', async () => {
    const portrait = filters.PRESETS.find(preset => preset.id === 'portrait');
    assert(portrait, 'portrait preset missing');
    assert.equal(portrait.settings.sharpness, 0);
    const base = image(3, 1, x => [[164, 112, 86, 255], [128, 128, 128, 128], [30, 60, 90, 0]][x]);
    const output = await filters.process(clone(base), portrait.settings);
    const luminance = pixel => pixel[0] * .2126 + pixel[1] * .7152 + pixel[2] * .0722;
    for (const x of [0, 1]) {
      const before = at(base, x, 0), after = at(output, x, 0);
      const lift = luminance(after) - luminance(before);
      assert(lift > 0 && lift < 25, `portrait brightness should remain gentle at ${x}: ${lift}`);
    }
    const gray = at(output, 1, 0);
    assert(gray[0] > gray[1] && gray[1] > gray[2], 'mid-gray should gain a restrained warm tint');
    assert(gray[0] - gray[2] < 12, 'portrait warmth should remain subtle');
    const noTemperature = await filters.process(clone(base), { ...portrait.settings, temperature: 0 });
    const skin = at(output, 0, 0), neutralSkin = at(noTemperature, 0, 0);
    assert(skin[0] > neutralSkin[0] && skin[2] < neutralSkin[2], 'skin should gain slight warmth without an aggressive color cast');
    assert.deepEqual(alpha(output), alpha(base));
    assert.deepEqual(at(output, 2, 0), at(base, 2, 0));
  });
  await check('all presets preserve alpha and fully transparent RGB', async () => {
    for (const preset of filters.PRESETS) {
      const output = await filters.process(clone(sample), preset.settings);
      assert.deepEqual(alpha(output), alpha(sample), preset.id);
      for (let i = 0; i < sample.data.length; i += 4) if (!sample.data[i + 3]) assert.deepEqual(output.data.slice(i, i + 4), sample.data.slice(i, i + 4));
    }
  });
  await check('alpha-aware sharpening has no dark transparent-edge fringe', async () => {
    const base = image(21, 19, (x, y) => x > 4 && x < 16 && y > 4 && y < 14 ? [90, 140, 190, x === 5 ? 80 : 255] : [0, 0, 0, 0]);
    const output = await filters.process(clone(base), { sharpness: 100 });
    assert.deepEqual(output.data, base.data);
  });
  await check('unsharp read-ahead matches independent 2D reference at opaque and translucent pixels', async () => {
    const base = image(19, 17, (x, y) => [60 + (x * 11 + y * 3) % 130, 70 + (x * 7 + y * 13) % 120, 50 + (x * 17 + y * 5) % 140, [0, 90, 180, 255][(x + 2 * y) % 4]]);
    const output = await filters.process(clone(base), { sharpness: 70 });
    const sigma = 1.2, radius = 4;
    for (const [x, y] of [[1, 1], [9, 8], [17, 15], [3, 14], [10, 2]]) {
      const original = at(base, x, y); if (!original[3]) continue;
      const accum = [0, 0, 0]; let total = 0;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const pixel = at(base, Math.max(0, Math.min(base.width - 1, x + dx)), Math.max(0, Math.min(base.height - 1, y + dy)));
        const weight = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) * pixel[3]; total += weight;
        for (let c = 0; c < 3; c++) accum[c] += pixel[c] * weight;
      }
      const actual = at(output, x, y);
      for (let c = 0; c < 3; c++) {
        const expected = Math.max(0, Math.min(255, Math.round(original[c] + 1.05 * (original[c] - accum[c] / total))));
        assert(Math.abs(actual[c] - expected) <= 1, `${x},${y},${c}: ${actual[c]} vs ${expected}`);
      }
      assert.equal(actual[3], original[3]);
    }
  });
  await check('strength blends the complete color and sharpen result', async () => {
    const settings = { brightness: 12, contrast: 15, saturation: 18, temperature: -8, sharpness: 65 };
    const full = await filters.process(clone(sample), { ...settings, strength: 100 });
    const half = await filters.process(clone(sample), { ...settings, strength: 50 });
    for (let i = 0; i < sample.data.length; i++) {
      const expected = i % 4 === 3 ? sample.data[i] : (sample.data[i] + full.data[i]) / 2;
      assert(Math.abs(half.data[i] - expected) <= 1, `strength at ${i}`);
    }
  });
  await check('source pixel radius scales with raster resolution', async () => {
    const edge = image(64, 12, x => x < 32 ? [100, 100, 100, 255] : [160, 160, 160, 255]);
    const native = await filters.process(clone(edge), { sharpness: 100 }, { sourceWidth: 64, sourceHeight: 12 });
    const reduced = await filters.process(clone(edge), { sharpness: 100 }, { sourceWidth: 128, sourceHeight: 24 });
    assert(at(native, 31, 6)[0] < at(reduced, 31, 6)[0]);
    assert(at(native, 32, 6)[0] > at(reduced, 32, 6)[0]);
    assert.equal(at(native, 12, 6)[0], 100);
  });
  await check('large processing yields to the worker event loop', async () => {
    let ticks = 0, clock = 0;
    const context = vm.createContext({ Uint8ClampedArray, Float32Array, Float64Array, Int32Array, performance: { now: () => clock += 20 }, setTimeout: callback => { ticks++; setImmediate(callback); } });
    vm.runInContext(source, context);
    await context.LayerDeskFilters.process(image(1024, 512, () => [90, 130, 160, 255]), { brightness: 8, sharpness: 20 });
    assert(ticks >= 2);
  });
  const workerSample = image(32, 24, (x, y) => x < 4 || y < 3 ? [0, 0, 0, 0] : [60 + x * 3, 70 + y * 4, 170, x < 7 ? 128 : 255]);
  await check('adjustRaster matches export preview and closes owned inputs', async () => {
    const adjustments = filters.PRESETS[0].settings;
    const input = await fixtureBitmap(workerSample);
    const adjusted = await request('adjustRaster', { bitmap: input, adjustments, sourceWidth: 32, sourceHeight: 24 });
    assert(adjusted.ok, adjusted.error); assert.equal(input.closed, 1);
    const previewInput = await fixtureBitmap(workerSample);
    const preview = await request('rasterExport', { bitmap: previewInput, adjustments, preview: true, format: 'png', documentWidth: 32, documentHeight: 24 });
    assert(preview.ok, preview.error); assert.equal(previewInput.closed, 1);
    assert.deepEqual(readSurface(adjusted.bitmap).data, readSurface(preview.bitmap).data);
    // Compare against the same native rasterization path: this Node canvas
    // runtime's high-quality drawImage can antialias even an equal-size copy.
    // Pure ImageData alpha is checked byte-for-byte independently above.
    const baseline = await request('adjustRaster', { bitmap: await fixtureBitmap(workerSample), adjustments: {} });
    assert(baseline.ok, baseline.error);
    assert.deepEqual(alpha(readSurface(preview.bitmap)), alpha(readSurface(baseline.bitmap)));
    baseline.bitmap.close();
    adjusted.bitmap.close(); preview.bitmap.close();
  });
  await check('PNG export shares pixels; JPG flattens after filters; absent settings leave ordinary raster unchanged', async () => {
    const adjustments = { brightness: 22, temperature: 18, sharpness: 35 };
    const preview = await request('rasterExport', { bitmap: await fixtureBitmap(workerSample), adjustments, preview: true, format: 'png' });
    assert(preview.ok, preview.error);
    const pngInput = await fixtureBitmap(workerSample);
    const png = await request('rasterExport', { bitmap: pngInput, adjustments, format: 'png' });
    assert(png.ok, png.error); assert.equal(pngInput.closed, 1);
    const decoded = await createBitmap(png.blob);
    assert.deepEqual(readSurface(decoded).data, readSurface(preview.bitmap).data);
    const jpeg = await request('rasterExport', { bitmap: await fixtureBitmap(workerSample), adjustments, format: 'jpeg', background: '#ffffff', quality: 1 });
    assert(jpeg.ok, jpeg.error); assert.equal(jpeg.blob.type, 'image/jpeg');
    const jpgPixels = readSurface(await createBitmap(jpeg.blob));
    assert(alpha(jpgPixels).every(a => a === 255)); assert(at(jpgPixels, 0, 0).slice(0, 3).every(c => c > 245));
    const baseline = await request('adjustRaster', { bitmap: await fixtureBitmap(workerSample), adjustments: {} });
    assert(baseline.ok, baseline.error);
    const plainInput = await fixtureBitmap(workerSample), plainExpected = readSurface(baseline.bitmap);
    const plain = await request('rasterExport', { bitmap: plainInput, preview: true, format: 'png' });
    assert(plain.ok, plain.error); assert.deepEqual(readSurface(plain.bitmap).data, plainExpected.data);
    preview.bitmap.close(); decoded.close(); plain.bitmap.close(); baseline.bitmap.close();
  });
  await check('invalid adjustment input is closed and the worker accepts the next job', async () => {
    const oversized = { width: 32768, height: 1, closed: 0, close() { this.closed++; } };
    const failed = await request('adjustRaster', { bitmap: oversized, adjustments: { brightness: 20 } });
    assert.equal(failed.ok, false); assert.equal(oversized.closed, 1);
    const next = await request('adjustRaster', { bitmap: await fixtureBitmap(workerSample), adjustments: {} });
    assert(next.ok, next.error); next.bitmap.close();
    await assert.rejects(() => filters.process({ width: 4, height: 4, data: new Uint8ClampedArray(4) }, {}), /尺寸/);
  });
  console.log(JSON.stringify({ passed: results.length, checks: results, nativeBitmapCopies: created }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
