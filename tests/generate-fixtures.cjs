'use strict';

// Deterministic, genuine PSD fixtures. Canvas is only a development dependency;
// the delivered HTML contains its parser and never loads this script.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { createCanvas, ImageData } = require(process.env.PSD_TEST_CANVAS || '@napi-rs/canvas');
const ag = require(process.env.PSD_TEST_MODULE || 'ag-psd');
ag.initializeCanvas(createCanvas, (w, h) => new ImageData(w, h));
let nextId = 1;
const color = hex => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
const base = name => ({ id: nextId++, name, opacity: 1, blendMode: 'normal' });
function pixel(name, x, y, w, h, draw, extra = {}) {
  const canvas = createCanvas(w, h);
  const c = canvas.getContext('2d');
  draw(c, w, h);
  return { ...base(name), left: x, top: y, canvas, ...extra };
}
function rect(name, x, y, w, h, fill, extra = {}) {
  const p = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  return pixel(name, x, y, w, h, c => { c.fillStyle = fill; c.fillRect(0, 0, w, h); }, {
    vectorFill: { type: 'color', color: color(fill) },
    vectorMask: { fillStartsWithAllPixels: false, paths: [{ open: false, operation: 'combine', fillRule: 'non-zero', knots: p.map(([a, b]) => ({ linked: false, points: [a, b, a, b, a, b] })) }] },
    ...extra,
  });
}
function text(name, value, x, y, w, h, size, fill, options = {}) {
  const family = options.chinese ? 'Hiragino Sans GB' : 'Helvetica Neue';
  const weight = options.weight || 500;
  const leading = options.leading || size * 1.06;
  const t = pixel(name, x, y, w, h, c => {
    c.fillStyle = fill; c.font = `${weight} ${size}px "${family}"`; c.textBaseline = 'top';
    value.split('\n').forEach((line, i) => c.fillText(line, 1, i * leading));
  });
  t.text = {
    text: value.replace(/\n/g, '\r'), transform: [1, 0, 0, 1, x + 1, y + size * .85],
    antiAlias: 'smooth', gridding: 'none', orientation: 'horizontal', shapeType: 'point', pointBase: [0, 0],
    style: { font: { name: options.chinese ? 'HiraginoSansGB-W3' : (weight >= 600 ? 'HelveticaNeue-Bold' : 'HelveticaNeue'), script: options.chinese ? 25 : 0, type: 1, synthetic: 0 }, fontSize: size, fillColor: color(fill), leading, autoLeading: false },
    paragraphStyle: { justification: 'left' },
  };
  return t;
}
const group = (name, children, extra = {}) => ({ ...base(name), blendMode: 'pass through', opened: true, children, ...extra });

function layerCanvas(layer) {
  if (!layer.canvas) return null;
  const result = createCanvas(layer.canvas.width, layer.canvas.height), c = result.getContext('2d');
  c.drawImage(layer.canvas, 0, 0);
  if (layer.mask?.canvas && !layer.mask.disabled) {
    const d = c.getImageData(0, 0, result.width, result.height);
    const m = layer.mask.canvas.getContext('2d').getImageData(0, 0, result.width, result.height);
    for (let i = 0; i < d.data.length; i += 4) d.data[i + 3] = Math.round(d.data[i + 3] * m.data[i] / 255);
    c.putImageData(d, 0, 0);
  }
  return result;
}
function composite(layers, w, h) {
  const canvas = createCanvas(w, h), c = canvas.getContext('2d');
  let clippingBase = null;
  for (const layer of layers) {
    if (layer.hidden) continue;
    let image, x = layer.left || 0, y = layer.top || 0;
    if (layer.children) { image = composite(layer.children, w, h); x = y = 0; }
    else image = layerCanvas(layer);
    if (!image) continue;
    if (layer.clipping && clippingBase) {
      const clipped = createCanvas(w, h), cc = clipped.getContext('2d');
      cc.drawImage(image, x, y); cc.globalCompositeOperation = 'destination-in';
      cc.drawImage(clippingBase, 0, 0); image = clipped; x = y = 0;
    } else if (!layer.clipping) {
      clippingBase = createCanvas(w, h); clippingBase.getContext('2d').drawImage(image, x, y);
    }
    c.save(); c.globalAlpha = layer.opacity ?? 1;
    c.globalCompositeOperation = layer.blendMode === 'multiply' ? 'multiply' : 'source-over';
    c.drawImage(image, x, y); c.restore();
  }
  return canvas;
}
function count(children) { return children.reduce((n, l) => n + 1 + (l.children ? count(l.children) : 0), 0); }
function save(file, width, height, children) {
  const canvas = composite(children, width, height);
  const psd = { width, height, bitsPerChannel: 8, colorMode: 3, children, canvas };
  fs.writeFileSync(file, ag.writePsdBuffer(psd, { generateThumbnail: true }));
  const check = ag.readPsd(fs.readFileSync(file), { useRawData: true, useRawThumbnail: true });
  if (count(check.children) !== count(children)) throw new Error('Layer count did not survive PSD serialization');
  return { canvas, count: count(children), bytes: fs.statSync(file).size };
}

// A quiet editorial poster; each visible element is an independent layer.
const paper = '#eeeae2', ink = '#24332e', blue = '#4979f0', orange = '#f38c53';
const W = 1000, H = 750;
const background = group('01 · 纸张与底色', [
  rect('暖灰纸张', 0, 0, W, H, paper),
  pixel('纸张纹理', 0, 0, W, H, c => {
    let seed = 271828;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    c.fillStyle = 'rgba(38,42,35,.025)';
    for (let i = 0; i < 3600; i++) c.fillRect(Math.floor(random() * W), Math.floor(random() * H), 1, 1);
  }),
]);
const art = group('02 · 几何与光影', [
  rect('蓝色竖向色块', 610, 100, 274, 477, blue),
  pixel('橙色球体', 513, 229, 303, 303, c => {
    const g = c.createRadialGradient(92, 74, 7, 155, 160, 190); g.addColorStop(0, '#ffd5a8'); g.addColorStop(.55, orange); g.addColorStop(1, '#c85436');
    c.fillStyle = g; c.beginPath(); c.arc(151.5, 151.5, 150, 0, Math.PI * 2); c.fill();
  }),
  pixel('森林绿半圆', 728, 421, 177, 177, c => {
    c.fillStyle = '#2c5847'; c.beginPath(); c.arc(88.5, 88.5, 88, Math.PI * 1.1, Math.PI * 2.1); c.closePath(); c.fill();
  }),
  pixel('白色轨道', 519, 188, 346, 356, c => {
    c.strokeStyle = 'rgba(255,255,255,.78)'; c.lineWidth = 2; c.beginPath(); c.ellipse(173, 178, 86, 176, .57, 0, Math.PI * 2); c.stroke();
  }),
  pixel('几何十字', 827, 76, 36, 36, c => { c.strokeStyle = ink; c.lineWidth = 1.5; c.beginPath(); c.moveTo(18, 0); c.lineTo(18, 36); c.moveTo(0, 18); c.lineTo(36, 18); c.stroke(); }),
  rect('橙色注脚线', 610, 609, 274, 3, orange),
]);
const typography = group('03 · 标题与信息', [
  text('眉题 · CREATIVE EXPLORATION', 'CREATIVE EXPLORATION  /  VOL. 01', 76, 75, 450, 24, 13, ink, { weight: 500 }),
  text('主标题 · FORM & FEEL', 'FORM\n& FEEL', 70, 169, 474, 232, 96, ink, { weight: 700, leading: 94 }),
  text('中文副标题', '一点灵感，逐层展开。', 78, 430, 380, 45, 25, ink, { chinese: true }),
  text('英文说明', 'An experiment in shape,\ncolour and quiet composition.', 78, 489, 380, 62, 18, '#68726a', { leading: 26 }),
  text('右侧图形编号', 'FIG. 01  /  COLOUR STUDY', 610, 630, 300, 22, 11, '#536159'),
  rect('底部细线', 78, 659, 806, 1, '#b8bfb6'),
  text('底部索引', 'LAYERDESK  /  LOCAL PSD EXPLORER', 78, 680, 500, 20, 10, '#536159'),
  text('底部页码', '01 — 03', 823, 680, 80, 20, 10, '#536159'),
]);
const hidden = group('04 · 备选方案（已隐藏）', [
  rect('珊瑚色替代背景', 0, 0, W, H, '#f3c6b3'),
  text('备选标题', 'A DIFFERENT\nPERSPECTIVE', 80, 180, 800, 220, 72, ink, { weight: 700 }),
], { hidden: true });
const demo = save(path.join(ROOT, 'src/demo.psd'), W, H, [background, art, typography, hidden]);
fs.writeFileSync(path.join(__dirname, 'demo-preview.png'), demo.canvas.toBuffer('image/png'));

// Tiny, analytical fixture. Probe coordinates are well inside hard edges.
const mask = createCanvas(32, 32), mc = mask.getContext('2d');
mc.fillStyle = '#000'; mc.fillRect(0, 0, 32, 32); mc.fillStyle = '#fff'; mc.fillRect(0, 0, 16, 32);
const fixture = [
  pixel('white background', 0, 0, 128, 96, c => { c.fillStyle = '#fff'; c.fillRect(0, 0, 128, 96); }),
  pixel('red square', 4, 4, 32, 32, c => { c.fillStyle = '#f00'; c.fillRect(0, 0, 32, 32); }),
  pixel('hidden blue square', 4, 4, 32, 32, c => { c.fillStyle = '#00f'; c.fillRect(0, 0, 32, 32); }, { hidden: true }),
  group('isolated group at 50%', [
    pixel('blue in group', 48, 4, 24, 24, c => { c.fillStyle = '#00f'; c.fillRect(0, 0, 24, 24); }),
    pixel('green in group', 60, 16, 24, 24, c => { c.fillStyle = '#0f0'; c.fillRect(0, 0, 24, 24); }),
  ], { opacity: .5, blendMode: 'normal' }),
  pixel('magenta with left half mask', 4, 48, 32, 32, c => { c.fillStyle = '#f0f'; c.fillRect(0, 0, 32, 32); }, { mask: { left: 4, top: 48, canvas: mask, defaultColor: 0, positionRelativeToLayer: false } }),
  pixel('clipping base circle', 48, 48, 24, 24, c => { c.fillStyle = '#00f'; c.beginPath(); c.arc(12, 12, 10, 0, Math.PI * 2); c.fill(); }),
  pixel('clipped orange', 44, 44, 40, 40, c => { c.fillStyle = '#ff8000'; c.fillRect(0, 0, 40, 40); }, { clipping: true }),
  pixel('multiply base yellow', 96, 4, 24, 24, c => { c.fillStyle = '#ff0'; c.fillRect(0, 0, 24, 24); }),
  pixel('multiply magenta', 96, 4, 24, 24, c => { c.fillStyle = '#f0f'; c.fillRect(0, 0, 24, 24); }, { blendMode: 'multiply' }),
  { ...base('brightness adjustment without pixels'), adjustment: { type: 'brightness/contrast', brightness: 0, contrast: 0, useLegacy: false } },
  group('empty group', []),
];
const result = save(path.join(__dirname, 'compositing.psd'), 128, 96, fixture);
fs.writeFileSync(path.join(__dirname, 'compositing-reference.png'), result.canvas.toBuffer('image/png'));
const probes = [
  { at: [12, 12], rgba: [255, 0, 0, 255], why: 'Hidden layer must not cover the red layer.' },
  { at: [52, 12], rgba: [128, 128, 255, 255], why: 'Isolated group opacity is applied after child composition.' },
  { at: [64, 20], rgba: [128, 255, 128, 255], why: 'Overlapping children must not receive group opacity twice.' },
  { at: [8, 56], rgba: [255, 0, 255, 255], why: 'White mask preserves layer pixels.' },
  { at: [28, 56], rgba: [255, 255, 255, 255], why: 'Black mask removes layer pixels.' },
  { at: [60, 60], rgba: [255, 128, 0, 255], why: 'Clipped orange covers the opaque circle.' },
  { at: [46, 46], rgba: [255, 255, 255, 255], why: 'Clipped pixels outside the base remain transparent.' },
  { at: [100, 8], rgba: [255, 0, 0, 255], why: 'Magenta multiplied by yellow produces red.' },
];
const ctx = result.canvas.getContext('2d');
for (const p of probes) {
  const got = [...ctx.getImageData(...p.at, 1, 1).data];
  if (got.some((v, i) => Math.abs(v - p.rgba[i]) > 3)) throw new Error(`${p.why} Reference differs: ${got}`);
}
fs.writeFileSync(path.join(__dirname, 'expected.json'), JSON.stringify({
  demo: { width: W, height: H, layerNodes: demo.count, bytes: demo.bytes },
  compositing: { width: 128, height: 96, layerNodes: result.count, tolerance: 3, probes,
    structure: ['hidden blue square is present and hidden', 'empty group is present without pixels', 'brightness adjustment is present without pixels', 'magenta with left half mask has mask', 'clipped orange has clipping=true'] },
}, null, 2) + '\n');
fs.writeFileSync(path.join(__dirname, 'invalid.psd'), Buffer.from('not a photoshop document'));
console.log(JSON.stringify({ demo: { nodes: demo.count, bytes: demo.bytes }, fixture: { nodes: result.count, bytes: result.bytes }, probes: probes.length }));
