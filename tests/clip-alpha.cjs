'use strict';

// Regression fixture for Photoshop clipping-group alpha. Run with Node and the
// project @napi-rs/canvas development dependency; the delivered HTML needs neither.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const { createCanvas, ImageData, Path2D, loadImage } = require(process.env.PSD_TEST_CANVAS || '@napi-rs/canvas');
const ag = require(process.env.PSD_TEST_MODULE || 'ag-psd');
ag.initializeCanvas(createCanvas, (w, h) => new ImageData(w, h));
let nextLayerId = 0;

function pixels(name, x, y, width, height, rgba, extra = {}) {
  const canvas = createCanvas(width, height);
  const data = new ImageData(width, height);
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const value = typeof rgba === 'function' ? rgba(px, py) : rgba;
    data.data.set(value, (py * width + px) * 4);
  }
  canvas.getContext('2d').putImageData(data, 0, 0);
  return { id: ++nextLayerId, name, left: x, top: y, canvas, opacity: 1, blendMode: 'normal', ...extra };
}

const children = [];
const probes = [];
const referenceAreas = [];
function probe(at, rgba, why, tolerance = 2) { probes.push({ at, rgba, why, tolerance }); }
function pair(name, x, y, options, expected) {
  const { alpha = 128, opacity = 1, clipOpacity = 1, blend = 'normal' } = options;
  children.push(pixels(`${name} base`, x, y, 32, 24, [255, 0, 0, alpha], { opacity }));
  children.push(pixels(`${name} clipped blue`, x, y, 32, 24, [0, 0, 255, 255], { clipping: true, opacity: clipOpacity, blendMode: blend }));
  probe([x + 12, y + 12], expected, name);
  referenceAreas.push({ x, y, width: 32, height: 24, rgba: expected });
}
pair('pixel alpha 50% stays 50%', 0, 0, {}, [0, 0, 255, 128]);
pair('pixel alpha 50% times base layer opacity 50%', 40, 0, { opacity: .5 }, [0, 0, 255, 64]);
pair('opaque base times base layer opacity 50%', 80, 0, { alpha: 255, opacity: .5 }, [0, 0, 255, 128]);
pair('clip opacity mixes RGB but preserves base alpha', 0, 32, { clipOpacity: .5 }, [127, 0, 128, 128]);
pair('multiply clip preserves base alpha', 40, 32, { blend: 'multiply' }, [0, 0, 0, 128]);
pair('screen clip preserves base alpha', 80, 32, { blend: 'screen' }, [255, 0, 255, 128]);

const ramp = [0, 1, 64, 128, 192, 254, 255];
children.push(pixels('alpha ramp base', 0, 64, 28, 24, x => [255, 0, 0, ramp[Math.floor(x / 4)]]));
children.push(pixels('alpha ramp clipped blue', 0, 64, 28, 24, [0, 0, 255, 255], { clipping: true }));
for (let i = 0; i < ramp.length; i++) probe([i * 4 + 2, 76], ramp[i] ? [0, 0, 255, ramp[i]] : [0, 0, 0, 0], `antialiased edge alpha ${ramp[i]}`, 1);
referenceAreas.push({ x: 0, y: 64, width: 28, height: 24, rgba: x => ramp[Math.floor(x / 4)] ? [0, 0, 255, ramp[Math.floor(x / 4)]] : [0, 0, 0, 0] });
pair('multiply clip plus base layer opacity', 40, 64, { blend: 'multiply', opacity: .5 }, [0, 0, 0, 64]);
children.push(pixels('stacked clip base', 80, 64, 32, 24, [255, 0, 0, 128]));
children.push(pixels('stacked clipped green 50%', 80, 64, 32, 24, [0, 255, 0, 255], { clipping: true, opacity: .5 }));
children.push(pixels('stacked clipped blue 50%', 80, 64, 32, 24, [0, 0, 255, 255], { clipping: true, opacity: .5 }));
probe([92, 76], [63, 64, 128, 128], 'stacked clipping layers share a single shape alpha');
referenceAreas.push({ x: 80, y: 64, width: 32, height: 24, rgba: [63, 64, 128, 128] });

const reference = createCanvas(120, 96);
const refPixels = new ImageData(120, 96);
// The merged preview is a simple independent reference for the solid cases.
// Tests below assert exact analytical values against the worker's recomposition.
for (const area of referenceAreas) for (let y = 0; y < area.height; y++) for (let x = 0; x < area.width; x++) {
  const rgba = typeof area.rgba === 'function' ? area.rgba(x, y) : area.rgba;
  refPixels.data.set(rgba, ((area.y + y) * 120 + area.x + x) * 4);
}
reference.getContext('2d').putImageData(refPixels, 0, 0);
const buffer = ag.writePsdBuffer({ width: 120, height: 96, canvas: reference, children }, { noBackground: true });
const expected = { width: 120, height: 96, layerNodes: children.length, probes };

if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(__dirname, 'clip-alpha.psd'), buffer);
  fs.writeFileSync(path.join(__dirname, 'clip-alpha.expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
}

// A minimal in-process adapter uses a real canvas engine and the real bundled
// parser. It executes the same worker source that is embedded in index.html.
function offscreen(width, height) {
  const canvas = createCanvas(width, height);
  canvas.close = () => {};
  canvas.convertToBlob = async () => new Blob([canvas.toBuffer('image/png')], { type: 'image/png' });
  return canvas;
}
async function createBitmap(source, ...args) {
  if (source instanceof ImageData) {
    const image = offscreen(source.width, source.height);
    image.getContext('2d').putImageData(source, 0, 0);
    source = image;
  }
  let sx = 0, sy = 0, sw = source.width, sh = source.height, options = {};
  if (args.length >= 4) [sx, sy, sw, sh, options = {}] = args;
  else options = args[0] || {};
  const result = offscreen(options.resizeWidth || sw, options.resizeHeight || sh);
  result.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, result.width, result.height);
  return result;
}
let counter = 0;
const pending = new Map();
const sandbox = {
  agPsd: ag, OffscreenCanvas: offscreen, ImageData, Path2D, createImageBitmap: createBitmap,
  Blob, File, DataView, ArrayBuffer, Uint8Array, Uint8ClampedArray, Uint16Array, Float32Array,
  self: { postMessage(result) { pending.get(result.id)(result); pending.delete(result.id); } },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/worker.js'), 'utf8'), sandbox);
function request(type, payload) {
  return new Promise(resolve => {
    const id = ++counter;
    pending.set(id, resolve);
    sandbox.self.onmessage({ data: { id, type, ...payload } });
  });
}
async function verify() {
  const opened = await request('open', { file: new File([buffer], 'clip-alpha.psd') });
  assert(opened.ok, opened.error);
  assert.equal(opened.doc.count, expected.layerNodes);
  const result = await request('render', { mode: 'composite', maxSize: 120 });
  assert(result.ok, result.error);
  const ctx = result.bitmap.getContext('2d');
  for (const p of probes) {
    const actual = [...ctx.getImageData(...p.at, 1, 1).data];
    assert(actual.every((value, i) => Math.abs(value - p.rgba[i]) <= p.tolerance), `${p.why}: got ${actual}, expected ${p.rgba}`);
    console.log(`PASS ${p.why}: ${actual}`);
  }
  const exported = await request('export', { mode: 'composite' });
  assert(exported.ok, exported.error);
  assert(exported.blob.size > 100);
  const png = await loadImage(Buffer.from(await exported.blob.arrayBuffer()));
  const pngCanvas = createCanvas(png.width, png.height);
  pngCanvas.getContext('2d').drawImage(png, 0, 0);
  for (const p of probes) {
    const actual = [...pngCanvas.getContext('2d').getImageData(...p.at, 1, 1).data];
    assert(actual.every((value, i) => Math.abs(value - p.rgba[i]) <= p.tolerance), `export ${p.why}: got ${actual}, expected ${p.rgba}`);
  }
  console.log(`${probes.length} clipping-alpha probes passed; PNG export ${exported.blob.size} bytes.`);
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
