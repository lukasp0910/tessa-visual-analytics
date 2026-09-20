import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import {
  computeHighlightConfig,
  computeMultiSubjectHighlights,
  clamp01,
  blendColorRgb,
  parseColorToRgb,
  rgbToCss
} from "./highlightCore.js";
import {
  shouldAllowTrailGlow,
  getRandomSampleIndices
} from "./performanceUtils.js";

const DEFAULT_COLOR_PALETTE = Array.isArray(d3.schemeTableau10)
  ? d3.schemeTableau10
  : ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0ea5e9', '#f97316', '#059669', '#a855f7', '#ef4444'];

export function drawAxes2D(axesGroup, innerWidth, innerHeight, xScale, yScale, transform, labels) {
  const zx = transform.rescaleX(xScale);
  const zy = transform.rescaleY(yScale);

  axesGroup.selectAll("*").remove();

  const xAxis = d3.axisBottom(zx).ticks(6);
  const yAxis = d3.axisLeft(zy).ticks(6);

  const xAxisGroup = axesGroup
    .append("g")
    .attr("class", "scatter-chart__axis scatter-chart__axis--x")
    .attr("transform", `translate(0,${innerHeight})`);

  xAxisGroup.call(xAxis).selectAll("text").attr("fill", "#374151").attr("font-size", 11);

  const yAxisGroup = axesGroup
    .append("g")
    .attr("class", "scatter-chart__axis scatter-chart__axis--y");

  yAxisGroup.call(yAxis).selectAll("text").attr("fill", "#374151").attr("font-size", 11);

  const xLabel = labels[0] || "X";
  const yLabel = labels[1] || "Y";

  axesGroup
    .append("text")
    .attr("class", "scatter-chart__axis-label scatter-chart__axis-label--y-inside")
    .attr("x", 6)
    .attr("y", 12)
    .attr("text-anchor", "start")
    .attr("fill", "#1f2937")
    .attr("font-size", 11)
    .attr("font-weight", 500)
    .text(yLabel);

  axesGroup
    .append("text")
    .attr("class", "scatter-chart__axis-label scatter-chart__axis-label--x-inside")
    .attr("x", innerWidth - 4)
    .attr("y", innerHeight - 6)
    .attr("text-anchor", "end")
    .attr("fill", "#1f2937")
    .attr("font-size", 11)
    .attr("font-weight", 500)
    .text(xLabel);
}

export function render2DCanvas(
  ctx,
  width,
  height,
  pointsF32,
  xScale,
  yScale,
  transform,
  margins,
  renderMode = "points",
  highlightOptions = null,
  options = {}
) {
  const innerWidth = Math.max(8, width - margins.left - margins.right);
  const innerHeight = Math.max(8, height - margins.top - margins.bottom);
  const performanceMode = !!options.performanceMode;
  const filteredVisibility = options?.filteredVisibility === "hide" ? "hide" : "grey";
  const sampledIndices = options?.sampledIndices ?? null;  // null means use all points (100%)
  const pointColors = options?.pointColors ?? null;  // Float32Array with RGB values per point

  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(margins.left, margins.top);

  const zx = transform.rescaleX(xScale);
  const zy = transform.rescaleY(yScale);

  const n = pointsF32.length / 2;
  
  // Check if this is a multi-subject chart
  const isMultiSubject = highlightOptions?.multiSubject && highlightOptions?.subjectMapping;
  
  // Compute highlights: either one highlight (single-subject) or multiple (multi-subject)
  const highlights = isMultiSubject
    ? (computeMultiSubjectHighlights(highlightOptions, n) || [])
    : (computeHighlightConfig(highlightOptions, n) ? [computeHighlightConfig(highlightOptions, n)] : []);
  
  const highlightActive = highlights.length > 0;
  
  // For backward compatibility with single-highlight code, we'll use the first highlight's properties
  // when we need general highlight style info
  const highlight = highlights[0] || null;
  const highlightStyle = highlight ? highlight.style : null;
  const highlightRowIndices = highlight ? highlight.rowIndices : null;
  const highlightMaxDistance = highlightActive ? Math.max(...highlights.map(h => h.maxTrailDistance || 0)) : 0;
  const highlightMinTrailWeight = highlightActive ? highlightStyle.minTrailWeight : 1;
  const highlightTrailSizeBoost = highlightActive ? highlightStyle.trailSizeBoost : 0;
  const highlightTrailAlphaBoost = highlightActive ? highlightStyle.trailAlphaBoost : 0;
  const highlightTrailColorStrength = highlightActive ? highlightStyle.trailColorStrength : 0;
  const highlightPastRGB = highlightActive ? highlightStyle.pastRGB : null;
  const highlightFutureRGB = highlightActive ? highlightStyle.futureRGB : null;
  const highlightTrailGlowBlur = highlightActive ? highlightStyle.trailGlowBlur : 0;
  const highlightTrailGlowSize = highlightActive ? (highlightStyle.trailGlowSizeMultiplier ?? 1.8) : 0;
  const highlightTrailGlowAlpha = highlightActive ? (highlightStyle.trailGlowAlpha ?? 0) : 0;
  const highlightTrailGlowMinWeight = highlightActive ? (highlightStyle.trailGlowMinWeight ?? 1) : 1;
  const allowTrailGlow =
    highlightActive &&
    shouldAllowTrailGlow(performanceMode) &&
    highlightTrailGlowBlur > 0 &&
    highlightTrailGlowAlpha > 0 &&
    highlightTrailGlowSize > 0 &&
    highlightTrailGlowMinWeight < 1;

  const basePointRGB = parseColorToRgb(DEFAULT_COLOR_PALETTE[0], [37, 99, 235]);
  const TRAIL_GLOW_QUEUE_LIMIT = 720;

  // Sheet-wide active range support (row-index space)
  const activeRange = options?.activeRange || null;
  // Light neutral grey for non-selected points - significantly lighter for better contrast
  const GREY_RGB = [190, 194, 201]; // lighter grey (improved contrast vs selected points)
  function isInRangeRow(rowIndex) {
    if (!activeRange || !Number.isInteger(rowIndex)) return true;
    const s = Math.min(activeRange.startIndex, activeRange.endIndex);
    const e = Math.max(activeRange.startIndex, activeRange.endIndex);
    return rowIndex >= s && rowIndex <= e;
  }

  // Point selection support (point-index space) for grey-out of non-selected points
  const pointSelection = options?.pointSelection instanceof Set
    ? options.pointSelection
    : null;
  const hasPointSelection = pointSelection && pointSelection.size > 0;
  
  function isSelectedPoint(pointIndex) {
    if (!hasPointSelection) return true;
    return pointSelection.has(pointIndex);
  }

  const shouldRenderLine = renderMode === "line" && n >= 2;
 
  if (shouldRenderLine) {
    const baseWidth = 2;
    const baseAlpha = 0.9;
    // Use cached sampled indices, or all points if sampledIndices is null
    const indicesToUse = sampledIndices ? Array.from(sampledIndices).sort((a, b) => a - b) : Array.from({ length: n }, (_, i) => i);
    const points = new Array(indicesToUse.length);
    let highlightPoint = null;
 
    let j = 0;
    for (let i = 0; i < indicesToUse.length; i++) {
      const idx = indicesToUse[i];
      const rawX = pointsF32[idx * 2];
      const rawY = pointsF32[idx * 2 + 1];
      const x = zx(rawX);
      const y = zy(rawY);
      const rowIndex = highlightRowIndices ? highlightRowIndices[idx] : idx;
      const inRange = isInRangeRow(rowIndex);
      const isSelected = isSelectedPoint(idx);
      const isActive = inRange && isSelected;
      
      // Get color from pointColors if available
      let strokeRGB = basePointRGB;
      if (pointColors && idx * 3 + 2 < pointColors.length) {
        strokeRGB = [
          pointColors[idx * 3],
          pointColors[idx * 3 + 1],
          pointColors[idx * 3 + 2]
        ];
      }
 
      const point = {
        index: idx,
        rowIndex,
        x,
        y,
        baseAlpha,
        baseWidth,
        strokeRGB: strokeRGB,
        inRange,
        isSelected,
        isActive,
        timeDelta: null,
        trailWeight: 0
      };
 
      if (highlightActive) {
        const delta = Number.isFinite(rowIndex) ? rowIndex - highlight.currentIndex : null;
        if (delta != null) {
          const withinRange = !highlightMaxDistance || Math.abs(delta) <= highlightMaxDistance;
          const weight = withinRange ? highlight.weight(delta) : 0;
          point.timeDelta = delta;
          point.trailWeight = weight;
          if (delta === 0 && (!highlightPoint || highlightPoint.index !== idx) && point.isActive) {
            point.trailWeight = 1;
            highlightPoint = point;
          }
        }
      }
 
      points[j++] = point;
    }
 
    // Draw per-segment with filter-aware styling and clean clipping.
    // A segment is "active" if BOTH endpoints pass time range AND point selection filters.
    // In 'hide' mode, inactive segments are not drawn; mixed segments are clipped to the active half only.
    // In 'grey' mode (default), inactive segments are drawn in grey and mixed segments are split with grey half.
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (!a || !b) continue;
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      const segActive = !!(a.isActive && b.isActive);
      ctx.globalAlpha = baseAlpha;
      ctx.lineWidth = Math.max(1, (a.baseWidth + b.baseWidth) * 0.5);
 
      if (segActive) {
        // Entire segment is active (selected + in-range)
        // Use average color if subjects differ
        const segmentRGB = a.strokeRGB;
        ctx.strokeStyle = `rgb(${segmentRGB[0]},${segmentRGB[1]},${segmentRGB[2]})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      } else if (!a.isActive && !b.isActive) {
        // Entire segment is inactive (not selected or not in-range)
        if (filteredVisibility === "grey") {
          ctx.strokeStyle = `rgb(${GREY_RGB[0]},${GREY_RGB[1]},${GREY_RGB[2]})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        } else {
          // 'hide' => skip
          continue;
        }
      } else {
        // Mixed: split at midpoint for clean clipping
        const mx = (a.x + b.x) * 0.5;
        const my = (a.y + b.y) * 0.5;
        const outRGB = GREY_RGB;
        if (a.isActive) {
          // First half is active
          const inRGB = a.strokeRGB;
          ctx.strokeStyle = `rgb(${inRGB[0]},${inRGB[1]},${inRGB[2]})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(mx, my);
          ctx.stroke();
          if (filteredVisibility === "grey") {
            // Draw grey second half when showing inactive
            ctx.strokeStyle = `rgb(${outRGB[0]},${outRGB[1]},${outRGB[2]})`;
            ctx.beginPath();
            ctx.moveTo(mx, my);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        } else {
          // Second half is active
          const inRGB = b.strokeRGB;
          if (filteredVisibility === "grey") {
            ctx.strokeStyle = `rgb(${outRGB[0]},${outRGB[1]},${outRGB[2]})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(mx, my);
            ctx.stroke();
          }
          // Draw only active half
          ctx.strokeStyle = `rgb(${inRGB[0]},${inRGB[1]},${inRGB[2]})`;
          ctx.beginPath();
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(mx, my);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;

    if (highlightActive && highlightStyle) {
      const highlightSegments = [];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        if (!a || !b) continue;
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;

        if (!(a.isActive && b.isActive)) continue;
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
          const baseWidthMix = Math.max(1, (segment.a.baseWidth + segment.b.baseWidth) * 0.5);
          const width = baseWidthMix * (1 + highlightTrailSizeBoost * segment.maxWeight);

          if (segment.type === "current") {
            alpha = clamp01(alpha + highlightStyle.currentAlphaBoost);
            strokeRGB = blendColorRgb(avgRGB, highlightStyle.currentRGB, highlightStyle.currentColorBlend);
          } else if (segment.type === "future" && highlightFutureRGB) {
            strokeRGB = blendColorRgb(avgRGB, highlightFutureRGB, highlightTrailColorStrength * segment.maxWeight);
          } else if (segment.type === "past" && highlightPastRGB) {
            strokeRGB = blendColorRgb(avgRGB, highlightPastRGB, highlightTrailColorStrength * segment.maxWeight);
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

      if (highlightPoint && Number.isFinite(highlightPoint.x) && Number.isFinite(highlightPoint.y)) {
        const prevPoint = highlightPoint.index > 0 ? points[highlightPoint.index - 1] : null;
        const nextPoint = highlightPoint.index < points.length - 1 ? points[highlightPoint.index + 1] : null;

        if (((prevPoint && prevPoint.inRange) || (nextPoint && nextPoint.inRange)) && highlightStyle.currentRGB) {
          const baseRGB = highlightPoint?.strokeRGB || basePointRGB;
          const highlightRGB = blendColorRgb(baseRGB, highlightStyle.currentRGB, highlightStyle.currentColorBlend);
          const highlightAlpha = clamp01((highlightPoint.baseAlpha ?? baseAlpha) + highlightStyle.currentAlphaBoost);
          const highlightWidth = Math.max(highlightPoint.baseWidth * highlightStyle.currentSizeMultiplier, highlightPoint.baseWidth + 1.2);

          ctx.save();
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.globalAlpha = highlightAlpha;
          ctx.strokeStyle = `rgb(${highlightRGB[0]},${highlightRGB[1]},${highlightRGB[2]})`;
          ctx.lineWidth = highlightWidth;
          if (highlightStyle.glowColor && highlightStyle.glowBlur > 0) {
            ctx.shadowColor = highlightStyle.glowColor;
            ctx.shadowBlur = highlightStyle.glowBlur;
          }
          ctx.beginPath();
          let moved = false;
          if (prevPoint && prevPoint.inRange && Number.isFinite(prevPoint.x) && Number.isFinite(prevPoint.y)) {
            ctx.moveTo((prevPoint.x + highlightPoint.x) * 0.5, (prevPoint.y + highlightPoint.y) * 0.5);
            moved = true;
          }
          if (!moved) {
            ctx.moveTo(highlightPoint.x, highlightPoint.y);
          }
          if (nextPoint && nextPoint.inRange && Number.isFinite(nextPoint.x) && Number.isFinite(nextPoint.y)) {
            ctx.lineTo((highlightPoint.x + nextPoint.x) * 0.5, (highlightPoint.y + nextPoint.y) * 0.5);
          } else {
            ctx.lineTo(highlightPoint.x, highlightPoint.y);
          }
          ctx.stroke();
          ctx.restore();

          const inside =
            highlightPoint.x >= 0 &&
            highlightPoint.x <= innerWidth &&
            highlightPoint.y >= 0 &&
            highlightPoint.y <= innerHeight;

          if (!inside && highlightStyle.indicatorColor) {
            const clampedX = Math.min(Math.max(highlightPoint.x, 0), innerWidth);
            const clampedY = Math.min(Math.max(highlightPoint.y, 0), innerHeight);
            const dx = highlightPoint.x - clampedX;
            const dy = highlightPoint.y - clampedY;
            const angle = Math.atan2(dy, dx);
            const indicatorSize = Math.max(12, highlightWidth * 0.8);
            const indicatorRadius = Math.max(4, highlightWidth * 0.45);
            const tipX = clampedX + Math.cos(angle) * indicatorSize;
            const tipY = clampedY + Math.sin(angle) * indicatorSize;

            ctx.save();
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = highlightStyle.indicatorColor;
            ctx.fillStyle = highlightStyle.indicatorColor;
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

  const trailGlowQueue = allowTrailGlow ? [] : null;

  function buildPoint(index) {
    const x = zx(pointsF32[index * 2]);
    const y = zy(pointsF32[index * 2 + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const rowIndex = highlightRowIndices ? highlightRowIndices[index] : index;
    const baseAlpha = 0.85;
    const baseSize = 3;
    const inRange = isInRangeRow(rowIndex);
    const isSelected = isSelectedPoint(index);
    // A point is "active" (full color) if it passes BOTH time range and point selection filters
    const isActive = inRange && isSelected;
    
    // Get color from pointColors if available, otherwise use default
    let baseColorRGB = basePointRGB;
    if (pointColors && index * 3 + 2 < pointColors.length) {
      baseColorRGB = [
        pointColors[index * 3],
        pointColors[index * 3 + 1],
        pointColors[index * 3 + 2]
      ];
    }
    
    return {
      index,
      rowIndex,
      x,
      y,
      baseAlpha,
      baseSize,
      alpha: baseAlpha,
      size: baseSize,
      baseColorRGB: baseColorRGB,
      colorRGB: isActive ? baseColorRGB : GREY_RGB,
      timeDelta: null,
      trailWeight: 0,
      inRange,
      isSelected,
      isActive
    };
  }

  // Use cached sampled indices, or all points if sampledIndices is null (100%)
  const indicesToRender = sampledIndices ? new Set(sampledIndices) : new Set(Array.from({ length: n }, (_, i) => i));
  const basePoints = [];
  const highlightPoints = []; // Store one highlight point per subject

  // Ensure all highlight points are included in rendering
  if (highlightActive) {
    for (const h of highlights) {
      if (Number.isInteger(h?.pointIndex)) {
        indicesToRender.add(h.pointIndex);
      }
    }
  }

  for (const i of indicesToRender) {
    const point = buildPoint(i);
    if (!point) continue;
 
    // Apply filtered visibility before any expensive styling or glow work
    // Hide points that don't pass BOTH time range AND point selection filters
    if (filteredVisibility === "hide" && !point.isActive) {
      continue;
    }
 
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
   
          if (delta === 0) {
            isHighlightPoint = true;
            matchingHighlight = h;
            point.trailWeight = 1;
            break; // Found the exact match for this subject
          }
        }
      }
      
      // If this is a highlight point, store it for later rendering
      if (isHighlightPoint && matchingHighlight) {
        highlightPoints.push({ point, highlight: matchingHighlight });
        continue;
      }
 
      // Only apply highlight/trail effects to active (selected + in-range) points
      if (point.isActive && point.timeDelta !== 0 && point.trailWeight > highlightMinTrailWeight) {
        point.alpha = clamp01(point.alpha + highlightTrailAlphaBoost * point.trailWeight);
        point.size *= 1 + highlightTrailSizeBoost * point.trailWeight;
 
        const target = point.timeDelta < 0 ? highlightPastRGB : highlightFutureRGB;
        if (target) {
          point.colorRGB = blendColorRgb(point.baseColorRGB, target, highlightTrailColorStrength * point.trailWeight);
        }
 
        // Time slider glows should be visible across all points when filteredVisibility is 'grey',
        // but hidden when 'hide' mode is active and point is not active (selected + in-range)
        const shouldRenderGlow = filteredVisibility === "grey" || point.isActive;
        if (
          shouldRenderGlow &&
          trailGlowQueue &&
          point.trailWeight >= highlightTrailGlowMinWeight &&
          trailGlowQueue.length < TRAIL_GLOW_QUEUE_LIMIT
        ) {
          const glowRGB = target || point.colorRGB;
          const glowAlpha = clamp01(highlightTrailGlowAlpha * point.trailWeight);
          const glowRadius = point.size * highlightTrailGlowSize;
          if (glowAlpha > 0 && glowRadius > 0) {
            trailGlowQueue.push({
              x: point.x,
              y: point.y,
              radius: glowRadius,
              alpha: glowAlpha,
              color: `rgba(${glowRGB[0]},${glowRGB[1]},${glowRGB[2]},1)`
            });
          }
        }
      }
    }
 
    basePoints.push(point);
  }

  // Check for any missing highlight points and add them
  if (highlightActive) {
    for (const h of highlights) {
      const idx = h?.pointIndex;
      if (Number.isInteger(idx) && idx >= 0 && idx < n) {
        const alreadyFound = highlightPoints.some(hp => hp.point.index === idx);
        if (!alreadyFound) {
          const point = buildPoint(idx);
          if (point && point.isActive) {
            point.timeDelta = 0;
            point.trailWeight = 1;
            highlightPoints.push({ point, highlight: h });
          }
        }
      }
    }
  }

  // Separate active and inactive points for rendering order
  // Active points = selected AND in time range (if applicable)
  const activePoints = basePoints.filter(p => p.isActive);
  const inactivePoints = filteredVisibility === "grey" ? basePoints.filter(p => !p.isActive) : [];
 
  // Apply visual tuning to inactive points: significantly reduce opacity for better contrast
  inactivePoints.forEach(point => {
    point.alpha *= 0.35; // Reduce opacity to 35% for much better distinction
    point.size *= 0.85; // Slightly reduce size
  });

  ctx.globalAlpha = 1;

  // Draw inactive points first (background layer) — only in grey mode
  for (const point of inactivePoints) {
    if (!point) continue;
    if (point.x < -2 || point.x > innerWidth + 2 || point.y < -2 || point.y > innerHeight + 2) continue;
    ctx.globalAlpha = clamp01(point.alpha);
    ctx.fillStyle = `rgb(${point.colorRGB[0]},${point.colorRGB[1]},${point.colorRGB[2]})`;
    ctx.beginPath();
    ctx.moveTo(point.x + point.size, point.y);
    ctx.arc(point.x, point.y, point.size, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw active points on top (foreground layer)
  for (const point of activePoints) {
    if (!point) continue;
    if (point.x < -2 || point.x > innerWidth + 2 || point.y < -2 || point.y > innerHeight + 2) continue;
    ctx.globalAlpha = clamp01(point.alpha);
    ctx.fillStyle = `rgb(${point.colorRGB[0]},${point.colorRGB[1]},${point.colorRGB[2]})`;
    ctx.beginPath();
    ctx.moveTo(point.x + point.size, point.y);
    ctx.arc(point.x, point.y, point.size, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;

  if (trailGlowQueue && trailGlowQueue.length) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.shadowBlur = highlightTrailGlowBlur;
    for (const glow of trailGlowQueue) {
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
  // but hidden when 'hide' mode is active and point is not active (selected + in range)
  const shouldRenderHighlights = filteredVisibility === "grey" || highlightPoints.some(hp => hp.point.isActive);
  
  if (highlightActive && shouldRenderHighlights) {
    for (const { point: highlightPoint, highlight: subjectHighlight } of highlightPoints) {
      if (!highlightPoint || !subjectHighlight || !Number.isFinite(highlightPoint.x) || !Number.isFinite(highlightPoint.y)) {
        continue;
      }
      
      const subjectStyle = subjectHighlight.style;
      const baseColor = highlightPoint.baseColorRGB || basePointRGB;
      const blendedFill = blendColorRgb(baseColor, subjectStyle.currentRGB, subjectStyle.currentColorBlend);
      const highlightSize = highlightPoint.size * subjectStyle.currentSizeMultiplier;
      const highlightAlpha = clamp01(highlightPoint.alpha + subjectStyle.currentAlphaBoost);
      const allowGlow = subjectStyle.glowColor && subjectStyle.glowBlur > 0;

      if (allowGlow) {
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

      gradient.addColorStop(
        0,
        `rgba(${subjectStyle.gradientInnerRGB[0]},${subjectStyle.gradientInnerRGB[1]},${subjectStyle.gradientInnerRGB[2]},${highlightAlpha * subjectStyle.gradientInnerAlpha})`
      );
      if (midStop > innerStop + 0.001) {
        gradient.addColorStop(
          midStop,
          `rgba(${blendedFill[0]},${blendedFill[1]},${blendedFill[2]},${highlightAlpha})`
        );
      }
      gradient.addColorStop(
        1,
        `rgba(${subjectStyle.gradientOuterRGB[0]},${subjectStyle.gradientOuterRGB[1]},${subjectStyle.gradientOuterRGB[2]},${highlightAlpha * subjectStyle.gradientOuterAlpha})`
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
        ctx.globalAlpha = Math.min(1, highlightAlpha * subjectStyle.currentCoreAlpha);
        ctx.beginPath();
        ctx.arc(highlightPoint.x, highlightPoint.y, highlightSize * subjectStyle.currentCoreScale, 0, Math.PI * 2);
        ctx.fillStyle = rgbToCss(
          subjectStyle.currentCoreRGB[0],
          subjectStyle.currentCoreRGB[1],
          subjectStyle.currentCoreRGB[2]
        );
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
