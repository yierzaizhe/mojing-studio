/* PSD parsing and rasterization run in this worker; no document is uploaded. */
'use strict';

(() => {
  const MAX_FILE_BYTES = 1024 * 1024 * 1024;
  const MAX_DECODE_PIXELS = 120000000;
  const MAX_DECODE_BYTES = 640 * 1024 * 1024;
  const MAX_EXPORT_PIXELS = 64000000;
  const CACHE_BYTES = 48 * 1024 * 1024;
  const MAX_GROUP_BYTES = 256 * 1024 * 1024;
  const MAX_NODES = 20000;
  const MAX_DEPTH = 80;
  const names = { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };
  const blends = {
    normal: 'source-over', 'pass through': 'source-over', multiply: 'multiply',
    screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
    'color dodge': 'color-dodge', 'color burn': 'color-burn',
    'hard light': 'hard-light', 'soft light': 'soft-light', difference: 'difference',
    exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color',
    luminosity: 'luminosity', 'linear dodge': 'lighter',
  };
  let psd;
  let documentName = '';
  let nodes = new Map();
  let roots = [];
  let initialHidden = new Set();
  let cache = new Map();
  let cacheBytes = 0;
  let baseWarnings = [];
  let compositeWarnings = [];
  let queue = Promise.resolve();
  const hitAlphaCache = new Map();

  agPsd.initializeCanvas((w, h) => new OffscreenCanvas(w, h), (w, h) => new ImageData(w, h));

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
  const cleanWarnings = values => [...new Set(values)].filter(Boolean);
  const rect = (x, y, w, h) => ({ x, y, w, h });
  const intersects = (a, b) => {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.w, b.x + b.w), bottom = Math.min(a.y + a.h, b.y + b.h);
    return right > x && bottom > y ? rect(x, y, right - x, bottom - y) : undefined;
  };
  const union = (a, b) => {
    if (!a || !a.w || !a.h) return b;
    if (!b || !b.w || !b.h) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return rect(x, y, Math.max(a.x + a.w, b.x + b.w) - x, Math.max(a.y + a.h, b.y + b.h) - y);
  };
  const canvas = (w, h) => {
    w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h));
    if (w > 32767 || h > 32767 || w * h > MAX_EXPORT_PIXELS) {
      throw new Error('预览或导出画布过大，请缩小预览尺寸或选择较小的图层。');
    }
    return new OffscreenCanvas(w, h);
  };
  const context = surface => {
    const ctx = surface.getContext('2d');
    if (!ctx) throw new Error('浏览器无法创建画布，请使用最新版 Chrome 或 Edge。');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return ctx;
  };
  const release = surface => { if (surface) { surface.width = 1; surface.height = 1; } };
  const warn = (state, message) => state.warnings.add(message);

  function clearCache() {
    for (const item of cache.values()) item.bitmap.close();
    cache.clear(); cacheBytes = 0;
  }
  function cached(key, pin = false) {
    const item = cache.get(key);
    if (!item) return undefined;
    cache.delete(key); cache.set(key, item);
    if (pin) item.pins++;
    return item.bitmap;
  }
  function unpin(key) {
    const item = cache.get(key);
    if (item) item.pins = Math.max(0, item.pins - 1);
  }
  function storeBitmap(key, bitmap, pin = false) {
    const bytes = bitmap.width * bitmap.height * 4;
    // Every retained image is a scaled preview, never the decoded native pixels.
    if (bytes > CACHE_BYTES) return false;
    while (cache.size && (cacheBytes + bytes > CACHE_BYTES || cache.size >= 120)) {
      // A clipping base may stay in use while later layers populate the cache.
      // Do not close a bitmap until its current rendering scope releases it.
      const candidate = [...cache.entries()].find(([, item]) => !item.pins);
      if (!candidate) return false;
      const [oldKey, item] = candidate;
      item.bitmap.close(); cache.delete(oldKey); cacheBytes -= item.bytes;
    }
    cache.set(key, { bitmap, bytes, pins: pin ? 1 : 0 }); cacheBytes += bytes;
    return true;
  }

  function assertDecode(w, h, label) {
    const bytesPerPixel = (psd.bitsPerChannel > 8 ? psd.bitsPerChannel / 8 : 1) * (psd.colorMode === 4 ? 9 : 4);
    if (!Number.isFinite(w * h) || w <= 0 || h <= 0) throw new Error(`${label}没有可预览的像素。`);
    if (w * h > MAX_DECODE_PIXELS || w * h * bytesPerPixel > MAX_DECODE_BYTES) {
      throw new Error(`${label}的原始像素超过本工具的内存预算；图层结构仍可查看，请选择较小的图层。`);
    }
  }
  function hasPixels(layer) {
    if (layer.adjustment || Array.isArray(layer.children)) return false;
    return !!(layer.rawData?.channels?.some(c => c.id >= 0 && c.data?.byteLength) && layer.right > layer.left && layer.bottom > layer.top);
  }
  function layerType(layer) {
    if (Array.isArray(layer.children)) return 'group';
    if (layer.text) return 'text';
    if (layer.placedLayer) return 'smart';
    if (layer.adjustment) return 'adjustment';
    if (layer.vectorFill || layer.vectorMask || layer.vectorStroke) return 'shape';
    return 'pixel';
  }
  function vectorBounds(layer) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const path of layer.vectorMask?.paths || []) for (const knot of path.knots || []) {
      for (let i = 0; i < 6; i += 2) {
        left = Math.min(left, knot.points[i]); right = Math.max(right, knot.points[i]);
        top = Math.min(top, knot.points[i + 1]); bottom = Math.max(bottom, knot.points[i + 1]);
      }
    }
    if (!Number.isFinite(left)) return undefined;
    const pad = Math.max(0, Number(layer.vectorStroke?.lineWidth?.value) || 0);
    left = Math.floor(left - pad); top = Math.floor(top - pad);
    return rect(left, top, Math.ceil(right + pad) - left, Math.ceil(bottom + pad) - top);
  }
  function inspect(layers, parent, depth = 0) {
    if (depth > MAX_DEPTH) throw new Error('PSD 分组嵌套过深，无法安全展开。');
    return (layers || []).map(layer => {
      if (nodes.size >= MAX_NODES) throw new Error('PSD 图层数量超过 20000，无法安全展开。');
      const id = `layer-${nodes.size + 1}`;
      const type = layerType(layer);
      const node = { id, layer, parent, children: [], bounds: undefined };
      nodes.set(id, node);
      if (layer.hidden) initialHidden.add(id);
      if (type === 'group') node.children = inspect(layer.children, node, depth + 1);
      let bounds = rect(layer.left || 0, layer.top || 0, Math.max(0, (layer.right || 0) - (layer.left || 0)), Math.max(0, (layer.bottom || 0) - (layer.top || 0)));
      if (type === 'group') for (const child of node.children) bounds = union(bounds, child.bounds);
      if (!bounds?.w || !bounds?.h) bounds = vectorBounds(layer) || bounds;
      if ((!bounds?.w || !bounds?.h) && layer.vectorFill && !layer.vectorMask) bounds = rect(0, 0, psd.width, psd.height);
      node.bounds = bounds || rect(0, 0, 0, 0);
      const pixelCache = hasPixels(layer);
      const fill = layer.vectorFill;
      const supportedFill = fill?.type === 'color' ? !!rgb(fill.color) : fill?.type === 'solid' && !!fill.colorStops?.length;
      let previewable = true, previewReason = '';
      if (type === 'adjustment') {
        previewable = false;
        previewReason = '调整图层用于影响下方画面，没有可单独预览的图片；可查看其类型与属性。';
      } else if (!node.bounds.w || !node.bounds.h) {
        previewable = false;
        previewReason = '此图层或分组没有像素范围；可查看其名称与属性。';
      } else if (type === 'group' ? !node.children.some(child => child.meta.previewable) : !pixelCache && !supportedFill) {
        previewable = false;
        previewReason = type === 'group'
          ? '此分组没有可独立还原的图层内容；可展开查看结构与属性。'
          : '此图层未保存独立像素缓存，或其填充样式暂不支持；可查看名称与属性。';
      }
      const font = layer.text?.style?.font?.name || layer.text?.styleRuns?.find(r => r.style?.font?.name)?.style.font.name || '';
      node.meta = {
        id, name: layer.name || '未命名图层', type,
        left: node.bounds.x, top: node.bounds.y,
        right: node.bounds.x + node.bounds.w, bottom: node.bounds.y + node.bounds.h,
        width: node.bounds.w, height: node.bounds.h,
        hidden: !!layer.hidden, opacity: layer.opacity === undefined ? 1 : clamp(layer.opacity, 0, 1),
        blendMode: layer.blendMode || 'normal', clipping: !!layer.clipping,
        hasPixels: pixelCache, previewable, previewReason,
        hasMask: !!(layer.mask || layer.realMask || layer.vectorMask),
        hasEffects: !!(layer.effects && !layer.effects.disabled),
        text: layer.text?.text?.slice(0, 500000) || '', font,
        adjustmentType: layer.adjustment?.type || '',
        ...(type === 'group' ? { children: node.children.map(child => child.meta) } : {}),
      };
      return node;
    });
  }

  async function openFile(message) {
    clearCache(); hitAlphaCache.clear(); psd = undefined; nodes = new Map(); roots = []; initialHidden = new Set();
    const file = message.file;
    if (!file && !(message.buffer instanceof ArrayBuffer)) throw new Error('请选择一个 PSD 或 PSB 文件。');
    if ((file ? file.size : message.buffer.byteLength) > MAX_FILE_BYTES) throw new Error('文件超过 1 GB，请使用 Photoshop 或选择较小的 PSD。');
    const buffer = file ? await file.arrayBuffer() : message.buffer;
    if (buffer.byteLength < 26 || new DataView(buffer).getUint32(0) !== 0x38425053) {
      throw new Error('文件不是有效的 Photoshop PSD / PSB 源文件。');
    }
    psd = agPsd.readPsd(buffer, {
      useRawData: true, useRawThumbnail: true, skipLinkedFilesData: true,
      skipThumbnail: true, totalMemoryLimit: 768 * 1024 * 1024,
      imageResourcesWhitelist: ['resolutionInfo', 'versionInfo', 'iccProfile'],
    });
    documentName = file?.name || message.name || '未命名.psd';
    roots = inspect(psd.children || []);
    baseWarnings = [];
    compositeWarnings = [];
    const all = [...nodes.values()];
    const count = type => all.filter(n => n.meta.type === type).length;
    const effectCount = all.filter(n => n.meta.hasEffects).length;
    if (psd.colorMode === 4) baseWarnings.push('CMYK 已近似转换为 RGB 预览；未应用文件内嵌 ICC 配置，颜色可能与 Photoshop 不同。');
    if (psd.bitsPerChannel > 8) baseWarnings.push(`${psd.bitsPerChannel} 位图像已转换为 8 位屏幕预览，亮度和颜色可能存在差异。`);
    if (psd.width * psd.height > 32000000) baseWarnings.push('此文件画布较大，预览会按需解码并缩小显示；切换图层可能需要稍候。');
    if (effectCount) compositeWarnings.push(`${effectCount} 个图层带有图层样式；图层重合成尚未重建描边、阴影等效果，原始预览保留文件保存的画面。`);
    if (count('adjustment')) compositeWarnings.push(`${count('adjustment')} 个调整图层保留在图层树中，其调整效果尚未参与图层重合成。`);
    if (count('smart')) compositeWarnings.push('智能对象使用 PSD 内保存的像素缓存；未打开嵌套文件或读取外部链接素材。');
    if (all.some(n => n.layer.blendingRanges || n.layer.fillOpacity !== undefined && n.layer.fillOpacity !== 1)) {
      compositeWarnings.push('部分高级混合选项（例如混合颜色带、填充透明度）未完整还原。');
    }
    const noPixels = all.filter(n => !n.meta.hasPixels && ['text', 'smart', 'pixel'].includes(n.meta.type));
    if (noPixels.length) compositeWarnings.push(`${noPixels.length} 个图层没有独立像素缓存，仍可查看名称和属性；无法单独还原其画面。`);
    if (!nodes.size) baseWarnings.push('此文件没有独立图层记录，只能查看保存的合成图。');
    return {
      doc: {
        name: documentName, width: psd.width, height: psd.height,
        bitsPerChannel: psd.bitsPerChannel, colorMode: psd.colorMode,
        colorModeName: names[psd.colorMode] || String(psd.colorMode),
        children: roots.map(n => n.meta), count: nodes.size,
        leafCount: all.filter(n => n.meta.type !== 'group').length,
        hasComposite: !!psd.rawCompositeData?.byteLength && psd.imageResources?.versionInfo?.hasRealMergedData !== false,
        warnings: cleanWarnings([...baseWarnings, ...compositeWarnings]),
      },
    };
  }

  function asImageData(pixelData) {
    if (pixelData instanceof ImageData) return pixelData;
    const src = pixelData.data;
    if (src instanceof Uint8ClampedArray) return new ImageData(src, pixelData.width, pixelData.height);
    const dst = new Uint8ClampedArray(pixelData.width * pixelData.height * 4);
    if (src instanceof Float32Array) {
      for (let i = 0; i < src.length; i++) dst[i] = Math.round((i % 4 === 3 ? clamp(src[i], 0, 1) : Math.pow(Math.max(0, src[i]), 1 / 2.2)) * 255);
    } else {
      const shift = src instanceof Uint16Array ? 8 : 0;
      for (let i = 0; i < src.length; i++) dst[i] = src[i] >>> shift;
    }
    return new ImageData(dst, pixelData.width, pixelData.height);
  }
  async function cropPixels(pixelData, nativeRect, area, width, height) {
    return createImageBitmap(asImageData(pixelData),
      Math.round(area.x - nativeRect.x), Math.round(area.y - nativeRect.y),
      Math.round(area.w), Math.round(area.h),
      { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  }
  function path2d(path) {
    const result = new Path2D();
    const knots = path.knots || [];
    if (!knots.length) return result;
    const first = knots[0].points;
    result.moveTo(first[2], first[3]);
    for (let i = 1; i < knots.length; i++) {
      const prev = knots[i - 1].points, next = knots[i].points;
      result.bezierCurveTo(prev[4], prev[5], next[0], next[1], next[2], next[3]);
    }
    if (!path.open) {
      const last = knots[knots.length - 1].points;
      result.bezierCurveTo(last[4], last[5], first[0], first[1], first[2], first[3]);
      result.closePath();
    }
    return result;
  }
  function vectorAlpha(node, area, width, height, state) {
    const vector = node.layer.vectorMask;
    if (!vector || vector.disable || !vector.paths?.length) return undefined;
    const mask = canvas(width, height), ctx = context(mask);
    if (vector.fillStartsWithAllPixels) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); }
    ctx.setTransform(width / area.w, 0, 0, height / area.h, -area.x * width / area.w, -area.y * height / area.h);
    ctx.fillStyle = '#fff';
    for (const path of vector.paths) {
      ctx.globalCompositeOperation = ({ subtract: 'destination-out', intersect: 'destination-in', exclude: 'xor' })[path.operation] || 'source-over';
      ctx.fill(path2d(path), path.fillRule === 'even-odd' ? 'evenodd' : 'nonzero');
    }
    ctx.resetTransform();
    if (vector.invert) { ctx.globalCompositeOperation = 'xor'; ctx.fillRect(0, 0, width, height); }
    if (node.layer.mask?.vectorMaskFeather || node.layer.mask?.vectorMaskDensity !== undefined && node.layer.mask.vectorMaskDensity !== 1) {
      warn(state, '部分矢量蒙版的羽化或浓度尚未完整还原。');
    }
    return mask;
  }
  function rgb(color) {
    if (!color) return undefined;
    if (Number.isFinite(color.r)) return `rgb(${clamp(color.r, 0, 255)},${clamp(color.g, 0, 255)},${clamp(color.b, 0, 255)})`;
    if (Number.isFinite(color.k)) { const v = 255 * (1 - color.k / 100); return `rgb(${v},${v},${v})`; }
    return undefined;
  }
  function shapeFill(node, area, target, state) {
    const fill = node.layer.vectorFill;
    if (!fill || fill.type === 'pattern') return false;
    const ctx = context(target);
    if (fill.type === 'color') {
      const value = rgb(fill.color);
      if (!value) return false;
      ctx.fillStyle = value;
    } else if (fill.type === 'solid' && fill.colorStops?.length) {
      const bounds = node.bounds;
      const cx = bounds.x + bounds.w / 2, cy = bounds.y + bounds.h / 2;
      const angle = -(fill.angle || 0) * Math.PI / 180;
      const scale = (fill.scale === undefined ? 100 : fill.scale) / 100;
      const dx = Math.cos(angle), dy = Math.sin(angle);
      const length = (Math.abs(bounds.w * dx) + Math.abs(bounds.h * dy)) * scale;
      const sx = target.width / area.w, sy = target.height / area.h;
      let gradient;
      if (fill.style === 'radial') gradient = ctx.createRadialGradient((cx - area.x) * sx, (cy - area.y) * sy, 0, (cx - area.x) * sx, (cy - area.y) * sy, Math.max(1, length * Math.max(sx, sy) / 2));
      else {
        if (fill.style && fill.style !== 'linear') warn(state, '无像素缓存的复杂渐变形状使用线性近似预览。');
        gradient = ctx.createLinearGradient((cx - dx * length / 2 - area.x) * sx, (cy - dy * length / 2 - area.y) * sy, (cx + dx * length / 2 - area.x) * sx, (cy + dy * length / 2 - area.y) * sy);
      }
      for (const stop of fill.colorStops) gradient.addColorStop(clamp(fill.reverse ? 1 - stop.location : stop.location, 0, 1), rgb(stop.color) || '#000');
      ctx.fillStyle = gradient;
      if (fill.opacityStops?.some(s => s.opacity !== 1)) warn(state, '无像素缓存的渐变透明度尚未完整还原。');
    } else return false;
    ctx.fillRect(0, 0, target.width, target.height);
    const vector = vectorAlpha(node, area, target.width, target.height, state);
    if (vector) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(vector, 0, 0); ctx.globalCompositeOperation = 'source-over'; release(vector); }
    if (node.layer.vectorStroke?.strokeEnabled) warn(state, '无像素缓存的矢量描边尚未重建。');
    return true;
  }

  async function applyRasterMask(node, area, target, state, real = false) {
    const info = real ? node.layer.realMask : node.layer.mask;
    if (!info || info.disabled) return;
    const w = Math.max(0, (info.right || 0) - (info.left || 0)), h = Math.max(0, (info.bottom || 0) - (info.top || 0));
    if (!w || !h) return;
    assertDecode(w, h, '图层蒙版');
    const data = real ? agPsd.getLayerRealMaskImageData(node.layer) : agPsd.getLayerMaskImageData(node.layer);
    if (!data) return;
    const image = asImageData(data);
    const density = info.userMaskDensity === undefined ? 1 : clamp(info.userMaskDensity, 0, 1);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i + 3] = Math.round(255 * (1 - density) + image.data[i] * density);
      image.data[i] = image.data[i + 1] = image.data[i + 2] = 255;
    }
    const mask = canvas(target.width, target.height), ctx = context(mask);
    const alpha = (1 - density) + (info.defaultColor === 255 ? density : 0);
    ctx.fillStyle = `rgba(255,255,255,${alpha})`; ctx.fillRect(0, 0, mask.width, mask.height);
    const maskRect = rect(info.left || 0, info.top || 0, w, h);
    const overlap = intersects(maskRect, area);
    if (overlap) {
      const sx = mask.width / area.w, sy = mask.height / area.h;
      const bitmap = await cropPixels(image, maskRect, overlap, Math.max(1, Math.round(overlap.w * sx)), Math.max(1, Math.round(overlap.h * sy)));
      const x = (overlap.x - area.x) * sx, y = (overlap.y - area.y) * sy;
      ctx.clearRect(x, y, overlap.w * sx, overlap.h * sy);
      ctx.drawImage(bitmap, x, y, overlap.w * sx, overlap.h * sy); bitmap.close();
    }
    const feather = Math.max(0, info.userMaskFeather || 0) * Math.max(mask.width / area.w, mask.height / area.h);
    const targetCtx = context(target);
    targetCtx.save(); targetCtx.globalCompositeOperation = 'destination-in';
    if (feather > 0 && 'filter' in targetCtx) targetCtx.filter = `blur(${Math.min(100, feather)}px)`;
    targetCtx.drawImage(mask, 0, 0); targetCtx.restore(); release(mask);
    if (feather > 0) warn(state, '蒙版羽化使用浏览器模糊近似，与 Photoshop 可能存在差异。');
  }
  async function pixelBitmap(node, area, width, height, state) {
    const key = `pixel:${node.id}:${area.x},${area.y},${area.w},${area.h}:${width},${height}`;
    const hit = cached(key, true);
    if (hit) return { bitmap: hit, retained: true, key };
    const surface = canvas(width, height);
    try {
      const ctx = context(surface);
      if (node.meta.hasPixels) {
        const layer = node.layer;
        const nativeRect = rect(layer.left || 0, layer.top || 0, layer.right - layer.left, layer.bottom - layer.top);
        assertDecode(nativeRect.w, nativeRect.h, `图层“${node.meta.name}”`);
        let pixels = agPsd.getLayerImageData(layer);
        if (!pixels) return undefined;
        const bitmap = await cropPixels(pixels, nativeRect, area, width, height);
        pixels = undefined;
        try { ctx.drawImage(bitmap, 0, 0); } finally { bitmap.close(); }
        // Native shape caches already contain their vector appearance. Raster layers
        // with a separate vector mask still require that mask to be applied.
        if (layer.vectorMask && !layer.vectorFill && !layer.mask?.fromVectorData) {
          const vector = vectorAlpha(node, area, width, height, state);
          if (vector) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(vector, 0, 0); ctx.globalCompositeOperation = 'source-over'; release(vector); }
        }
      } else if (!shapeFill(node, area, surface, state)) {
        return undefined;
      }
      await applyRasterMask(node, area, surface, state);
      await applyRasterMask(node, area, surface, state, true);
      const bitmap = await createImageBitmap(surface);
      const retained = storeBitmap(key, bitmap, true);
      return { bitmap, retained, key };
    } finally { release(surface); }
  }

  function relevant(node, state) {
    if (!state.solo) return true;
    if (node === state.solo) return true;
    for (let p = node.parent; p; p = p.parent) if (p === state.solo) return true;
    for (let p = state.solo.parent; p; p = p.parent) if (p === node) return true;
    return false;
  }
  function visible(node, state, force) {
    if (!relevant(node, state)) return false;
    if (force || state.solo && (node === state.solo || isAncestor(node, state.solo))) return true;
    return !state.hidden.has(node.id);
  }
  function isAncestor(ancestor, node) {
    for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true;
    return false;
  }
  function opFor(node, state) {
    const mode = node.layer.blendMode || 'normal';
    if (blends[mode]) return blends[mode];
    warn(state, `混合模式“${mode}”尚未支持，相关图层按正常模式预览。`);
    return 'source-over';
  }
  function drawSurface(target, source, state, alpha = 1, blend = 'source-over') {
    const ctx = context(target.canvas);
    ctx.save(); ctx.globalAlpha = clamp(alpha, 0, 1); ctx.globalCompositeOperation = blend;
    ctx.drawImage(source.canvas,
      (source.area.x - target.area.x) * state.sx, (source.area.y - target.area.y) * state.sy,
      source.area.w * state.sx, source.area.h * state.sy);
    ctx.restore();
  }
  async function nodeSurface(node, state, force = false, depth = 0) {
    if (depth > 24) throw new Error('分组嵌套过深，已停止图层渲染以保护内存。');
    if (!visible(node, state, force)) return undefined;
    if (node.meta.type === 'adjustment') return undefined;
    const area = intersects(node.bounds, state.area);
    if (!area) return undefined;
    const width = Math.max(1, Math.round(area.w * state.sx)), height = Math.max(1, Math.round(area.h * state.sy));
    if (node.meta.type !== 'group') {
      const raster = await pixelBitmap(node, area, width, height, state);
      if (!raster) { warn(state, `图层“${node.meta.name}”没有可独立还原的像素缓存。`); return undefined; }
      return { canvas: raster.bitmap, area, dispose: () => { if (raster.retained) unpin(raster.key); else raster.bitmap.close(); } };
    }
    const groupBytes = width * height * 4;
    if (state.groupBytes + groupBytes > MAX_GROUP_BYTES) {
      const error = new Error('分组所需的临时画布超过内存预算，请选择较小的图层或缩小预览。');
      error.memoryBudget = true;
      throw error;
    }
    state.groupBytes += groupBytes;
    const target = { canvas: canvas(width, height), area };
    try {
      await drawSiblings(node.children, target, state, depth + 1);
      await applyRasterMask(node, area, target.canvas, state);
      await applyRasterMask(node, area, target.canvas, state, true);
      const vector = vectorAlpha(node, area, width, height, state);
      if (vector) {
        const ctx = context(target.canvas); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(vector, 0, 0); ctx.globalCompositeOperation = 'source-over'; release(vector);
      }
      if (node.layer.blendMode === 'pass through' && node.meta.opacity < 1) warn(state, '带透明度的穿透分组使用隔离组近似合成。');
      target.dispose = () => { release(target.canvas); state.groupBytes -= groupBytes; };
      return target;
    } catch (error) { release(target.canvas); state.groupBytes -= groupBytes; throw error; }
  }
  async function safelySurface(node, state, depth) {
    try { return await nodeSurface(node, state, false, depth); }
    catch (error) {
      if (error.memoryBudget && state.exportMode) throw error;
      warn(state, `${node.meta.name}：${error.message || error}`); return undefined;
    }
  }
  async function clippingChain(base, clips, state, depth) {
    const active = clips.filter(node => visible(node, state, false));
    if (!active.length) return undefined;
    const bytes = base.canvas.width * base.canvas.height * 4;
    if (state.groupBytes + bytes > MAX_GROUP_BYTES) {
      const error = new Error('剪贴图层所需的临时画布超过内存预算，请选择较小的图层或缩小预览。');
      error.memoryBudget = true;
      throw error;
    }
    const target = { canvas: canvas(base.canvas.width, base.canvas.height), area: base.area };
    state.groupBytes += bytes;
    try {
      const ctx = context(target.canvas);
      ctx.drawImage(base.canvas, 0, 0);
      const normalOnly = active.every(node => !node.layer.blendMode || ['normal', 'pass through'].includes(node.layer.blendMode));
      if (!normalOnly) {
        // Blend modes must see the unpremultiplied base color as an opaque
        // backdrop. Applying a blend with source-over on a translucent base
        // would mix the backdrop alpha into the color calculation as well.
        const pixels = ctx.getImageData(0, 0, target.canvas.width, target.canvas.height);
        for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;
        ctx.putImageData(pixels, 0, 0);
      }
      for (const node of active) {
        const clipped = await safelySurface(node, state, depth);
        if (!clipped) continue;
        try {
          // source-atop changes RGB while preserving the base shape alpha,
          // including partially transparent and antialiased edge pixels.
          drawSurface(target, clipped, state, node.meta.opacity, normalOnly ? 'source-atop' : opFor(node, state));
        } finally { clipped.dispose(); }
      }
      if (!normalOnly) {
        ctx.save(); ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(base.canvas, 0, 0); ctx.restore();
      }
      target.dispose = () => { release(target.canvas); state.groupBytes -= bytes; };
      return target;
    } catch (error) {
      release(target.canvas); state.groupBytes -= bytes; throw error;
    }
  }
  async function drawSiblings(children, target, state, depth = 0) {
    if (depth > MAX_DEPTH) throw new Error('分组嵌套过深，已停止图层渲染。');
    for (let index = 0; index < children.length; index++) {
      const node = children[index];
      const clips = [];
      while (index + 1 < children.length && children[index + 1].meta.clipping) clips.push(children[++index]);
      if (!visible(node, state, false)) continue;
      if (node.meta.clipping && !state.solo) {
        warn(state, '检测到没有基底的剪贴图层，已跳过该图层。');
        continue;
      }
      const passThrough = node.meta.type === 'group' && node.layer.blendMode === 'pass through' && node.meta.opacity === 1 && !node.meta.hasMask && !node.meta.hasEffects && !clips.length;
      if (passThrough) { await drawSiblings(node.children, target, state, depth + 1); continue; }
      const surface = await safelySurface(node, state, depth);
      if (!surface) continue;
      try {
        const chain = await clippingChain(surface, clips, state, depth);
        try {
          // The base's own layer opacity and blend mode apply once to the
          // completed clipping group, never separately to every clipped layer.
          drawSurface(target, chain || surface, state, node.meta.opacity, opFor(node, state));
        } finally { chain?.dispose(); }
      } finally { surface.dispose(); }
    }
  }

  function renderState(message, exportMode) {
    if (!psd) throw new Error('请先打开一个 PSD 文件。');
    let selected;
    if (message.mode === 'layer') {
      selected = nodes.get(message.layerId);
      if (!selected) throw new Error('请先选择一个图层。');
      if (!selected.meta.previewable) throw new Error(selected.meta.previewReason);
    }
    const area = selected ? selected.bounds : rect(0, 0, psd.width, psd.height);
    if (!area.w || !area.h) throw new Error('该图层或空分组没有可预览的像素范围。');
    const maxSize = exportMode ? exportLongEdge(message) || Infinity : clamp(message.maxSize || 2000, 16, 4096);
    const ratio = Math.min(1, maxSize / Math.max(area.w, area.h));
    const width = Math.max(1, Math.round(area.w * ratio)), height = Math.max(1, Math.round(area.h * ratio));
    if (exportMode && (width * height > MAX_EXPORT_PIXELS || width > 32767 || height > 32767)) {
      throw new Error('导出图像超过 6400 万像素或浏览器尺寸上限。请选择缩小导出，或导出较小的单个图层。');
    }
    return {
      selected, area, width, height, sx: width / area.w, sy: height / area.h,
      groupBytes: 0, exportMode,
      hidden: Array.isArray(message.hiddenIds) ? new Set(message.hiddenIds) : initialHidden,
      solo: selected ? undefined : nodes.get(message.soloId), warnings: new Set(baseWarnings),
    };
  }
  async function originalPreview(state) {
    if (!psd.rawCompositeData?.byteLength) throw new Error('文件没有保存可读取的合成图。');
    if (psd.imageResources?.versionInfo?.hasRealMergedData === false) throw new Error('文件未保存兼容合成画面。');
    const key = `original:${state.width},${state.height}`;
    const hit = cached(key);
    if (hit) return { bitmap: hit, retained: true };
    assertDecode(psd.width, psd.height, '原始合成图');
    let pixels = agPsd.getCompositeImageData(psd);
    if (!pixels) throw new Error('文件没有保存可读取的合成图。');
    const bitmap = await cropPixels(pixels, rect(0, 0, psd.width, psd.height), state.area, state.width, state.height);
    pixels = undefined;
    return { bitmap, retained: storeBitmap(key, bitmap) };
  }
  async function buildRender(message, exportMode = false) {
    const mode = message.mode || 'original';
    const state = renderState({ ...message, mode }, exportMode);
    const output = canvas(state.width, state.height);
    let source = mode;
    try {
      if (mode === 'original') {
        try {
          const original = await originalPreview(state);
          context(output).drawImage(original.bitmap, 0, 0);
          if (!original.retained) original.bitmap.close();
          return { output, state, source };
        } catch (error) {
          source = 'composite';
          warn(state, `无法读取原始合成图，已改用图层重合成。${error.message || ''}`);
        }
      }
      for (const warning of compositeWarnings) warn(state, warning);
      if (mode === 'layer') {
        const surface = await nodeSurface(state.selected, state, true);
        if (!surface) throw new Error('该图层没有可独立预览的像素缓存，可查看其名称、类型和属性。');
        try { drawSurface({ canvas: output, area: state.area }, surface, state, 1); }
        finally { surface.dispose(); }
      } else {
        if (!roots.length) throw new Error('此文件没有独立图层，无法进行图层重合成。请使用原始预览。');
        await drawSiblings(roots, { canvas: output, area: state.area }, state);
      }
      return { output, state, source };
    } catch (error) { release(output); throw error; }
  }
  async function render(message) {
    const { output, state, source } = await buildRender(message);
    let bitmap;
    try { bitmap = await createImageBitmap(output); }
    finally { release(output); }
    return {
      bitmap, width: bitmap.width, height: bitmap.height,
      documentWidth: state.area.w, documentHeight: state.area.h,
      originX: state.area.x, originY: state.area.y,
      warnings: cleanWarnings([...state.warnings]), source,
    };
  }
  async function thumbnail(message) {
    const node = nodes.get(message.layerId);
    if (!node) throw new Error('图层不存在。');
    if (!node.meta.previewable) return { empty: true, layerId: node.id, reason: node.meta.previewReason };
    const key = `thumb:${node.id}`;
    const hit = cached(key);
    if (hit) return { bitmap: await createImageBitmap(hit), layerId: node.id, width: hit.width, height: hit.height };
    // Folders use their type icon. Decoding every child merely for a folder
    // thumbnail would defeat lazy loading on documents with hundreds of layers.
    if (node.meta.type === 'group') return { empty: true, layerId: node.id };
    if (node.meta.hasPixels && node.bounds.w * node.bounds.h > 16000000) return { empty: true, layerId: node.id, reason: 'large-layer' };
    const state = renderState({ mode: 'layer', layerId: node.id, maxSize: 48 }, false);
    const surface = await nodeSurface(node, state, true);
    if (!surface) return { empty: true, layerId: node.id };
    let bitmap;
    try { bitmap = await createImageBitmap(surface.canvas); }
    finally { surface.dispose(); }
    try {
      const copy = await createImageBitmap(bitmap);
      if (storeBitmap(key, bitmap)) bitmap = undefined;
      return { bitmap: copy, layerId: node.id, width: copy.width, height: copy.height };
    } finally { bitmap?.close(); }
  }
  function exportLongEdge(message) {
    const value = Number(message.exportSize);
    return Number.isFinite(value) && value > 0 ? clamp(Math.round(value), 1, 32767) : 0;
  }
  function exportDimensions(area, message) {
    const longEdge = exportLongEdge(message);
    const ratio = Math.min(1, (longEdge || Infinity) / Math.max(area.w, area.h));
    return { width: Math.max(1, Math.round(area.w * ratio)), height: Math.max(1, Math.round(area.h * ratio)) };
  }
  function exportColor(value, fallback) {
    const color = value === undefined ? fallback : String(value);
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) throw new Error('请选择有效的十六进制颜色。');
    return color.toLowerCase();
  }
  function exportOptions(message) {
    const format = message.format === undefined ? 'png' : message.format === 'jpg' ? 'jpeg' : message.format;
    if (!['png', 'jpeg'].includes(format)) throw new Error('请选择 PNG 或 JPG 导出格式。');
    const value = message.watermark || {};
    const enabled = !!value.enabled;
    const text = Array.from(String(value.text || '').replace(/[\r\n\t\u2028\u2029]+/g, ' ').trim()).slice(0, 120).join('');
    if (enabled && !text) throw new Error('请输入水印文字，或关闭文字水印。');
    const positions = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center', 'tile'];
    return {
      format, mime: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      quality: message.quality === undefined ? .92 : clamp(message.quality, .6, 1),
      background: exportColor(message.background, '#ffffff'),
      watermark: {
        enabled, text, position: positions.includes(value.position) ? value.position : 'bottom-right',
        opacity: value.opacity === undefined ? .25 : clamp(value.opacity, 0, 1),
        size: value.size === undefined ? 5 : clamp(value.size, 1, 15),
        color: exportColor(value.color, '#ffffff'),
      },
    };
  }
  function watermarkOutline(color) {
    const expanded = color.length === 4 ? '#' + [...color.slice(1)].map(c => c + c).join('') : color;
    const value = parseInt(expanded.slice(1), 16);
    const lightness = ((value >> 16) * .2126 + ((value >> 8) & 255) * .7152 + (value & 255) * .0722) / 255;
    return lightness > .5 ? 'rgba(0,0,0,.42)' : 'rgba(255,255,255,.42)';
  }
  async function decorateExport(output, dimensions, options) {
    // buildRender always returns a new canvas. Neither decoration below ever
    // writes into cached source bitmaps or the PSD's own decoded pixels.
    const ctx = context(output);
    if (options.format === 'jpeg') {
      ctx.save(); ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = options.background; ctx.fillRect(0, 0, output.width, output.height); ctx.restore();
    }
    const mark = options.watermark;
    if (!mark.enabled || mark.opacity === 0) return;
    // Worker FontFaceSet.ready can remain pending even for system fonts in
    // some Chromium/OffscreenCanvas contexts. A preview must not wait forever.
    if (self.fonts?.ready) {
      const ready = Promise.resolve(self.fonts.ready).catch(() => {});
      if (typeof setTimeout === 'function') await Promise.race([ready, new Promise(resolve => setTimeout(resolve, 180))]);
      else await ready;
    }
    const width = dimensions.width, height = dimensions.height;
    const shorter = Math.min(width, height), margin = shorter * .03;
    const tiled = mark.position === 'tile';
    let fontSize = Math.max(.1, shorter * mark.size / 100);
    const font = size => `600 ${size}px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.save();
    try {
      // Work in planned output coordinates in both the 900px preview and the
      // real export, so relative font size, spacing and placement stay equal.
      ctx.setTransform(output.width / width, 0, 0, output.height / height, 0, 0);
      ctx.font = font(fontSize);
      const maxWidth = Math.max(.1, tiled ? Math.min(width - 2 * margin, shorter * .9) : width - 2 * margin);
      const measured = ctx.measureText(mark.text).width;
      if (measured > maxWidth) { fontSize *= maxWidth / measured; ctx.font = font(fontSize); }
      const metrics = ctx.measureText(mark.text), textWidth = metrics.width;
      const ascent = metrics.actualBoundingBoxAscent || fontSize * .8;
      const descent = metrics.actualBoundingBoxDescent || fontSize * .2;
      ctx.globalAlpha = mark.opacity; ctx.fillStyle = mark.color; ctx.strokeStyle = watermarkOutline(mark.color);
      ctx.lineWidth = fontSize * .045; ctx.lineJoin = 'round';
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.shadowColor = 'rgba(0,0,0,.2)';
      // Canvas shadow lengths are device-space values, unlike the transformed
      // text and stroke, so scale them explicitly for the preview surface.
      ctx.shadowBlur = fontSize * .08 * Math.min(output.width / width, output.height / height);
      ctx.shadowOffsetY = fontSize * .025 * output.height / height;
      const draw = (x, y) => { ctx.strokeText(mark.text, x, y); ctx.fillText(mark.text, x, y); };
      if (tiled) {
        const angle = -25 * Math.PI / 180;
        const spanX = Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle));
        const spanY = Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle));
        let stepX = Math.max(textWidth + fontSize * 2.5, shorter * .24);
        let stepY = Math.max(fontSize * 3.7, shorter * .12);
        let columns = Math.ceil(spanX / stepX) + 2, rows = Math.ceil(spanY / stepY) + 2;
        // Bounded work also covers unusually thin, long canvases and tiny text.
        while (columns * rows > 2048) {
          const factor = Math.sqrt(columns * rows / 2048) * 1.02;
          stepX *= factor; stepY *= factor;
          columns = Math.ceil(spanX / stepX) + 2; rows = Math.ceil(spanY / stepY) + 2;
        }
        ctx.translate(width / 2, height / 2); ctx.rotate(angle);
        for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
          const x = (column - (columns - 1) / 2) * stepX + (row % 2 ? stepX / 2 : 0) - textWidth / 2;
          const y = (row - (rows - 1) / 2) * stepY + (ascent - descent) / 2;
          draw(x, y);
        }
      } else {
        const left = mark.position.endsWith('left'), top = mark.position.startsWith('top');
        const x = mark.position === 'center' ? (width - textWidth) / 2 : left ? margin : width - margin - textWidth;
        const y = mark.position === 'center' ? (height + ascent - descent) / 2 : top ? margin + ascent : height - margin - descent;
        draw(x, y);
      }
    } finally { ctx.restore(); }
  }
  async function exportImage(message) {
    const options = exportOptions(message);
    const { output, state } = await buildRender(message, true);
    try {
      const dimensions = { width: output.width, height: output.height };
      await decorateExport(output, dimensions, options);
      const blob = await output.convertToBlob({ type: options.mime, quality: options.quality });
      if (blob.type !== options.mime) throw new Error('此浏览器无法编码所选格式，请改用 PNG 或更新 Chrome / Edge。');
      return { blob, format: options.format, ...dimensions, warnings: cleanWarnings([...state.warnings]) };
    } finally { release(output); }
  }
  async function exportPreview(message) {
    const options = exportOptions(message);
    const previewSize = Math.min(clamp(message.maxSize || 900, 16, 2048), exportLongEdge(message) || Infinity);
    const { output, state } = await buildRender({ ...message, maxSize: previewSize }, false);
    try {
      const dimensions = exportDimensions(state.area, message);
      await decorateExport(output, dimensions, options);
      const canExport = dimensions.width * dimensions.height <= MAX_EXPORT_PIXELS && dimensions.width <= 32767 && dimensions.height <= 32767;
      if (!canExport) warn(state, '原尺寸超过导出上限，请选择缩小导出；水印预览仍可查看。');
      // For JPG, the preview also passes through the selected encoder quality
      // so its compression setting is visible instead of showing raw pixels.
      const bitmap = options.format === 'jpeg'
        ? await createImageBitmap(await output.convertToBlob({ type: options.mime, quality: options.quality }))
        : await createImageBitmap(output);
      return {
        bitmap, format: options.format, width: bitmap.width, height: bitmap.height,
        documentWidth: state.area.w, documentHeight: state.area.h,
        exportWidth: dimensions.width, exportHeight: dimensions.height, canExport,
        warnings: cleanWarnings([...state.warnings]),
      };
    } finally { release(output); }
  }

  async function applyRasterAdjustments(output, message) {
    if (message.adjustments === undefined) return;
    const filters = globalThis.LayerDeskFilters;
    if (!filters) throw new Error('图片滤镜模块尚未就绪，请重新打开工具。');
    if (filters.isIdentity(message.adjustments)) return;
    const ctx = context(output);
    const pixels = ctx.getImageData(0, 0, output.width, output.height);
    await filters.process(pixels, message.adjustments, {
      sourceWidth: message.sourceWidth ?? message.documentWidth ?? output.width,
      sourceHeight: message.sourceHeight ?? message.documentHeight ?? output.height,
    });
    ctx.putImageData(pixels, 0, 0);
  }

  async function adjustRaster(message) {
    const input = message.bitmap;
    let output;
    try {
      if (!input || typeof input.close !== 'function' || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1) {
        throw new Error('图片滤镜预览无效，请重新打开图片。');
      }
      output = canvas(input.width, input.height);
      context(output).drawImage(input, 0, 0);
      await applyRasterAdjustments(output, message);
      const bitmap = await createImageBitmap(output);
      return { bitmap, width: bitmap.width, height: bitmap.height, warnings: [] };
    } finally {
      try { input?.close?.(); } catch { /* This request owns its input. */ }
      release(output);
    }
  }

  async function rasterExport(message) {
    // SVGs are rasterized by the main thread's native SVG renderer. This
    // independent path only decorates a fresh copy, and never touches the PSD
    // document, its decoded data or its caches.
    const input = message.bitmap;
    let output;
    try {
      const validSize = value => Number.isSafeInteger(value) && value > 0;
      if (!input || typeof input.close !== 'function' || !validSize(input.width) || !validSize(input.height)) {
        throw new Error('SVG 栅格预览无效，请重新打开文件后再导出。');
      }
      if (input.width > 32767 || input.height > 32767 || input.width * input.height > MAX_EXPORT_PIXELS) {
        throw new Error('SVG 栅格图像超过内存预算，请选择缩小导出。');
      }
      const width = message.exportWidth === undefined ? input.width : Number(message.exportWidth);
      const height = message.exportHeight === undefined ? input.height : Number(message.exportHeight);
      if (!validSize(width) || !validSize(height)) throw new Error('SVG 导出尺寸无效。');
      const dimensions = { width, height };
      const canExport = width <= 32767 && height <= 32767 && width * height <= MAX_EXPORT_PIXELS;
      const preview = message.preview === true;
      if (!preview && !canExport) throw new Error('完整图片超过 6400 万像素或浏览器尺寸上限。请选择缩小导出。');
      if (!preview && (input.width !== width || input.height !== height)) {
        throw new Error('SVG 栅格尺寸与计划导出尺寸不一致，请重新生成导出预览。');
      }
      const options = exportOptions(message);
      output = canvas(input.width, input.height);
      context(output).drawImage(input, 0, 0);
      await applyRasterAdjustments(output, message);
      await decorateExport(output, dimensions, options);
      const warnings = canExport ? [] : ['原尺寸超过导出上限，请选择缩小导出；水印预览仍可查看。'];
      const encode = async () => {
        const blob = await output.convertToBlob({ type: options.mime, quality: options.quality });
        if (blob.type !== options.mime) throw new Error('此浏览器无法编码所选格式，请改用 PNG 或更新 Chrome / Edge。');
        return blob;
      };
      if (preview) {
        const bitmap = options.format === 'jpeg' ? await createImageBitmap(await encode()) : await createImageBitmap(output);
        return {
          bitmap, width: bitmap.width, height: bitmap.height,
          exportWidth: width, exportHeight: height, canExport, format: options.format, warnings,
          documentWidth: Number(message.documentWidth) || width,
          documentHeight: Number(message.documentHeight) || height,
          originX: Number(message.originX) || 0, originY: Number(message.originY) || 0,
        };
      }
      return { blob: await encode(), width, height, format: options.format, warnings };
    } finally {
      // Transfer gives this request ownership of its input, including when
      // option validation or encoding fails.
      try { input?.close?.(); } catch { /* A previously closed bitmap is safe. */ }
      release(output);
    }
  }

  async function hitTest(message) {
    if (!psd) throw new Error('请先打开一个 PSD 文件。');
    if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) throw new Error('无效的画布坐标。');
    const selected = message.mode === 'layer' ? nodes.get(message.layerId) : undefined;
    if (message.mode === 'layer' && !selected) throw new Error('请先选择一个图层。');
    const point = rect(Math.floor(message.x), Math.floor(message.y), 1, 1);
    const range = selected ? selected.bounds : rect(0, 0, psd.width, psd.height);
    if (!intersects(point, range)) return { layerId: null, candidates: [], warnings: [] };
    const state = {
      area: point, width: 1, height: 1, sx: 1, sy: 1,
      groupBytes: 0, exportMode: false,
      hidden: Array.isArray(message.hiddenIds) ? new Set(message.hiddenIds) : initialHidden,
      solo: selected ? undefined : nodes.get(message.soloId), warnings: new Set(),
    };
    const candidates = [];
    const alphaMemo = new Map(), maskMemo = new Map();
    const scratch = canvas(1, 1), sample = context(scratch);
    const contains = node => !!intersects(point, node.bounds);
    const nonempty = alpha => alpha * 255 >= .5;
    const channel = (pixels, index) => pixels.data instanceof Float32Array ? clamp(pixels.data[index], 0, 1)
      : pixels.data[index] / (pixels.data instanceof Uint16Array ? 65535 : 255);
    function vectorPointAlpha(node) {
      const vector = node.layer.vectorMask;
      if (!vector || vector.disable || !vector.paths?.length) return 1;
      let inside = !!vector.fillStartsWithAllPixels;
      for (const path of vector.paths) {
        const hit = sample.isPointInPath(path2d(path), point.x + .5, point.y + .5, path.fillRule === 'even-odd' ? 'evenodd' : 'nonzero');
        if (path.operation === 'subtract') inside = inside && !hit;
        else if (path.operation === 'intersect') inside = inside && hit;
        else if (path.operation === 'exclude') inside = inside !== hit;
        else inside = inside || hit;
      }
      return vector.invert ? +!inside : +inside;
    }
    function maskPointAlpha(node, real = false) {
      const mask = real ? node.layer.realMask : node.layer.mask;
      if (!mask || mask.disabled) return 1;
      const width = (mask.right || 0) - (mask.left || 0), height = (mask.bottom || 0) - (mask.top || 0);
      if (width <= 0 || height <= 0) return 1;
      assertDecode(width, height, '图层蒙版');
      const pixels = real ? agPsd.getLayerRealMaskImageData(node.layer) : agPsd.getLayerMaskImageData(node.layer);
      if (!pixels) return 1;
      const x = point.x - (mask.left || 0), y = point.y - (mask.top || 0);
      const value = x < 0 || y < 0 || x >= width || y >= height ? (mask.defaultColor === 255 ? 1 : 0) : channel(pixels, (y * pixels.width + x) * 4);
      const density = mask.userMaskDensity === undefined ? 1 : clamp(mask.userMaskDensity, 0, 1);
      if (mask.userMaskFeather) warn(state, '羽化蒙版边缘的选层按原始蒙版近似判断。');
      return 1 - density + value * density;
    }
    async function intrinsicAlpha(node, force = false) {
      if (alphaMemo.has(node.id)) return alphaMemo.get(node.id);
      try {
        let alpha = 0;
        if (!visible(node, state, force) || !contains(node)) return 0;
        if (node.meta.type === 'group') {
          for (let i = 0; i < node.children.length; i++) {
            const base = node.children[i];
            while (i + 1 < node.children.length && node.children[i + 1].meta.clipping) i++;
            if (base.meta.clipping || !contains(base) || !visible(base, state, false) || !base.meta.opacity) continue;
            const sourceAlpha = await intrinsicAlpha(base) * base.meta.opacity;
            // Clipped layers change colors while retaining the base's shape.
            alpha = sourceAlpha + alpha * (1 - sourceAlpha);
          }
          alpha *= await groupMaskAlpha(node);
        } else {
          const key = `${node.id}:${point.x},${point.y}`;
          if (hitAlphaCache.has(key)) return hitAlphaCache.get(key);
          const layer = node.layer;
          if (node.meta.hasPixels) {
            const width = layer.right - layer.left, height = layer.bottom - layer.top;
            assertDecode(width, height, `图层“${node.meta.name}”`);
            // Read the native alpha directly. This avoids allocating a second
            // full-size ImageBitmap just to select a single original pixel.
            const pixels = agPsd.getLayerImageData(layer);
            const x = point.x - layer.left, y = point.y - layer.top;
            if (pixels && x >= 0 && y >= 0 && x < pixels.width && y < pixels.height) alpha = channel(pixels, (y * pixels.width + x) * 4 + 3);
            if (layer.vectorMask && !layer.vectorFill && !layer.mask?.fromVectorData) alpha *= vectorPointAlpha(node);
          } else if (layer.vectorFill && (layer.vectorFill.type === 'color' || layer.vectorFill.type === 'solid')) {
            alpha = vectorPointAlpha(node);
          } else if (node.meta.type !== 'adjustment') {
            warn(state, `图层“${node.meta.name}”没有可独立判断的像素缓存。`);
          }
          alpha *= maskPointAlpha(node) * maskPointAlpha(node, true);
          hitAlphaCache.set(key, alpha);
          if (hitAlphaCache.size > 512) hitAlphaCache.delete(hitAlphaCache.keys().next().value);
        }
        alphaMemo.set(node.id, alpha);
        return alpha;
      } catch (error) {
        warn(state, `${node.meta.name}：${error.message || error}`);
        alphaMemo.set(node.id, 0);
        return 0;
      }
    }
    async function groupMaskAlpha(node) {
      if (!node.meta.hasMask) return 1;
      if (maskMemo.has(node.id)) return maskMemo.get(node.id);
      try {
        const alpha = maskPointAlpha(node) * maskPointAlpha(node, true) * vectorPointAlpha(node);
        maskMemo.set(node.id, alpha);
        return alpha;
      } catch (error) {
        warn(state, `${node.meta.name}：${error.message || error}`);
        maskMemo.set(node.id, 0);
        return 0;
      }
    }
    async function visitNode(node, inheritedAlpha, force = false, ignoreOpacity = false, depth = 0) {
      if (candidates.length >= 50 || depth > MAX_DEPTH || !contains(node) || !visible(node, state, force)) return;
      const alpha = inheritedAlpha * (ignoreOpacity ? 1 : node.meta.opacity);
      if (!nonempty(alpha) || node.meta.type === 'adjustment') return;
      if (node.meta.type === 'group') {
        const maskedAlpha = alpha * await groupMaskAlpha(node);
        if (nonempty(maskedAlpha)) await visitSiblings(node.children, maskedAlpha, depth + 1);
      } else if (nonempty(alpha * await intrinsicAlpha(node, force))) {
        candidates.push({ id: node.id, name: node.meta.name, type: node.meta.type });
      }
    }
    async function visitSiblings(children, inheritedAlpha, depth) {
      // Keep clipping chains intact when walking in reverse visual order.
      // A clipped layer can only be hit inside its visible base's alpha.
      const chains = [];
      for (let i = 0; i < children.length; i++) {
        const base = children[i], clips = [];
        while (i + 1 < children.length && children[i + 1].meta.clipping) clips.push(children[++i]);
        chains.push({ base, clips });
      }
      for (let i = chains.length - 1; i >= 0 && candidates.length < 50; i--) {
        const { base, clips } = chains[i];
        if (!contains(base) || !visible(base, state, false) || !nonempty(base.meta.opacity * inheritedAlpha) || base.meta.clipping) continue;
        if (clips.length) {
          const baseAlpha = await intrinsicAlpha(base) * base.meta.opacity;
          if (nonempty(baseAlpha * inheritedAlpha)) for (let j = clips.length - 1; j >= 0 && candidates.length < 50; j--) {
            await visitNode(clips[j], inheritedAlpha * baseAlpha, false, false, depth);
          }
        }
        await visitNode(base, inheritedAlpha, false, false, depth);
      }
    }
    try {
      // The existing single-layer renderer intentionally ignores the selected
      // node's own hidden flag and opacity, and ignores its external clipping
      // base and ancestors. Hit testing follows that displayed scope exactly.
      if (selected) await visitNode(selected, 1, true, true);
      else await visitSiblings(roots, 1, 0);
      return { layerId: candidates[0]?.id || null, candidates, warnings: cleanWarnings([...state.warnings]) };
    } finally { release(scratch); }
  }
  async function handle(message) {
    let result;
    switch (message.type) {
      case 'open': result = await openFile(message); break;
      case 'render': result = await render(message); break;
      case 'thumbnail': result = await thumbnail(message); break;
      case 'export': result = await exportImage(message); break;
      case 'exportPreview': result = await exportPreview(message); break;
      case 'rasterExport': result = await rasterExport(message); break;
      case 'adjustRaster': result = await adjustRaster(message); break;
      case 'hitTest': result = await hitTest(message); break;
      default: throw new Error('未知的操作。');
    }
    self.postMessage({ id: message.id, ok: true, ...result }, result.bitmap ? [result.bitmap] : []);
  }
  self.onmessage = event => {
    const message = event.data;
    // A single queue keeps decoded native images from overlapping in memory.
    queue = queue.then(() => handle(message)).catch(error => {
      const original = error?.message || String(error);
      const known = original.includes('Color mode not supported') ? '暂不支持此文件的颜色模式。请在 Photoshop 中转换为 RGB 后另存副本。'
        : original.includes('Exceeded memory limit') ? '文件解码超过内存预算；可尝试较小的 PSD 或选择单个图层。'
        : original.includes('Offset is outside') || original.includes('Invalid signature') || original.includes('Invalid PSD') ? 'PSD 文件结构异常或文件不完整，无法读取。'
        : original;
      self.postMessage({ id: message.id, ok: false, error: known });
    });
  };
})();
