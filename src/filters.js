/* Shared, local-only image adjustments. No canvas or document dependencies. */
'use strict';

(() => {
  const DEFAULTS = Object.freeze({ brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, strength: 100 });
  const clamp = (value, low, high, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
  };
  function normalize(value = {}) {
    if (!value || typeof value !== 'object') value = {};
    const result = {};
    for (const key of ['brightness', 'contrast', 'saturation', 'temperature']) {
      result[key] = clamp(value[key] === undefined ? DEFAULTS[key] : value[key], -100, 100, DEFAULTS[key]);
    }
    result.sharpness = clamp(value.sharpness === undefined ? 0 : value.sharpness, 0, 100, 0);
    result.strength = clamp(value.strength === undefined ? 100 : value.strength, 0, 100, 100);
    return result;
  }
  function isIdentity(value) {
    const settings = normalize(value);
    return settings.strength === 0 || ['brightness', 'contrast', 'saturation', 'temperature', 'sharpness'].every(key => settings[key] === 0);
  }
  const preset = (id, name, description, settings) => Object.freeze({ id, name, description, settings: Object.freeze(normalize(settings)) });
  const PRESETS = Object.freeze([
    preset('natural', '自然增强', '轻微提亮，保留自然色彩与细节', { brightness: 4, contrast: 8, saturation: 8, sharpness: 18 }),
    preset('bright', '明亮通透', '提亮画面，增加清透感', { brightness: 14, contrast: 4, saturation: 6, temperature: 1, sharpness: 12 }),
    preset('texture', '清晰质感', '增强明暗层次和边缘细节', { brightness: -2, contrast: 22, saturation: -5, sharpness: 45 }),
    preset('warm', '柔和暖调', '降低反差，加入柔和暖色', { brightness: 6, contrast: -8, saturation: -5, temperature: 20, sharpness: 4 }),
    preset('cool', '冷色清爽', '清爽冷色与轻度层次增强', { brightness: 6, contrast: 10, saturation: 6, temperature: -18, sharpness: 16 }),
    preset('mono', '经典黑白', '去除色彩，保留清晰明暗层次', { brightness: 2, contrast: 18, saturation: -100, sharpness: 22 }),
    preset('portrait', '人像柔和', '轻微提亮肤色，柔和暖调与自然层次', { brightness: 7, contrast: -10, saturation: -4, temperature: 6, sharpness: 0 }),
  ]);
  const now = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  const yieldTask = () => typeof setTimeout === 'function' ? new Promise(resolve => setTimeout(resolve, 0)) : Promise.resolve();

  async function process(imageData, value, options = {}) {
    const width = imageData?.width, height = imageData?.height, data = imageData?.data;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        !data || typeof data.length !== 'number' || data.length !== width * height * 4 ||
        width > 32767 || height > 32767 || width * height > 64000000) {
      throw new Error('滤镜图片尺寸无效或超过 6400 万像素上限。');
    }
    const settings = normalize(value);
    if (isIdentity(settings)) return imageData;
    const strength = settings.strength / 100;
    let deadline = now() + 12;
    const tonal = settings.brightness !== 0 || settings.contrast !== 0 || settings.saturation !== 0 || settings.temperature !== 0;
    const brightness = settings.brightness * 1.6;
    const contrast = Math.pow(4, settings.contrast / 100);
    const saturation = 1 + settings.saturation / 100;
    const redShift = settings.temperature * .55, greenShift = settings.temperature * .12, blueShift = -settings.temperature * .55;
    const positiveSize = (number, fallback) => Number.isFinite(Number(number)) && Number(number) > 0 ? Number(number) : fallback;
    const sourceWidth = positiveSize(options?.sourceWidth, width), sourceHeight = positiveSize(options?.sourceHeight, height);
    // Radius is in source-image pixels, rather than screen or preview pixels.
    // Current export never enlarges images; the ceiling also bounds memory if
    // a future caller requests enlargement or supplies inconsistent dimensions.
    const sigma = Math.min(4, 1.2 * Math.min(width / sourceWidth, height / sourceHeight));
    const sharpening = settings.sharpness > 0 && sigma >= .15;
    if (tonal && !sharpening) {
      for (let start = 0; start < data.length; start += 1048576) {
        const end = Math.min(data.length, start + 1048576);
        for (let i = start; i < end; i += 4) {
          if (data[i + 3] === 0) continue;
          const originalR = data[i], originalG = data[i + 1], originalB = data[i + 2];
          let r = (originalR + brightness - 127.5) * contrast + 127.5 + redShift;
          let g = (originalG + brightness - 127.5) * contrast + 127.5 + greenShift;
          let b = (originalB + brightness - 127.5) * contrast + 127.5 + blueShift;
          const luminance = r * .2126 + g * .7152 + b * .0722;
          r = luminance + (r - luminance) * saturation;
          g = luminance + (g - luminance) * saturation;
          b = luminance + (b - luminance) * saturation;
          // Clamp the fully adjusted color before blending its strength.
          data[i] = originalR + (Math.max(0, Math.min(255, r)) - originalR) * strength;
          data[i + 1] = originalG + (Math.max(0, Math.min(255, g)) - originalG) * strength;
          data[i + 2] = originalB + (Math.max(0, Math.min(255, b)) - originalB) * strength;
        }
        if (now() >= deadline) { await yieldTask(); deadline = now() + 12; }
      }
    }
    if (!sharpening) return imageData;
    const radius = Math.ceil(sigma * 3), count = radius * 2 + 1;
    const kernel = new Float64Array(count);
    let total = 0;
    for (let k = -radius; k <= radius; k++) { const weight = Math.exp(-k * k / (2 * sigma * sigma)); kernel[k + radius] = weight; total += weight; }
    for (let k = 0; k < count; k++) kernel[k] /= total;
    // Separable Gaussian blur in premultiplied color. Only count rows are
    // retained (about 4.5 MiB at width 32767 and native scale), never a full
    // floating-point image. Read-ahead protects input rows before in-place writes.
    const rows = Array.from({ length: count }, () => new Float32Array(width * 4));
    const rowIds = new Int32Array(count); rowIds.fill(-1);
    const colorRow = tonal ? new Uint8ClampedArray(width * 4) : null;
    const fillColorRow = y => {
      const offset = y * width * 4;
      for (let x = 0; x < width; x++) {
        const i = offset + x * 4, target = x * 4;
        let r = (data[i] + brightness - 127.5) * contrast + 127.5 + redShift;
        let g = (data[i + 1] + brightness - 127.5) * contrast + 127.5 + greenShift;
        let b = (data[i + 2] + brightness - 127.5) * contrast + 127.5 + blueShift;
        const luminance = r * .2126 + g * .7152 + b * .0722;
        colorRow[target] = luminance + (r - luminance) * saturation;
        colorRow[target + 1] = luminance + (g - luminance) * saturation;
        colorRow[target + 2] = luminance + (b - luminance) * saturation;
        colorRow[target + 3] = data[i + 3];
      }
    };
    const horizontalRow = y => {
      const slot = y % count, row = rows[slot];
      if (rowIds[slot] === y) return row;
      if (tonal) fillColorRow(y);
      const source = colorRow || data, offset = tonal ? 0 : y * width * 4;
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = -radius; k <= radius; k++) {
          const index = offset + Math.max(0, Math.min(width - 1, x + k)) * 4;
          const weight = kernel[k + radius], alpha = source[index + 3] * weight;
          r += source[index] * alpha; g += source[index + 1] * alpha; b += source[index + 2] * alpha; a += alpha;
        }
        const index = x * 4; row[index] = r; row[index + 1] = g; row[index + 2] = b; row[index + 3] = a;
      }
      rowIds[slot] = y;
      return row;
    };
    const amount = settings.sharpness / 100 * 1.5;
    let work = 0;
    for (let y = 0; y < height; y++) {
      const inputs = [];
      for (let k = -radius; k <= radius; k++) inputs.push(horizontalRow(Math.max(0, Math.min(height - 1, y + k))));
      if (tonal) fillColorRow(y);
      const offset = y * width * 4;
      for (let x = 0; x < width; x++) {
        const index = offset + x * 4;
        if (data[index + 3] === 0) continue;
        const column = x * 4;
        let r = 0, g = 0, b = 0, alpha = 0;
        for (let k = 0; k < count; k++) {
          const row = inputs[k], weight = kernel[k];
          r += row[column] * weight; g += row[column + 1] * weight; b += row[column + 2] * weight; alpha += row[column + 3] * weight;
        }
        if (alpha > 0) {
          const baseR = tonal ? colorRow[column] : data[index];
          const baseG = tonal ? colorRow[column + 1] : data[index + 1];
          const baseB = tonal ? colorRow[column + 2] : data[index + 2];
          // Blend the complete adjusted result, including sharpening, against
          // the original row. Input colors remain intact until their read-ahead
          // blur row is cached, so no full original-image copy is needed.
          data[index] += (Math.max(0, Math.min(255, baseR + amount * (baseR - r / alpha))) - data[index]) * strength;
          data[index + 1] += (Math.max(0, Math.min(255, baseG + amount * (baseG - g / alpha))) - data[index + 1]) * strength;
          data[index + 2] += (Math.max(0, Math.min(255, baseB + amount * (baseB - b / alpha))) - data[index + 2]) * strength;
        }
      }
      work += width;
      if (work >= 131072) { work = 0; if (now() >= deadline) { await yieldTask(); deadline = now() + 12; } }
    }
    return imageData;
  }

  globalThis.LayerDeskFilters = Object.freeze({ DEFAULTS, PRESETS, normalize, isIdentity, process });
})();
