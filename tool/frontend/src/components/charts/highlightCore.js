export const HIGHLIGHT_STYLE = Object.freeze({
  fadeWindowDefault: 12,
  minTrailWeight: 0.06,
  trailSizeBoost: 0.9,
  trailAlphaBoost: 0.75,
  trailColorStrength: 0.85,
  pastColor: "#f59e0b",
  futureColor: "#ec4899",
  currentColor: "#f97316",
  currentColorBlend: 0.88,
  currentCoreColor: "#fff7ed",
  currentCoreScale: 0.35,
  currentCoreAlpha: 0.85,
  currentOutlineColor: "rgba(249,115,22,0.65)",
  currentOutlineWidth: 1.3,
  currentGlowColor: "rgba(249,115,22,0.55)",
  glowSizeMultiplier: 2.4,
  glowBlur: 64,
  currentSizeMultiplier: 2.6,
  currentAlphaBoost: 0.85,
  indicatorColor: "#f97316",
  gradientInnerColor: "#fff7ed",
  gradientOuterColor: "#f97316",
  gradientInnerAlpha: 0.98,
  gradientOuterAlpha: 0.45,
  gradientInnerStop: 0.1,
  gradientMidpoint: 0.62,
  trailGlowBlur: 18,
  trailGlowSizeMultiplier: 1.8,
  trailGlowAlpha: 0.32,
  trailGlowMinWeight: 0.35
});

export function clamp01(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function parseRgbChannel(token) {
  if (token.endsWith("%")) {
    const pct = Number.parseFloat(token.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    return clamp01(pct / 100) * 255;
  }
  const value = Number.parseFloat(token);
  if (!Number.isFinite(value)) return null;
  return value;
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360 / 360;
  const sat = clamp01(s);
  const light = clamp01(l);

  if (sat === 0) {
    const gray = Math.round(light * 255);
    return [gray, gray, gray];
  }

  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;

  const toChannel = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  const r = Math.round(clamp01(toChannel(hue + 1 / 3)) * 255);
  const g = Math.round(clamp01(toChannel(hue)) * 255);
  const b = Math.round(clamp01(toChannel(hue - 1 / 3)) * 255);
  return [r, g, b];
}

export function parseColorToRgb(color, fallback) {
  const defaultColor = Array.isArray(fallback) ? fallback.slice() : [255, 255, 255];
  if (!color || (typeof color !== "string" && !Array.isArray(color))) {
    return defaultColor;
  }
  if (Array.isArray(color) && color.length >= 3) {
    return [color[0] | 0, color[1] | 0, color[2] | 0];
  }
  if (typeof color !== "string") return defaultColor;

  const input = color.trim();
  if (!input) return defaultColor;

  if (input[0] === "#") {
    const hex = input.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if (Number.isInteger(r) && Number.isInteger(g) && Number.isInteger(b)) return [r, g, b];
    } else if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (Number.isInteger(r) && Number.isInteger(g) && Number.isInteger(b)) return [r, g, b];
    }
    return defaultColor;
  }

  const rgbMatch = input.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map(part => part.trim());
    if (parts.length >= 3) {
      const r = parseRgbChannel(parts[0]);
      const g = parseRgbChannel(parts[1]);
      const b = parseRgbChannel(parts[2]);
      if ([r, g, b].every(Number.isFinite)) {
        return [Math.round(r), Math.round(g), Math.round(b)];
      }
    }
    return defaultColor;
  }

  const hslMatch = input.match(/^hsla?\(([^)]+)\)$/i);
  if (hslMatch) {
    const parts = hslMatch[1].split(",").map(part => part.trim().replace(/%$/, ""));
    if (parts.length >= 3) {
      const h = Number.parseFloat(parts[0]);
      const s = Number.parseFloat(parts[1]) / 100;
      const l = Number.parseFloat(parts[2]) / 100;
      if ([h, s, l].every(Number.isFinite)) {
        return hslToRgb(h, s, l);
      }
    }
    return defaultColor;
  }

  return defaultColor;
}

export function blendColorRgb(base, target, amount) {
  const baseRGB = Array.isArray(base) ? base : [0, 0, 0];
  const targetRGB = Array.isArray(target) ? target : [0, 0, 0];
  const t = clamp01(Number.isFinite(amount) ? amount : 0);
  const inv = 1 - t;
  return [
    Math.round(baseRGB[0] * inv + targetRGB[0] * t),
    Math.round(baseRGB[1] * inv + targetRGB[1] * t),
    Math.round(baseRGB[2] * inv + targetRGB[2] * t)
  ];
}

export function computeHighlightConfig(options, pointCount) {
  if (!options || typeof options !== "object" || pointCount <= 0) return null;

  const rowIndices = options.rowIndices;
  if (!rowIndices || rowIndices.length !== pointCount) return null;

  const currentIndex = Number.isInteger(options.currentIndex) ? options.currentIndex : null;
  if (currentIndex == null || currentIndex < 0) return null;

  let pointIndex = Number.isInteger(options.pointIndex) ? options.pointIndex : -1;
  if (pointIndex < 0 || pointIndex >= pointCount) {
    const lookup = options.indexLookup;
    if (lookup && typeof lookup.get === "function") {
      const mapped = lookup.get(currentIndex);
      if (Number.isInteger(mapped)) pointIndex = mapped;
    }
  }

  if (pointIndex < 0 || pointIndex >= pointCount) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < rowIndices.length; i++) {
      const candidate = rowIndices[i];
      if (!Number.isFinite(candidate)) continue;
      const distance = Math.abs(candidate - currentIndex);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
        if (distance === 0) break;
      }
    }
    pointIndex = bestIndex;
  }

  if (pointIndex < 0 || pointIndex >= pointCount) return null;

  const baseStyle = HIGHLIGHT_STYLE;
  const override = typeof options.styleOverride === "object" && options.styleOverride
    ? options.styleOverride
    : null;

  const basePast = parseColorToRgb(baseStyle.pastColor, [251, 191, 36]);
  const baseFuture = parseColorToRgb(baseStyle.futureColor, [56, 189, 248]);
  const baseCurrent = parseColorToRgb(baseStyle.currentColor, [239, 68, 68]);
  const baseCore = parseColorToRgb(baseStyle.currentCoreColor, [255, 255, 255]);

  const fadeCandidate = Number.isFinite(options.fadeWindow) && options.fadeWindow > 0
    ? options.fadeWindow
    : Number.isFinite(override?.fadeWindow) && override.fadeWindow > 0
      ? override.fadeWindow
      : baseStyle.fadeWindowDefault;

  const style = {
    fadeWindow: Math.max(0, Number.isFinite(fadeCandidate) ? fadeCandidate : baseStyle.fadeWindowDefault),
    minTrailWeight: Math.max(0, Number.isFinite(override?.minTrailWeight) ? override.minTrailWeight : baseStyle.minTrailWeight),
    trailSizeBoost: Math.max(0, Number.isFinite(override?.trailSizeBoost) ? override.trailSizeBoost : baseStyle.trailSizeBoost),
    trailAlphaBoost: Math.max(0, Number.isFinite(override?.trailAlphaBoost) ? override.trailAlphaBoost : baseStyle.trailAlphaBoost),
    trailColorStrength: clamp01(Number.isFinite(override?.trailColorStrength) ? override.trailColorStrength : baseStyle.trailColorStrength),
    pastRGB: parseColorToRgb(override?.pastColor ?? baseStyle.pastColor, basePast),
    futureRGB: parseColorToRgb(override?.futureColor ?? baseStyle.futureColor, baseFuture),
    currentRGB: parseColorToRgb(override?.currentColor ?? baseStyle.currentColor, baseCurrent),
    currentColorBlend: clamp01(Number.isFinite(override?.currentColorBlend) ? override.currentColorBlend : baseStyle.currentColorBlend ?? 0.75),
    currentCoreRGB: parseColorToRgb(override?.currentCoreColor ?? baseStyle.currentCoreColor, baseCore),
    currentCoreScale: clamp01(Number.isFinite(override?.currentCoreScale) ? override.currentCoreScale : baseStyle.currentCoreScale ?? 0.55),
    currentCoreAlpha: clamp01(Number.isFinite(override?.currentCoreAlpha) ? override.currentCoreAlpha : baseStyle.currentCoreAlpha ?? 0.7),
    currentOutlineColor: typeof (override?.currentOutlineColor ?? baseStyle.currentOutlineColor) === "string"
      ? (override?.currentOutlineColor ?? baseStyle.currentOutlineColor)
      : "rgba(17,24,39,0.9)",
    currentOutlineWidth: Math.max(0, Number.isFinite(override?.currentOutlineWidth) ? override.currentOutlineWidth : baseStyle.currentOutlineWidth ?? 1.5),
    glowColor: typeof (override?.currentGlowColor ?? baseStyle.currentGlowColor) === "string"
      ? (override?.currentGlowColor ?? baseStyle.currentGlowColor)
      : null,
    glowSizeMultiplier: Math.max(1, Number.isFinite(override?.glowSizeMultiplier) ? override.glowSizeMultiplier : baseStyle.glowSizeMultiplier ?? 1.5),
    glowBlur: Math.max(0, Number.isFinite(override?.glowBlur) ? override.glowBlur : baseStyle.glowBlur ?? 24),
    currentSizeMultiplier: Math.max(1, Number.isFinite(override?.currentSizeMultiplier) ? override.currentSizeMultiplier : baseStyle.currentSizeMultiplier ?? 2.2),
    currentAlphaBoost: Math.max(0, Number.isFinite(override?.currentAlphaBoost) ? override.currentAlphaBoost : baseStyle.currentAlphaBoost ?? 0.45),
    indicatorColor: typeof (override?.indicatorColor ?? baseStyle.indicatorColor) === "string"
      ? (override?.indicatorColor ?? baseStyle.indicatorColor)
      : "#ef4444",
    gradientInnerRGB: parseColorToRgb(override?.gradientInnerColor ?? baseStyle.gradientInnerColor ?? baseStyle.currentCoreColor, baseCore),
    gradientOuterRGB: parseColorToRgb(override?.gradientOuterColor ?? baseStyle.gradientOuterColor ?? baseStyle.currentColor, baseCurrent),
    gradientInnerAlpha: clamp01(Number.isFinite(override?.gradientInnerAlpha) ? override.gradientInnerAlpha : baseStyle.gradientInnerAlpha ?? 1),
    gradientOuterAlpha: clamp01(Number.isFinite(override?.gradientOuterAlpha) ? override.gradientOuterAlpha : baseStyle.gradientOuterAlpha ?? 0.2),
    gradientInnerStop: clamp01(Number.isFinite(override?.gradientInnerStop) ? override.gradientInnerStop : baseStyle.gradientInnerStop ?? 0.05),
    gradientMidpoint: clamp01(Number.isFinite(override?.gradientMidpoint) ? override.gradientMidpoint : baseStyle.gradientMidpoint ?? 0.5),
    trailGlowBlur: Math.max(0, Number.isFinite(override?.trailGlowBlur) ? override.trailGlowBlur : baseStyle.trailGlowBlur ?? 0),
    trailGlowSizeMultiplier: Math.max(1, Number.isFinite(override?.trailGlowSizeMultiplier) ? override.trailGlowSizeMultiplier : baseStyle.trailGlowSizeMultiplier ?? 1.6),
    trailGlowAlpha: clamp01(Number.isFinite(override?.trailGlowAlpha) ? override.trailGlowAlpha : baseStyle.trailGlowAlpha ?? 0.35),
    trailGlowMinWeight: clamp01(Number.isFinite(override?.trailGlowMinWeight) ? override.trailGlowMinWeight : baseStyle.trailGlowMinWeight ?? 0.25)
  };

  const fadeWindow = Number.isFinite(style.fadeWindow) ? style.fadeWindow : 0;
  const minTrailWeight = Math.max(0.001, style.minTrailWeight || 0);
  const MAX_TRAIL_SAMPLES = 720;
  let maxTrailDistance = 0;
  let weightLUT = null;

  if (fadeWindow > 0 && minTrailWeight < 1) {
    const cacheKey = `${fadeWindow}|${minTrailWeight.toFixed(3)}`;
    const cachedWeights = options && typeof options === "object"
      ? options.__trailWeightCache
      : null;

    if (cachedWeights && cachedWeights.key === cacheKey && cachedWeights.lut instanceof Float32Array) {
      maxTrailDistance = cachedWeights.maxDistance | 0;
      weightLUT = cachedWeights.lut;
    } else {
      maxTrailDistance = Math.min(
        MAX_TRAIL_SAMPLES,
        Math.max(1, Math.ceil(fadeWindow * Math.log(1 / Math.max(minTrailWeight, 0.005))))
      );
      const lutSize = maxTrailDistance + 1;
      weightLUT = new Float32Array(lutSize);
      for (let i = 0; i < lutSize; i++) {
        weightLUT[i] = Math.exp(-i / fadeWindow);
      }

      if (options && typeof options === "object" && Object.isExtensible(options)) {
        const cacheValue = { key: cacheKey, lut: weightLUT, maxDistance: maxTrailDistance };
        if (Object.prototype.hasOwnProperty.call(options, "__trailWeightCache")) {
          const descriptor = Object.getOwnPropertyDescriptor(options, "__trailWeightCache");
          if (!descriptor || descriptor.writable) {
            options.__trailWeightCache = cacheValue;
          }
        } else {
          Object.defineProperty(options, "__trailWeightCache", {
            value: cacheValue,
            writable: true,
            configurable: true
          });
        }
      }
    }
  }

  const pointRowIndex = rowIndices[pointIndex];

  return {
    active: true,
    currentIndex,
    pointIndex,
    pointRowIndex: Number.isFinite(pointRowIndex) ? pointRowIndex : currentIndex,
    rowIndices,
    style,
    maxTrailDistance,
    weight(distance) {
      const d = Math.abs(distance);
      if (d === 0) return 1;
      if (!(fadeWindow > 0)) return 0;
      if (maxTrailDistance && d > maxTrailDistance) return 0;
      if (!weightLUT) {
        return Math.exp(-d / fadeWindow);
      }
      if (!Number.isInteger(d)) {
        const lower = Math.floor(Math.min(d, maxTrailDistance));
        const upper = Math.min(maxTrailDistance, lower + 1);
        const t = d - lower;
        const w0 = weightLUT[lower];
        const w1 = weightLUT[upper];
        return w0 + (w1 - w0) * t;
      }
      const idx = Math.min(maxTrailDistance, d | 0);
      return weightLUT[idx];
    }
  };
}

export function rgbToCss(r, g, b) {
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// Compute highlight configs for multi-subject charts (one per subject)
export function computeMultiSubjectHighlights(options, pointCount) {
  if (!options || typeof options !== "object" || pointCount <= 0) return null;

  const subjectMapping = options.subjectMapping;
  if (!subjectMapping || typeof subjectMapping !== "object") return null;

  const rowIndices = options.rowIndices;
  if (!rowIndices || rowIndices.length !== pointCount) return null;

  const currentIndex = Number.isInteger(options.currentIndex) ? options.currentIndex : null;
  if (currentIndex == null || currentIndex < 0) return null;

  // Build subject ranges
  const subjectRanges = Object.entries(subjectMapping)
    .map(([subjectId, range]) => ({
      subjectId,
      start: Math.min(range[0], range[1]),
      end: Math.max(range[0], range[1])
    }))
    .sort((a, b) => a.start - b.start);

  if (subjectRanges.length === 0) return null;

  // Use a function to get the color palette - will be passed in or use defaults
  // This ensures consistency with subject colors in ScatterChart
  const getPalette = () => {
    // Try to get d3 palette if available in options
    if (options.colorPalette && Array.isArray(options.colorPalette)) {
      return options.colorPalette;
    }
    // Fallback to standard d3.schemeTableau10 equivalent
    return [
      '#1f77b4', // blue
      '#ff7f0e', // orange
      '#2ca02c', // green
      '#d62728', // red
      '#9467bd', // purple
      '#8c564b', // brown
      '#e377c2', // pink
      '#7f7f7f', // gray
      '#bcbd22', // olive
      '#17becf'  // cyan
    ];
  };
  
  const palette = getPalette();

  const highlights = [];

  // Resolve the global timeline length so we can clamp the shared cursor index
  const totalTimesteps = Number.isInteger(options.totalTimesteps) && options.totalTimesteps > 0
    ? options.totalTimesteps
    : subjectRanges.reduce((max, range) => {
        const start = Math.round(range.start);
        const end = Math.round(range.end);
        const length = end - start + 1;
        return Number.isFinite(length) && length > max ? length : max;
      }, 0);

  // Clamp the shared cursor to a sane, non-negative index
  const safeCursorIndex = Math.max(
    0,
    Math.min(
      Number.isFinite(currentIndex) ? Math.round(currentIndex) : 0,
      totalTimesteps ? totalTimesteps - 1 : Number.isFinite(currentIndex) ? Math.round(currentIndex) : 0
    )
  );
  
  // For each subject, map the current global time to the subject's local time
  for (let subjectIdx = 0; subjectIdx < subjectRanges.length; subjectIdx++) {
    const range = subjectRanges[subjectIdx];
    const startRow = Math.round(range.start);
    const endRow = Math.round(range.end);
    const subjectLength = endRow - startRow + 1;

    if (!Number.isFinite(subjectLength) || subjectLength <= 0) continue;

    // Clamp the shared cursor to the subject's own length so it freezes when the data ends
    const localIndex = Math.min(safeCursorIndex, subjectLength - 1);
    const clampedRowIndex = Math.max(startRow, Math.min(endRow, startRow + localIndex));

    // Find the point index for this subject at the calculated row index
    let pointIndex = -1;
    let closestDistance = Infinity;
    for (let i = 0; i < rowIndices.length; i++) {
      const rowIdx = rowIndices[i];
      if (rowIdx >= startRow && rowIdx <= endRow) {
        const distance = Math.abs(rowIdx - clampedRowIndex);
        if (distance < closestDistance) {
          closestDistance = distance;
          pointIndex = i;
          if (distance === 0) break;
        }
      }
    }

    if (pointIndex < 0) continue;

    // Assign color based on subject index
    const colorHex = palette[subjectIdx % palette.length];
    const colorRgb = parseColorToRgb(colorHex, [37, 99, 235]);

    // Create style override with subject-specific color
    const styleOverride = {
      currentColor: colorHex,
      pastColor: colorHex,
      futureColor: colorHex,
      currentCoreColor: "#ffffff",
      indicatorColor: colorHex,
      gradientInnerColor: colorHex,
      gradientOuterColor: colorHex,
      currentGlowColor: `rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},0.55)`,
      currentOutlineColor: `rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},0.65)`
    };

    // Build highlight config for this subject using the single-subject function
    const subjectOptions = {
      ...options,
      currentIndex: clampedRowIndex,  // Use subject-specific row index
      pointIndex,
      styleOverride: { ...options.styleOverride, ...styleOverride }
    };

    const highlightConfig = computeHighlightConfig(subjectOptions, pointCount);
    
    if (highlightConfig) {
      highlights.push({
        ...highlightConfig,
        subjectId: range.subjectId,
        subjectIndex: subjectIdx,
        subjectRange: { start: startRow, end: endRow },
        subjectRowIndex: clampedRowIndex,
        color: colorRgb
      });
    }
  }

  return highlights.length > 0 ? highlights : null;
}
