import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import {
  HIGHLIGHT_STYLE,
  clamp01,
  blendColorRgb,
  computeHighlightConfig,
  computeMultiSubjectHighlights
} from "./highlightCore.js";
import { getRandomSampleIndices } from "./performanceUtils.js";
export { HIGHLIGHT_STYLE } from "./highlightCore.js";

export const DEFAULT_ROTATION = { yaw: (-40 * Math.PI) / 180, pitch: (24 * Math.PI) / 180, scale: 1 };
export const MIN_PITCH = -Math.PI / 2 + 0.1;
export const MAX_PITCH = Math.PI / 2 - 0.1;
export const MIN_SCALE = 0.3;
export const MAX_SCALE = 4;
export const INTERACTION_IDLE_MS = 90;

export const QUALITY = {
  HIGH: { BUCKETS: 48, perPointColor: true, fog: true, outline: true, sampleStep: 1 },
  AUTO: { BUCKETS: 48, perPointColor: true, fog: true, outline: true, sampleStep: 3 }
};

export const ROTATION_SETTINGS = Object.freeze({
  idle: Object.freeze({ quality: QUALITY.HIGH, dprScale: 1.0, axesEvery: 1 }),
  active: Object.freeze({ quality: QUALITY.AUTO, dprScale: 1.0, axesEvery: 8 })
});

export const STYLE_3D = {
  point: {
    sizeNear: 6.0,
    sizeFar: 1.4,
    alphaNear: 0.90,
    alphaFar: 0.30,
    outline: true,
    outlineAlpha: 0.18,
    shadow: false
  },
  fog: {
    enabled: true,
    strength: 0.42,
    background: "#ffffff"
  },
  perspective: {
    enabled: false,
    fov: 35 * Math.PI / 180,
    zEye: 2.0
  }
};

const COLOR_SCALE = d3.scaleSequential(d3.interpolateViridis).domain([0, 1]);

export function clampPitch(value) {
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, value));
}

export function buildColorLUT(n = 256) {
  const lut = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const c = d3.color(COLOR_SCALE(t));
    lut[i * 3] = c.r | 0;
    lut[i * 3 + 1] = c.g | 0;
    lut[i * 3 + 2] = c.b | 0;
  }
  return lut;
}

function rgbFromLUT(lut, t) {
  const n = lut.length / 3;
  let idx = Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
  const o = idx * 3;
  return [lut[o], lut[o + 1], lut[o + 2]];
}



export function drawAxes3D(axesGroup, width, height, labels, extents, rotation, origin, margins) {
  const innerWidth = Math.max(40, width - margins.left - margins.right);
  const innerHeight = Math.max(40, height - margins.top - margins.bottom);

  const [xExtent, yExtent, zExtent] = extents;
  const xScale = d3.scaleLinear().domain(xExtent).range([-0.5, 0.5]);
  const yScale = d3.scaleLinear().domain(yExtent).range([-0.5, 0.5]);
  const zScale = d3.scaleLinear().domain(zExtent).range([-0.5, 0.5]);

  const cosYaw = Math.cos(rotation.yaw);
  const sinYaw = Math.sin(rotation.yaw);
  const cosPitch = Math.cos(rotation.pitch);
  const sinPitch = Math.sin(rotation.pitch);
  const S = rotation.scale;

  const usePerspective = !!STYLE_3D.perspective.enabled;
  const zEye = STYLE_3D.perspective.zEye;

  function proj(x, y, z) {
    const nx = xScale(x), ny = yScale(y), nz = zScale(z);
    const yawX = nx * cosYaw + nz * sinYaw;
    const yawZ = -nx * sinYaw + nz * cosYaw;
    const pitchY = ny * cosPitch - yawZ * sinPitch;

    let px, py;
    if (usePerspective) {
      const zCam = ((ny * sinPitch + yawZ * cosPitch) + 1) * 0.5 * 2.0;
      const k = 1.0 / Math.max(0.1, zEye + zCam);
      px = yawX * innerWidth * 0.65 * S * k;
      py = pitchY * innerHeight * 0.65 * S * k;
    } else {
      px = yawX * innerWidth * 0.65 * S;
      py = pitchY * innerHeight * 0.65 * S;
    }
    return {
      x: margins.left + innerWidth / 2 + px,
      y: margins.top + innerHeight / 2 + py
    };
  }

  axesGroup.selectAll("*").remove();

  const [xMin, xMax] = xExtent;
  const [yMin, yMax] = yExtent;
  const [zMin, zMax] = zExtent;
  const [ox, oy, oz] = origin;

  const axes = [
    { from: { x: xMin, y: oy, z: oz }, to: { x: xMax, y: oy, z: oz }, label: labels[0] || "X", color: "#2563eb" },
    { from: { x: ox, y: yMin, z: oz }, to: { x: ox, y: yMax, z: oz }, label: labels[1] || "Y", color: "#16a34a" },
    { from: { x: ox, y: oy, z: zMin }, to: { x: ox, y: oy, z: zMax }, label: labels[2] || "Z", color: "#f59e0b" }
  ];

  const g = axesGroup.append("g").attr("class", "scatter-chart__axes-3d");

  g.selectAll("line.axis")
    .data(axes)
    .join("line")
    .attr("class", "axis")
    .attr("x1", d => proj(d.from.x, d.from.y, d.from.z).x)
    .attr("y1", d => proj(d.from.x, d.from.y, d.from.z).y)
    .attr("x2", d => proj(d.to.x, d.to.y, d.to.z).x)
    .attr("y2", d => proj(d.to.x, d.to.y, d.to.z).y)
    .attr("stroke", d => d.color)
    .attr("stroke-width", 2);

  g.selectAll("text.axis-label")
    .data(axes)
    .join("text")
    .attr("class", "axis-label")
    .attr("x", d => proj(d.to.x, d.to.y, d.to.z).x)
    .attr("y", d => proj(d.to.x, d.to.y, d.to.z).y)
    .attr("dx", 6)
    .attr("dy", -6)
    .attr("fill", "#1f2937")
    .attr("font-size", 12)
    .attr("font-weight", 600)
    .text(d => d.label);

  const oP = proj(ox, oy, oz);
  g.append("circle")
    .attr("cx", oP.x)
    .attr("cy", oP.y)
    .attr("r", 3)
    .attr("fill", "#374151")
    .attr("opacity", 0.8);
}

export function render3DCanvas(
  ctx,
  width,
  height,
  pointsF32,
  rotation,
  extents,
  runtime,
  margins,
  highlightOptions = null,
  renderMode = "points",
  sampledIndices = null,  // null means use all points (100%)
  subjectColors = null  // Float32Array with RGB values per point
) {
  const innerWidth = Math.max(40, width - margins.left - margins.right);
  const innerHeight = Math.max(40, height - margins.top - margins.bottom);

  const [xExtent, yExtent, zExtent] = extents;
  const xScale = d3.scaleLinear().domain(xExtent).range([-0.5, 0.5]);
  const yScale = d3.scaleLinear().domain(yExtent).range([-0.5, 0.5]);
  const zScale = d3.scaleLinear().domain(zExtent).range([-0.5, 0.5]);

  const cosYaw = Math.cos(rotation.yaw);
  const sinYaw = Math.sin(rotation.yaw);
  const cosPitch = Math.cos(rotation.pitch);
  const sinPitch = Math.sin(rotation.pitch);
  const S = rotation.scale;

  const usePerspective = !!STYLE_3D.perspective.enabled;
  const zEye = STYLE_3D.perspective.zEye;

  const BUCKETS = runtime.quality.BUCKETS;
  const fogEnabled = STYLE_3D.fog.enabled && runtime.quality.fog;
  const outlineEnabled = STYLE_3D.point.outline && runtime.quality.outline;
  const sampleStep = Math.max(1, runtime.quality.sampleStep | 0);

  if (!runtime.fogBgParsed) {
    runtime.fogBgParsed = d3.color(STYLE_3D.fog.background);
  }
  const bg = runtime.fogBgParsed;

  const pointCount = pointsF32.length / 3;
  if (!Number.isFinite(pointCount) || pointCount <= 0) {
    ctx.clearRect(0, 0, width, height);
    return;
  }

  // Check if this is a multi-subject chart
  const isMultiSubject = highlightOptions?.multiSubject && highlightOptions?.subjectMapping;
  
  // Compute highlights: either one highlight (single-subject) or multiple (multi-subject)
  const highlights = isMultiSubject
    ? (computeMultiSubjectHighlights(highlightOptions, pointCount) || [])
    : (computeHighlightConfig(highlightOptions, pointCount) ? [computeHighlightConfig(highlightOptions, pointCount)] : []);
  
  const highlightActive = highlights.length > 0;
  
  // For backward compatibility with single-highlight code, use the first highlight's properties
  const highlight = highlights[0] || null;
  const rowIndices = highlight ? highlight.rowIndices : null;
  const highlightStyle = highlight ? highlight.style : null;
  const highlightMaxDistance = highlightActive ? Math.max(...highlights.map(h => h.maxTrailDistance || 0)) : 0;
  const highlightMinTrailWeight = highlightActive ? highlightStyle.minTrailWeight : 1;
  const highlightTrailAlphaBoost = highlightActive ? highlightStyle.trailAlphaBoost : 0;
  const highlightTrailSizeBoost = highlightActive ? highlightStyle.trailSizeBoost : 0;
  const highlightTrailColorStrength = highlightActive ? highlightStyle.trailColorStrength : 0;
  const highlightTrailGlowBlur = highlightActive ? highlightStyle.trailGlowBlur : 0;
  const highlightTrailGlowSize = highlightActive ? (highlightStyle.trailGlowSizeMultiplier ?? 1.8) : 0;
  const highlightTrailGlowAlpha = highlightActive ? (highlightStyle.trailGlowAlpha ?? 0.35) : 0;
  const highlightTrailGlowMinWeight = highlightActive ? (highlightStyle.trailGlowMinWeight ?? 0.25) : Infinity;
  const highlightTrailGlowEnabled =
    highlightActive &&
    highlightTrailGlowBlur > 0 &&
    highlightTrailGlowAlpha > 0 &&
    highlightTrailGlowSize > 0 &&
    highlightTrailGlowMinWeight < 1;
  const highlightPastRGB = highlightActive ? highlightStyle.pastRGB : null;
  const highlightFutureRGB = highlightActive ? highlightStyle.futureRGB : null;

  // Sheet-wide active range (row-index space) for grey-out + glow clipping
  const activeRange = highlightOptions && highlightOptions.activeRange
    ? { startIndex: Math.min(highlightOptions.activeRange.startIndex, highlightOptions.activeRange.endIndex),
        endIndex: Math.max(highlightOptions.activeRange.startIndex, highlightOptions.activeRange.endIndex) }
    : null;
  
  // Point selection (point-index space) for grey-out of non-selected points
  const pointSelection = highlightOptions && highlightOptions.pointSelection instanceof Set
    ? highlightOptions.pointSelection
    : null;
  const hasPointSelection = pointSelection && pointSelection.size > 0;
  
  // Light neutral grey for non-selected points - significantly lighter for better contrast
  const GREY_RGB = [190, 194, 201]; // lighter grey (improved contrast vs selected points)
  const filteredVisibility = (highlightOptions && highlightOptions.filteredVisibility === "hide") ? "hide" : "grey";
  
  function isInRangeRow(rowIndex) {
    if (!activeRange || !Number.isInteger(rowIndex)) return true;
    return rowIndex >= activeRange.startIndex && rowIndex <= activeRange.endIndex;
  }
  
  function isPointSelected(pointIndex) {
    // If no point selection is active, all points are considered "selected" (normal rendering)
    if (!hasPointSelection) return true;
    return pointSelection.has(pointIndex);
  }

  function project(x, y, z) {
    const nx = xScale(x);
    const ny = yScale(y);
    const nz = zScale(z);
    const yawX = nx * cosYaw + nz * sinYaw;
    const yawZ = -nx * sinYaw + nz * cosYaw;
    const pitchY = ny * cosPitch - yawZ * sinPitch;
    const pitchZ = ny * sinPitch + yawZ * cosPitch;

    let px;
    let py;
    let k = 1.0;
    if (usePerspective) {
      const zCam = (pitchZ + 1.0) * 0.5 * 2.0;
      k = 1.0 / Math.max(0.1, zEye + zCam);
      px = yawX * innerWidth * 0.65 * S * k;
      py = pitchY * innerHeight * 0.65 * S * k;
    } else {
      px = yawX * innerWidth * 0.65 * S;
      py = pitchY * innerHeight * 0.65 * S;
    }

    return {
      x: innerWidth / 2 + px,
      y: innerHeight / 2 + py,
      depth: pitchZ,
      t: zScale(z) + 0.5,
      k
    };
  }

  function preparePoint(index) {
    const x = pointsF32[index * 3];
    const y = pointsF32[index * 3 + 1];
    const z = pointsF32[index * 3 + 2];
    const proj = project(x, y, z);
    const dNorm = clamp01((proj.depth + 1) * 0.5);
    const baseSize = lerp(STYLE_3D.point.sizeFar, STYLE_3D.point.sizeNear, dNorm) * proj.k;
    const baseAlpha = lerp(STYLE_3D.point.alphaFar, STYLE_3D.point.alphaNear, dNorm);
    const rIndex = rowIndices ? rowIndices[index] : index;
    
    // Check both time range and point selection
    const inRange = isInRangeRow(rIndex);
    const selected = isPointSelected(index);
    
    // Point is "active" if it's both in time range AND selected (when point selection is active)
    const isActive = inRange && selected;
    
    // Use subject color if available, otherwise use color from LUT
    let baseColor;
    if (subjectColors && index * 3 + 2 < subjectColors.length) {
      baseColor = [
        subjectColors[index * 3],
        subjectColors[index * 3 + 1],
        subjectColors[index * 3 + 2]
      ];
    } else {
      baseColor = rgbFromLUT(runtime.colorLUT, proj.t);
    }
    
    // Grey out inactive points
    if (!isActive) {
      baseColor = GREY_RGB;
    }
    
    const fogAmt = fogEnabled ? STYLE_3D.fog.strength * (1 - dNorm) : 0;
    
    // Reduce alpha for inactive (non-selected or out-of-range) points for better visual distinction
    const adjustedAlpha = isActive ? baseAlpha : baseAlpha * 0.35;
    const adjustedSize = isActive ? baseSize : baseSize * 0.85;

    return {
      index,
      rowIndex: rIndex,
      x: proj.x,
      y: proj.y,
      depth: proj.depth,
      dNorm,
      k: proj.k,
      size: adjustedSize,
      alpha: adjustedAlpha,
      color: baseColor,
      fogAmt,
      timeDelta: null,
      trailWeight: 0,
      inRange: isActive  // Combined check: time range AND point selection
    };
  }

  function mixColorWithFog(r, g, b, amt) {
    if (!fogEnabled || amt <= 0) return [Math.round(r), Math.round(g), Math.round(b)];
    const rr = Math.round(r * (1 - amt) + bg.r * amt);
    const gg = Math.round(g * (1 - amt) + bg.g * amt);
    const bb = Math.round(b * (1 - amt) + bg.b * amt);
    return [rr, gg, bb];
  }
  function mixToCss(r, g, b, amt) {
    const [rr, gg, bb] = mixColorWithFog(r, g, b, amt);
    return `rgb(${rr},${gg},${bb})`;
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  if (renderMode === "line") {
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(margins.left, margins.top);

    const n = pointCount;
    // Use cached sampled indices, or all points if sampledIndices is null (100%)
    const indicesToUse = sampledIndices ? Array.from(sampledIndices).sort((a, b) => a - b) : Array.from({ length: n }, (_, i) => i);
    const points = new Array(indicesToUse.length);
    const highlightPoints = []; // Store one highlight point per subject

    let j = 0;
    for (let i = 0; i < indicesToUse.length; i++) {
      const idx = indicesToUse[i];
      const point = preparePoint(idx);
      point.strokeRGB = mixColorWithFog(point.color[0], point.color[1], point.color[2], point.fogAmt);
      point.baseAlpha = clamp01(point.alpha);
      point.baseWidth = Math.max(0.6, point.size * 0.55);
      point.timeDelta = null;
      point.trailWeight = 0;
 
      // Check if this point is highlighted by any subject
      let isHighlightPoint = false;
      let matchingHighlight = null;
      
      if (highlightActive) {
        for (const h of highlights) {
          const delta = Number.isFinite(point.rowIndex) ? point.rowIndex - h.currentIndex : null;
          if (delta != null) {
            // Store the maximum weight from all subjects
            if (!point.timeDelta || Math.abs(delta) < Math.abs(point.timeDelta)) {
              point.timeDelta = delta;
              point.trailWeight = Math.max(point.trailWeight || 0, h.weight(delta));
            }
            
            if (delta === 0 && !highlightPoints.find(hp => hp.point.index === idx) && point.inRange) {
              isHighlightPoint = true;
              matchingHighlight = h;
              point.trailWeight = 1;
              break;
            }
          }
        }
      }
      
      if (isHighlightPoint && matchingHighlight) {
        highlightPoints.push({ point, highlight: matchingHighlight, pointIndex: j });
      }

      points[j++] = point;
    }

    points.length = j;

    // Check for any missing highlight points and add them
    if (highlightActive) {
      for (const h of highlights) {
        let bestPoint = null;
        let bestIndex = -1;
        let bestDistance = Infinity;
        const targetIndex = Number.isInteger(h?.currentIndex) ? h.currentIndex : null;

        for (let i = 0; i < points.length; i++) {
          const candidate = points[i];
          if (!candidate) continue;
          const rowIndex = Number.isFinite(candidate.rowIndex) ? candidate.rowIndex : candidate.index;
          if (!Number.isFinite(rowIndex) || targetIndex == null) continue;
          const distance = Math.abs(rowIndex - targetIndex);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestPoint = candidate;
            bestIndex = i;
            if (distance === 0) break;
          }
        }

        if (!bestPoint && Number.isInteger(h?.pointIndex)) {
          const step = sampledIndices ? Math.ceil(n / indicesToUse.length) : 1;
          const fallbackIndex = Math.max(0, Math.min(points.length - 1, Math.round(h.pointIndex / step)));
          bestPoint = points[fallbackIndex];
          bestIndex = bestPoint ? fallbackIndex : -1;
        }

        if (bestPoint && bestIndex >= 0) {
          const alreadyFound = highlightPoints.some(hp => hp.point.index === bestPoint.index);
          if (!alreadyFound) {
            bestPoint.timeDelta = 0;
            bestPoint.trailWeight = 1;
            highlightPoints.push({ point: bestPoint, highlight: h, pointIndex: bestIndex });
          }
        }
      }
    }

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    let prev = null;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (!point) continue;
      if (!prev) {
        prev = point;
        continue;
      }
      if (
        !Number.isFinite(prev.x) ||
        !Number.isFinite(prev.y) ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y)
      ) {
        prev = point;
        continue;
      }

      const widthSegment = Math.max(1, (prev.baseWidth + point.baseWidth) * 0.5);
      const alphaSegment = clamp01((prev.baseAlpha + point.baseAlpha) * 0.5);
      ctx.globalAlpha = alphaSegment;
      ctx.lineWidth = widthSegment;

      const bothIn  = !!(prev.inRange && point.inRange);
      const bothOut = !prev.inRange && !point.inRange;

      if (bothIn) {
        // Entire segment inside active range -> normal stroke (fog-aware via prev.strokeRGB)
        const strokeRGB = prev.strokeRGB;
        ctx.strokeStyle = `rgb(${strokeRGB[0]},${strokeRGB[1]},${strokeRGB[2]})`;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      } else if (bothOut) {
        // Entire segment outside active range
        if (filteredVisibility === "grey") {
          const greyFog = mixColorWithFog(GREY_RGB[0], GREY_RGB[1], GREY_RGB[2], Math.max(prev.fogAmt, point.fogAmt));
          ctx.strokeStyle = `rgb(${greyFog[0]},${greyFog[1]},${greyFog[2]})`;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(point.x, point.y);
          ctx.stroke();
        } else {
          // 'hide' => skip drawing entirely
          // no-op
        }
      } else {
        // Mixed segment: split at midpoint for clean clipping at range boundary
        const mx = (prev.x + point.x) * 0.5;
        const my = (prev.y + point.y) * 0.5;
 
        // In-range half uses series color (already fog-aware in prev.strokeRGB or point.strokeRGB)
        const inRGB = prev.inRange ? prev.strokeRGB : point.strokeRGB;
        // Out-of-range half uses grey fog
        const fogAmtHalf = Math.max(prev.fogAmt, point.fogAmt);
        const greyFog = mixColorWithFog(GREY_RGB[0], GREY_RGB[1], GREY_RGB[2], fogAmtHalf);
 
        if (prev.inRange) {
          // first half normal
          ctx.strokeStyle = `rgb(${inRGB[0]},${inRGB[1]},${inRGB[2]})`;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(mx, my);
          ctx.stroke();
          // second half grey unless hidden
          if (filteredVisibility === "grey") {
            ctx.strokeStyle = `rgb(${greyFog[0]},${greyFog[1]},${greyFog[2]})`;
            ctx.beginPath();
            ctx.moveTo(mx, my);
            ctx.lineTo(point.x, point.y);
            ctx.stroke();
          }
        } else {
          // first half grey unless hidden
          if (filteredVisibility === "grey") {
            ctx.strokeStyle = `rgb(${greyFog[0]},${greyFog[1]},${greyFog[2]})`;
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(mx, my);
            ctx.stroke();
          }
          // second half normal
          ctx.strokeStyle = `rgb(${inRGB[0]},${inRGB[1]},${inRGB[2]})`;
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(point.x, point.y);
          ctx.stroke();
        }
      }

      prev = point;
    }

    ctx.globalAlpha = 1;

    if (highlightActive && highlightStyle) {
      const highlightSegments = [];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        if (!a || !b) continue;
        if (
          !Number.isFinite(a.x) ||
          !Number.isFinite(a.y) ||
          !Number.isFinite(b.x) ||
          !Number.isFinite(b.y)
        ) continue;

        if (!(a.inRange && b.inRange)) continue;
        const weightA = a.trailWeight || 0;
        const weightB = b.trailWeight || 0;
        const maxWeight = Math.max(weightA, weightB);
        if (!maxWeight || maxWeight <= highlightMinTrailWeight) continue;

        const deltaA = a.timeDelta ?? 0;
        const deltaB = b.timeDelta ?? 0;
        let type = "past";
        if (
          deltaA === 0 ||
          deltaB === 0 ||
          (deltaA < 0 && deltaB > 0) ||
          (deltaA > 0 && deltaB < 0)
        ) {
          type = "current";
        } else if (deltaA > 0 && deltaB > 0) {
          type = "future";
        }

        highlightSegments.push({ a, b, maxWeight, type });
      }

      if (highlightSegments.length) {
        ctx.save();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";

        for (const segment of highlightSegments) {
          const avgRGB = [
            Math.round((segment.a.strokeRGB[0] + segment.b.strokeRGB[0]) * 0.5),
            Math.round((segment.a.strokeRGB[1] + segment.b.strokeRGB[1]) * 0.5),
            Math.round((segment.a.strokeRGB[2] + segment.b.strokeRGB[2]) * 0.5)
          ];

          let strokeRGB = avgRGB;
          let alpha = clamp01(
            Math.max(segment.a.baseAlpha, segment.b.baseAlpha) + highlightTrailAlphaBoost * segment.maxWeight
          );
          const baseWidth = Math.max(1, (segment.a.baseWidth + segment.b.baseWidth) * 0.5);
          const width = baseWidth * (1 + highlightTrailSizeBoost * segment.maxWeight);

          if (segment.type === "current") {
            alpha = clamp01(alpha + highlightStyle.currentAlphaBoost);
            strokeRGB = blendColorRgb(avgRGB, highlightStyle.currentRGB, highlightStyle.currentColorBlend);
          } else if (segment.type === "future" && highlightFutureRGB) {
            strokeRGB = blendColorRgb(
              avgRGB,
              highlightFutureRGB,
              highlightTrailColorStrength * segment.maxWeight
            );
          } else if (segment.type === "past" && highlightPastRGB) {
            strokeRGB = blendColorRgb(
              avgRGB,
              highlightPastRGB,
              highlightTrailColorStrength * segment.maxWeight
            );
          }

          ctx.globalAlpha = alpha;
          ctx.lineWidth = width;
          ctx.strokeStyle = `rgb(${strokeRGB[0]},${strokeRGB[1]},${strokeRGB[2]})`;
          ctx.beginPath();
          ctx.moveTo(segment.a.x, segment.a.y);
          ctx.lineTo(segment.b.x, segment.b.y);
          ctx.stroke();
        }

        ctx.restore();
        ctx.globalAlpha = 1;
      }

      // Render highlight points for line mode (one per subject with unique colors)
      for (const { point: highlightPoint, highlight: subjectHighlight, pointIndex: highlightIndex } of highlightPoints) {
        if (!highlightPoint || !subjectHighlight || !highlightPoint.inRange) continue;
        if (!Number.isFinite(highlightPoint.x) || !Number.isFinite(highlightPoint.y)) continue;
        
        const current = highlightPoint;
        const prevPoint = highlightIndex > 0 ? points[highlightIndex - 1] : null;
        const nextPoint = highlightIndex < points.length - 1 ? points[highlightIndex + 1] : null;

        if ((prevPoint || nextPoint) && subjectHighlight.style.currentRGB) {
          const subjectStyle = subjectHighlight.style;
          const highlightRGB = blendColorRgb(current.strokeRGB, subjectStyle.currentRGB, subjectStyle.currentColorBlend);
          const highlightAlpha = clamp01((current.baseAlpha ?? 0.9) + subjectStyle.currentAlphaBoost);
          const highlightWidth = Math.max(current.baseWidth * subjectStyle.currentSizeMultiplier, current.baseWidth + 1.2);

          ctx.save();
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.globalAlpha = highlightAlpha;
          ctx.strokeStyle = `rgb(${highlightRGB[0]},${highlightRGB[1]},${highlightRGB[2]})`;
          ctx.lineWidth = highlightWidth;
          if (subjectStyle.glowColor && subjectStyle.glowBlur > 0) {
            ctx.shadowColor = subjectStyle.glowColor;
            ctx.shadowBlur = subjectStyle.glowBlur;
          }
          ctx.beginPath();
          if (prevPoint && Number.isFinite(prevPoint.x) && Number.isFinite(prevPoint.y)) {
            ctx.moveTo((prevPoint.x + current.x) * 0.5, (prevPoint.y + current.y) * 0.5);
          } else {
            ctx.moveTo(current.x, current.y);
          }
          if (nextPoint && Number.isFinite(nextPoint.x) && Number.isFinite(nextPoint.y)) {
            ctx.lineTo((current.x + nextPoint.x) * 0.5, (current.y + nextPoint.y) * 0.5);
          } else {
            ctx.lineTo(current.x, current.y);
          }
          ctx.stroke();
          ctx.restore();

          const inside =
            current.x >= 0 && current.x <= innerWidth && current.y >= 0 && current.y <= innerHeight;
          if (!inside && subjectStyle.indicatorColor) {
            const clampedX = Math.min(Math.max(current.x, 0), innerWidth);
            const clampedY = Math.min(Math.max(current.y, 0), innerHeight);
            const dx = current.x - clampedX;
            const dy = current.y - clampedY;
            const angle = Math.atan2(dy, dx);
            const indicatorSize = Math.max(12, highlightWidth * 0.8);
            const indicatorRadius = Math.max(4, highlightWidth * 0.45);
            const tipX = clampedX + Math.cos(angle) * indicatorSize;
            const tipY = clampedY + Math.sin(angle) * indicatorSize;

            ctx.save();
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = subjectStyle.indicatorColor;
            ctx.fillStyle = subjectStyle.indicatorColor;
            ctx.lineWidth = 2;

            ctx.beginPath();
            ctx.arc(clampedX, clampedY, indicatorRadius, 0, Math.PI * 2);
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(clampedX, clampedY);
            ctx.lineTo(tipX, tipY);
            ctx.stroke();

            const headSize = Math.max(5, indicatorRadius);
            ctx.beginPath();
            ctx.moveTo(tipX, tipY);
            ctx.lineTo(
              tipX - Math.cos(angle - Math.PI / 6) * headSize,
              tipY - Math.sin(angle - Math.PI / 6) * headSize
            );
            ctx.lineTo(
              tipX - Math.cos(angle + Math.PI / 6) * headSize,
              tipY - Math.sin(angle + Math.PI / 6) * headSize
            );
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        }
      }
    }

    ctx.restore();
    return;
  }

  // cap the amount of glow commands we enqueue to avoid worst-case slowdowns
  const TRAIL_GLOW_QUEUE_LIMIT = 720;

  let trailGlowQueue = null;
  let getTrailGlowColorString = null;
  if (highlightTrailGlowEnabled) {
    const existingQueue = Array.isArray(runtime.trailGlowQueue) ? runtime.trailGlowQueue : [];
    existingQueue.length = 0;
    runtime.trailGlowQueue = existingQueue;
    trailGlowQueue = existingQueue;

    const colorCache = runtime.trailGlowColorCache instanceof Map ? runtime.trailGlowColorCache : new Map();
    runtime.trailGlowColorCache = colorCache;
    getTrailGlowColorString = (r, g, b) => {
      const key = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
      let cached = colorCache.get(key);
      if (!cached) {
        cached = `rgba(${r},${g},${b},1)`;
        colorCache.set(key, cached);
      }
      return cached;
    };
  } else if (Array.isArray(runtime.trailGlowQueue)) {
    runtime.trailGlowQueue.length = 0;
  }

  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(margins.left, margins.top);

  if (!runtime.bucketsCache || runtime.bucketsCache.length !== BUCKETS) {
    runtime.bucketsCache = new Array(BUCKETS).fill(null).map(() => []);
  } else {
    for (let b = 0; b < BUCKETS; b++) runtime.bucketsCache[b].length = 0;
  }

  const n = pointCount;
  const highlightPoints = []; // Store one highlight point per subject

  // Use cached sampled indices, or all points if sampledIndices is null (100%)
  const indicesToRender = sampledIndices ? sampledIndices : new Set(Array.from({ length: n }, (_, i) => i));
  for (const i of indicesToRender) {
    const point = preparePoint(i);
 
    // Check if this point is highlighted by any subject
    let isHighlightPoint = false;
    let matchingHighlight = null;
    
    if (highlightActive) {
      for (const h of highlights) {
        const delta = Number.isFinite(point.rowIndex) ? point.rowIndex - h.currentIndex : null;
        if (delta != null) {
          const withinRange = !h.maxTrailDistance || Math.abs(delta) <= h.maxTrailDistance;
          const weight = withinRange ? h.weight(delta) : 0;
          
          // Store the maximum weight from all subjects for trail effects
          if (!point.timeDelta || Math.abs(delta) < Math.abs(point.timeDelta)) {
            point.timeDelta = delta;
            point.trailWeight = Math.max(point.trailWeight || 0, weight);
          }
          
          const isTarget = h.pointIndex === i;
          if (delta === 0 && (isTarget || !highlightPoints.find(hp => hp.point.index === i))) {
            if (point.inRange) {
              isHighlightPoint = true;
              matchingHighlight = h;
              point.trailWeight = 1;
              break; // Found exact match for this subject
            }
          }
        }
      }
      
      if (isHighlightPoint && matchingHighlight) {
        highlightPoints.push({ point, highlight: matchingHighlight });
        continue;
      }
    }
 
    // Apply filtered visibility early (skip out-of-range points in 'hide' mode)
    if (filteredVisibility === "hide" && !point.inRange) {
      continue;
    }
 
    const bucketIndex = Math.max(0, Math.min(BUCKETS - 1, (point.dNorm * (BUCKETS - 1)) | 0));
    runtime.bucketsCache[bucketIndex].push(point);
  }

  // Check for any missing highlight points and add them
  if (highlightActive) {
    for (const h of highlights) {
      const idx = h?.pointIndex;
      if (Number.isInteger(idx) && idx >= 0 && idx < n) {
        const alreadyFound = highlightPoints.some(hp => hp.point.index === idx);
        if (!alreadyFound) {
          const point = preparePoint(idx);
          point.timeDelta = 0;
          point.trailWeight = 1;
          if (point.inRange) {
            highlightPoints.push({ point, highlight: h });
          }
        }
      }
    }
  }

  for (let bi = 0; bi < BUCKETS; bi++) {
    const arr = runtime.bucketsCache[bi];
    if (!arr.length) continue;

    for (let k = 0; k < arr.length; k++) {
      const point = arr[k];

      let size = point.size;
      let alpha = point.alpha;
      let colorR = point.color[0];
      let colorG = point.color[1];
      let colorB = point.color[2];

      if (highlightActive && point.inRange && point.trailWeight && point.timeDelta !== 0 && point.timeDelta != null) {
        const weight = point.trailWeight;
        if (weight > highlightMinTrailWeight) {
          alpha = clamp01(alpha + highlightTrailAlphaBoost * weight);
          size *= 1 + highlightTrailSizeBoost * weight;

          const target = point.timeDelta < 0 ? highlightPastRGB : highlightFutureRGB;
          if (target) {
            const blendAmount = highlightTrailColorStrength * weight;
            if (blendAmount > 0) {
              const blended = blendColorRgb([colorR, colorG, colorB], target, blendAmount);
              colorR = blended[0];
              colorG = blended[1];
              colorB = blended[2];
            }
          }

          // Add a soft halo for trail points (pre-/afterglow), gated by weight for performance
          // Time slider glows should be visible across all points when filteredVisibility is 'grey',
          // but hidden when 'hide' mode is active and point is not in range
          const shouldRenderGlow = filteredVisibility === "grey" || point.inRange;
          if (
            shouldRenderGlow &&
            trailGlowQueue &&
            weight >= highlightTrailGlowMinWeight &&
            trailGlowQueue.length < TRAIL_GLOW_QUEUE_LIMIT
          ) {
            const glowR = target ? target[0] : colorR;
            const glowG = target ? target[1] : colorG;
            const glowB = target ? target[2] : colorB;
            const glowAlpha = clamp01(highlightTrailGlowAlpha * weight);
            const glowRadius = size * highlightTrailGlowSize;
            if (glowAlpha > 0 && glowRadius > 0) {
              const glowColor = getTrailGlowColorString
                ? getTrailGlowColorString(glowR, glowG, glowB)
                : `rgba(${glowR},${glowG},${glowB},1)`;
              trailGlowQueue.push({
                x: point.x,
                y: point.y,
                radius: glowRadius,
                alpha: glowAlpha,
                color: glowColor
              });
            }
          }
        }
      }

      const fill = mixToCss(colorR, colorG, colorB, point.fogAmt);

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(point.x + size, point.y);
      ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();

      if (STYLE_3D.point.outline && outlineEnabled) {
        ctx.globalAlpha = alpha * STYLE_3D.point.outlineAlpha;
        ctx.lineWidth = Math.max(1, Math.floor(size * 0.5) * 0.5);
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        ctx.stroke();
      }
    }
  }

  ctx.globalAlpha = 1;

  if (trailGlowQueue && trailGlowQueue.length) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.shadowBlur = highlightTrailGlowBlur;
    for (let i = 0; i < trailGlowQueue.length; i++) {
      const glow = trailGlowQueue[i];
      if (!glow || glow.alpha <= 0 || !Number.isFinite(glow.radius) || glow.radius <= 0) continue;
      ctx.globalAlpha = glow.alpha;
      ctx.shadowColor = glow.color;
      ctx.fillStyle = glow.color;
      ctx.beginPath();
      ctx.arc(glow.x, glow.y, glow.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Render main highlight points (one per subject with unique colors)
  // Should be visible across all points when filteredVisibility is 'grey',
  // but hidden when 'hide' mode is active and point is not in range
  const shouldRenderHighlights = filteredVisibility === "grey" || highlightPoints.some(hp => hp.point.inRange);
  
  if (highlightActive && shouldRenderHighlights) {
    for (const { point: highlightPoint, highlight: subjectHighlight } of highlightPoints) {
      if (!highlightPoint || !subjectHighlight) continue;
      
      const subjectStyle = subjectHighlight.style;
      const baseColor = highlightPoint.color;
      const blendedFill = blendColorRgb(baseColor, subjectStyle.currentRGB, subjectStyle.currentColorBlend);
      const highlightSize = highlightPoint.size * subjectStyle.currentSizeMultiplier;
      const highlightAlpha = clamp01(highlightPoint.alpha + subjectStyle.currentAlphaBoost);
      const highlightMixed = mixColorWithFog(blendedFill[0], blendedFill[1], blendedFill[2], highlightPoint.fogAmt);

      if (subjectStyle.glowColor && subjectStyle.glowBlur > 0) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, highlightAlpha);
        ctx.shadowColor = subjectStyle.glowColor;
        ctx.shadowBlur = subjectStyle.glowBlur;
        ctx.fillStyle = subjectStyle.glowColor;
        ctx.beginPath();
        ctx.arc(highlightPoint.x, highlightPoint.y, highlightSize * subjectStyle.glowSizeMultiplier, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      const innerStop = Math.min(0.98, Math.max(0, subjectStyle.gradientInnerStop ?? 0));
      const midStop = Math.min(0.99, Math.max(innerStop, subjectStyle.gradientMidpoint ?? 0.5));
      const gradient = ctx.createRadialGradient(
        highlightPoint.x,
        highlightPoint.y,
        highlightSize * innerStop,
        highlightPoint.x,
        highlightPoint.y,
        highlightSize
      );
      const innerRGB = mixColorWithFog(
        subjectStyle.gradientInnerRGB[0],
        subjectStyle.gradientInnerRGB[1],
        subjectStyle.gradientInnerRGB[2],
        highlightPoint.fogAmt
      );
      const outerRGB = mixColorWithFog(
        subjectStyle.gradientOuterRGB[0],
        subjectStyle.gradientOuterRGB[1],
        subjectStyle.gradientOuterRGB[2],
        highlightPoint.fogAmt
      );
      gradient.addColorStop(
        0,
        `rgba(${innerRGB[0]},${innerRGB[1]},${innerRGB[2]},${highlightAlpha * subjectStyle.gradientInnerAlpha})`
      );
      if (midStop > innerStop + 0.001) {
        gradient.addColorStop(
          midStop,
          `rgba(${highlightMixed[0]},${highlightMixed[1]},${highlightMixed[2]},${highlightAlpha})`
        );
      }
      gradient.addColorStop(
        1,
        `rgba(${outerRGB[0]},${outerRGB[1]},${outerRGB[2]},${highlightAlpha * subjectStyle.gradientOuterAlpha})`
      );

      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(highlightPoint.x, highlightPoint.y, highlightSize, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();

      if (subjectStyle.currentOutlineColor && subjectStyle.currentOutlineWidth > 0) {
        ctx.globalAlpha = Math.min(1, highlightAlpha);
        ctx.lineWidth = Math.max(1.2, highlightSize * (subjectStyle.currentOutlineWidth * 0.2));
        ctx.strokeStyle = subjectStyle.currentOutlineColor;
        ctx.stroke();
      }

      if (subjectStyle.currentCoreScale > 0) {
        const coreRGB = subjectStyle.currentCoreRGB || baseColor;
        const coreFill = mixToCss(coreRGB[0], coreRGB[1], coreRGB[2], highlightPoint.fogAmt);
        ctx.globalAlpha = Math.min(1, highlightAlpha * subjectStyle.currentCoreAlpha);
        ctx.beginPath();
        ctx.arc(highlightPoint.x, highlightPoint.y, highlightSize * subjectStyle.currentCoreScale, 0, Math.PI * 2);
        ctx.fillStyle = coreFill;
        ctx.fill();
      }

      ctx.globalAlpha = 1;

      const inside =
        highlightPoint.x >= 0 &&
        highlightPoint.x <= innerWidth &&
        highlightPoint.y >= 0 &&
        highlightPoint.y <= innerHeight;

      if (!inside && subjectStyle.indicatorColor) {
        const clampedX = Math.min(Math.max(highlightPoint.x, 0), innerWidth);
        const clampedY = Math.min(Math.max(highlightPoint.y, 0), innerHeight);
        const dx = highlightPoint.x - clampedX;
        const dy = highlightPoint.y - clampedY;
        const angle = Math.atan2(dy, dx);
        const indicatorSize = Math.max(12, highlightSize * 0.8);
        const indicatorRadius = Math.max(4, highlightSize * 0.45);
        const tipX = clampedX + Math.cos(angle) * indicatorSize;
        const tipY = clampedY + Math.sin(angle) * indicatorSize;

        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = subjectStyle.indicatorColor;
        ctx.fillStyle = subjectStyle.indicatorColor;
        ctx.lineWidth = 2;

        ctx.beginPath();
        ctx.arc(clampedX, clampedY, indicatorRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(clampedX, clampedY);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();

        const headSize = Math.max(5, indicatorRadius);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(
          tipX - Math.cos(angle - Math.PI / 6) * headSize,
          tipY - Math.sin(angle - Math.PI / 6) * headSize
        );
        ctx.lineTo(
          tipX - Math.cos(angle + Math.PI / 6) * headSize,
          tipY - Math.sin(angle + Math.PI / 6) * headSize
        );
        ctx.closePath();
        ctx.fill();

        ctx.restore();
      }
    }
  }

  ctx.restore();
}

export function bind3DInteractionsCanvas(containerNode, rotation, onInteract, onDragEndSpin, onRotateFrame) {
  containerNode.style.cursor = "grab";
  let activePointer = null;
  let lastPosition = null;
  let lastMoveTime = 0;
  let velocity = { vx: 0, vy: 0 };

  function updateRotation(dx, dy) {
    rotation.yaw += dx * 0.01;
    rotation.pitch = clampPitch(rotation.pitch - dy * 0.01);
    onInteract();
    if (typeof onRotateFrame === "function") onRotateFrame();
  }

  function handlePointerDown(event) {
    // Check if the click is on an interactive UI element (like PCA overlay dropdowns)
    const target = event.target;
    const isInteractiveUI = target.closest('[data-pca-overlay]') || 
                           target.tagName === 'SELECT' || 
                           target.tagName === 'BUTTON' ||
                           target.tagName === 'INPUT' ||
                           target.closest('button') ||
                           target.closest('select');
    
    // Don't capture pointer if clicking on UI elements
    if (isInteractiveUI) {
      return;
    }
    
    event.preventDefault();
    activePointer = event.pointerId;
    lastPosition = { x: event.clientX, y: event.clientY };
    lastMoveTime = performance.now();
    velocity.vx = 0;
    velocity.vy = 0;
    containerNode.setPointerCapture?.(activePointer);
    containerNode.style.cursor = "grabbing";
  }

  function handlePointerMove(event) {
    if (activePointer !== event.pointerId || !lastPosition) return;
    const now = performance.now();
    const dt = Math.max(1, now - lastMoveTime);
    const dx = event.clientX - lastPosition.x;
    const dy = event.clientY - lastPosition.y;
    lastPosition = { x: event.clientX, y: event.clientY };
    lastMoveTime = now;

    velocity.vx = dx / dt;
    velocity.vy = dy / dt;

    updateRotation(dx, dy);
  }

  function resetPointer(event) {
    if (activePointer !== event.pointerId) return;
    if (containerNode.hasPointerCapture?.(activePointer)) {
      containerNode.releasePointerCapture(activePointer);
    }
    activePointer = null;
    lastPosition = null;
    containerNode.style.cursor = "grab";
    if (typeof onDragEndSpin === "function") {
      onDragEndSpin({ vx: velocity.vx, vy: velocity.vy });
    }
  }

  function handleWheel(event) {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.001);
    rotation.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, rotation.scale * factor));
    onInteract();
    if (typeof onRotateFrame === "function") onRotateFrame();
  }

  function handleDoubleClick(event) {
    event.preventDefault();
    rotation.yaw = DEFAULT_ROTATION.yaw;
    rotation.pitch = DEFAULT_ROTATION.pitch;
    rotation.scale = DEFAULT_ROTATION.scale;
    onInteract();
    if (typeof onRotateFrame === "function") onRotateFrame();
  }

  containerNode.addEventListener("pointerdown", handlePointerDown);
  containerNode.addEventListener("pointermove", handlePointerMove);
  containerNode.addEventListener("pointerup", resetPointer);
  containerNode.addEventListener("pointercancel", resetPointer);
  containerNode.addEventListener("pointerleave", resetPointer);
  containerNode.addEventListener("wheel", handleWheel, { passive: false });
  containerNode.addEventListener("dblclick", handleDoubleClick);

  return () => {
    containerNode.removeEventListener("pointerdown", handlePointerDown);
    containerNode.removeEventListener("pointermove", handlePointerMove);
    containerNode.removeEventListener("pointerup", resetPointer);
    containerNode.removeEventListener("pointercancel", resetPointer);
    containerNode.removeEventListener("pointerleave", resetPointer);
    containerNode.removeEventListener("wheel", handleWheel);
    containerNode.removeEventListener("dblclick", handleDoubleClick);
  };
}
