// LineChart.js - renders a responsive line chart using D3 (with brush sync + fixes)
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import { requestJson } from '../../api/client.js';
import { getSnapshot } from '../../state/store.js';
import {
  subscribe as subscribeToTimeRangeFilter,
  getActiveDomain as getActiveTimeRangeDomain,
} from '../../state/timeRangeFilter.js';
import {
  subscribe as subscribeToTimeCursor,
  getState as getTimeCursorState,
  setIndex as setTimeCursorIndex,
  pause as pauseTimeCursor,
} from '../../features/timeControls/timeCursor.js';
import { subscribe as subscribeToSettings } from '../../features/timeControls/settingsState.js';
import {
  subscribe as subscribeToPointSelection,
  getPointSelection,
} from '../../state/pointSelection.js';
import {
  subscribe as subscribeToClusterFilter,
  getClusterFilter,
} from '../../state/clusterFilter.js';

const LINE_CHART_ENDPOINT = '/api/v1/charts/line';
const DEFAULT_HEIGHT = 280;
const DEFAULT_MIN_WIDTH = 320;
const BASE_MARGINS = { top: 24, right: 32, bottom: 40, left: 56 };
const MIN_CONTEXT_HEIGHT = 48;
const MAX_CONTEXT_HEIGHT = 160;
const CONTEXT_HEIGHT_RATIO = 0.22;
const ALL_SUBJECT_OPTION = 'ALL';

function normalizeSubjectValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '0') return null;
    return trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = String(value).trim();
    if (!text || text === '0') return null;
    return text;
  }
  const asText = String(value).trim();
  if (!asText || asText === '0') return null;
  return asText;
}

function normalizeSubjectSelection(values) {
  if (!Array.isArray(values)) return [];
  const normalized = values.map(normalizeSubjectValue).filter(Boolean);
  const unique = Array.from(new Set(normalized));
  unique.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return unique;
}

function extractSubjectIdFromSeries(series) {
  if (!series || typeof series !== 'object') return null;
  const key = typeof series.key === 'string' ? series.key : '';
  const keyMatch = key.match(/^subject_([^_]+(?:_[^_]+)*)_column_/i);
  if (keyMatch && keyMatch[1]) {
    return keyMatch[1];
  }
  return null;
}

function getEffectiveMargins(totalHeight) {
  const safeHeight = Number.isFinite(totalHeight) && totalHeight > 0 ? totalHeight : DEFAULT_HEIGHT;
  const clamped = Math.max(180, Math.min(safeHeight, 720));
  const ratio = (clamped - 180) / (720 - 180);

  const minTop = 10;
  const minBottom = 24;

  const top = Math.round(minTop + (BASE_MARGINS.top - minTop) * ratio);
  const bottom = Math.round(minBottom + (BASE_MARGINS.bottom - minBottom) * ratio);

  return {
    top,
    bottom,
    left: BASE_MARGINS.left,
    right: BASE_MARGINS.right,
  };
}

function isAllSubjectsSelection(value) {
  return typeof value === 'string' && value.trim().toUpperCase() === ALL_SUBJECT_OPTION;
}

function computeLayoutHeights(innerHeight) {
  if (!Number.isFinite(innerHeight) || innerHeight <= 0) {
    return { focusHeight: 0, contextHeight: 0, gap: 0 };
  }

  const gap = Math.min(Math.max(innerHeight * 0.03, 6), 18);
  const maxContextByHeight = Math.max(0, innerHeight - gap);

  let contextHeight = innerHeight * CONTEXT_HEIGHT_RATIO;
  contextHeight = Math.max(contextHeight, MIN_CONTEXT_HEIGHT);
  contextHeight = Math.min(contextHeight, MAX_CONTEXT_HEIGHT, maxContextByHeight);

  let focusHeight = Math.max(0, innerHeight - contextHeight - gap);

  const preferredFocus = Math.min(innerHeight * 0.55, Math.max(0, maxContextByHeight));
  if (focusHeight < preferredFocus && maxContextByHeight > MIN_CONTEXT_HEIGHT) {
    const adjustedContext = Math.max(MIN_CONTEXT_HEIGHT, innerHeight - gap - preferredFocus);
    if (adjustedContext < contextHeight) {
      contextHeight = adjustedContext;
      focusHeight = Math.max(0, innerHeight - contextHeight - gap);
    }
  }

  contextHeight = Math.min(contextHeight, maxContextByHeight);
  focusHeight = Math.max(0, innerHeight - contextHeight - gap);

  return { focusHeight, contextHeight, gap };
}
const DEFAULT_COLOR_PALETTE = Array.isArray(d3.schemeTableau10)
  ? d3.schemeTableau10
  : ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0ea5e9', '#f97316', '#059669', '#a855f7', '#ef4444'];

const bisectStep = d3.bisector(d => d.step).center;
const bisectOrderedStep = d3.bisector(d => d).center;
const STEP_FORMATTER = d3.format('~d');
const VALUE_FORMATTER = d3.format('.4~g');

// Performance knob (when to draw circles)
const MAX_POINTS_FOR_CIRCLES_TOTAL = 1500;

function computeAggregateSeries(series) {
  if (!Array.isArray(series) || series.length < 2) {
    return { meanSeries: [], envelope: [] };
  }

  const stepBuckets = new Map();
  series.forEach(entry => {
    const points = Array.isArray(entry?.points) ? entry.points : [];
    points.forEach(point => {
      const step = Number(point?.step);
      const value = Number(point?.value);
      if (!Number.isFinite(step) || !Number.isFinite(value)) return;
      if (!stepBuckets.has(step)) stepBuckets.set(step, []);
      stepBuckets.get(step).push(value);
    });
  });

  const steps = Array.from(stepBuckets.keys()).sort((a, b) => a - b);
  if (!steps.length) return { meanSeries: [], envelope: [] };

  const meanPoints = [];
  const envelope = [];
  steps.forEach(step => {
    const values = stepBuckets.get(step).filter(Number.isFinite);
    if (!values.length) return;
    const mean = d3.mean(values);
    const min = Math.min(...values);
    const max = Math.max(...values);
    meanPoints.push({ step, value: mean });
    envelope.push({ step, min, max });
  });

  if (!meanPoints.length) return { meanSeries: [], envelope: [] };

  return {
    meanSeries: [{ key: 'aggregate_mean', label: 'Average', points: meanPoints }],
    envelope,
  };
}

function formatTooltipValue(value) {
  if (!Number.isFinite(value)) return '–';
  return VALUE_FORMATTER(value);
}

function findNearestPoint(points, targetStep) {
  if (!Array.isArray(points) || !points.length || !Number.isFinite(targetStep)) return null;
  const index = Math.max(0, Math.min(points.length - 1, bisectStep(points, targetStep)));
  return points[index] || null;
}

function findNearestStepIndex(steps, target) {
  if (!Array.isArray(steps) || !steps.length || !Number.isFinite(target)) return null;
  const index = Math.max(0, Math.min(steps.length - 1, bisectOrderedStep(steps, target)));
  const value = steps[index];
  if (!Number.isFinite(value)) return null;
  return { index, value };
}

function collectOrderedSteps(series) {
  if (!Array.isArray(series) || !series.length) return [];

  const unique = new Set();
  series.forEach(entry => {
    const points = Array.isArray(entry?.points) ? entry.points : [];
    points.forEach(point => {
      const step = Number(point?.step);
      if (Number.isFinite(step)) unique.add(step);
    });
  });

  return unique.size ? Array.from(unique).sort((a, b) => a - b) : [];
}

function buildChartState(rawSeries, innerWidth, focusHeight, contextHeight) {
  const series = (Array.isArray(rawSeries) ? rawSeries : [])
    .map((entry, index) => {
      const key = typeof entry?.key === 'string' && entry.key.trim() ? entry.key.trim() : `series_${index + 1}`;
      const columnIndex = Number.isFinite(entry?.columnIndex) ? Number(entry.columnIndex) : null;
      const labelCandidate = typeof entry?.label === 'string' && entry.label.trim()
        ? entry.label.trim()
        : (columnIndex ? `Column ${columnIndex}` : key);
      const points = Array.isArray(entry?.points)
        ? entry.points
            .map(point => {
              const step = Number(point?.step);
              const value = Number(point?.value);
              if (!Number.isFinite(step) || !Number.isFinite(value)) return null;
              return { step, value, timestamp: point?.timestamp ?? null };
            })
            .filter(Boolean)
            .sort((a, b) => a.step - b.step)
        : [];
      return { key, label: labelCandidate, columnIndex, points };
    })
    .filter(entry => entry.points.length);

  if (!series.length) return null;

  const allPoints = series.flatMap(entry => entry.points);
  const stepValues = allPoints.map(p => (Number.isFinite(p.step) ? p.step : null)).filter(Number.isFinite);
  const orderedSteps = stepValues.length
    ? Array.from(new Set(stepValues)).sort((a, b) => a - b)
    : [];

  let xStart;
  let xEnd;
  if (stepValues.length) {
    const minimum = Math.min(...stepValues);
    const maximum = Math.max(...stepValues);
    xStart = Number.isFinite(minimum) ? minimum : 1;
    xEnd = Number.isFinite(maximum) ? maximum : xStart + 1;
  } else {
    let fallbackLength = 0;
    series.forEach(entry => {
      const length = Array.isArray(entry?.points) ? entry.points.length : 0;
      if (length > fallbackLength) fallbackLength = length;
    });
    xStart = 1;
    xEnd = Math.max(1, fallbackLength);
  }
  if (!Number.isFinite(xStart)) xStart = 1;
  if (!Number.isFinite(xEnd)) xEnd = xStart + 1;
  if (xEnd <= xStart) {
    xStart = Math.max(0, xStart - 0.5);
    xEnd = xEnd + 0.5;
  }

  const yExtent = d3.extent(allPoints, d => d.value);
  const yDomain = (() => {
    if (!yExtent || yExtent[0] === undefined || yExtent[1] === undefined) return [0, 1];
    if (yExtent[0] === yExtent[1]) {
      const base = Math.abs(yExtent[0]) || 1;
      const pad = Math.max(base * 0.05, 1e-6);
      return [yExtent[0] - pad, yExtent[1] + pad];
    }
    return yExtent;
  })();

  const xFocus = d3.scaleLinear().domain([xStart, xEnd]).range([0, innerWidth]);
  const xContext = d3.scaleLinear().domain([xStart, xEnd]).range([0, innerWidth]);
  const yScale = d3.scaleLinear().domain(yDomain).nice().range([focusHeight, 0]);

  const colorRange = series.map((_, idx) => DEFAULT_COLOR_PALETTE[idx % DEFAULT_COLOR_PALETTE.length]);
  const colorScale = d3.scaleOrdinal().domain(series.map(e => e.key)).range(colorRange);

  const line = d3.line().defined(d => Number.isFinite(d.step) && Number.isFinite(d.value));

  return { series, xFocus, xContext, yScale, colorScale, line, focusHeight, contextHeight, orderedSteps };
}

function computeStepTickValues(xScale, settingsState = null) {
  const [domainStartRaw, domainEndRaw] = xScale.domain();
  const domainStart = Math.ceil(Math.min(domainStartRaw, domainEndRaw));
  const domainEnd = Math.floor(Math.max(domainStartRaw, domainEndRaw));
  const range = typeof xScale.range === 'function' ? xScale.range() : [0, 0];
  const width = Math.max(0, (range || [0, 0])[1] - (range || [0, 0])[0]);
  const maxTicks = Math.max(2, Math.floor(width / 80));
  const span = Math.max(domainEnd - domainStart, 0);
  const step = Math.max(1, Math.ceil((span || 1) / Math.max(1, maxTicks - 1)));
  const tickValues = [];
  for (let v = domainStart; v <= domainEnd; v += step) tickValues.push(v);
  if (!tickValues.length) tickValues.push(Math.round(domainEndRaw || domainStartRaw || 1));
  return tickValues;
}

function formatTimeTickValue(value, settingsState = null) {
  if (!Number.isFinite(value)) return String(value);

  // Check if we should show seconds instead of steps
  const recordingDuration = settingsState?.recordingDuration;
  const selectedTimesteps = settingsState?.selected;

  if (Number.isFinite(recordingDuration) && recordingDuration > 0 &&
      Number.isInteger(selectedTimesteps) && selectedTimesteps > 0) {
    // Convert step to seconds
    const maxIndex = Math.max(selectedTimesteps - 1, 1);
    const clampedValue = Math.min(Math.max(value, 0), maxIndex);
    const seconds = (clampedValue / maxIndex) * recordingDuration;

    // Format based on scale
    if (seconds >= 60) {
      // Show minutes for larger values
      const minutes = seconds / 60;
      return `${minutes.toFixed(1)}m`;
    } else {
      // Show seconds for smaller values
      const maxFractionDigits = seconds >= 10 ? 1 : 2;
      return `${seconds.toFixed(maxFractionDigits)}s`;
    }
  }

  // Fallback to step formatting
  return d3.format('~d')(value);
}

// Split line points into segments based on selection and clustering
function getClusterPalette() {
  return Array.isArray(d3.schemeTableau10)
    ? d3.schemeTableau10
    : ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0ea5e9', '#f97316', '#059669', '#a855f7', '#ef4444'];
}

function getClusterLabelOrder(labels) {
  const unique = new Set();
  labels.forEach(label => {
    if (!Number.isFinite(label)) return;
    unique.add(label);
  });
  const ordered = Array.from(unique).filter(label => label >= 0).sort((a, b) => a - b);
  if (unique.has(-1)) ordered.push(-1);
  return ordered;
}

function buildClusterColorMap(labels) {
  if (!Array.isArray(labels) || !labels.length) return null;
  const palette = getClusterPalette();
  const ordered = getClusterLabelOrder(labels);
  if (!ordered.length) return null;
  const colorByLabel = new Map();
  ordered.forEach((label, idx) => {
    if (label === -1) {
      colorByLabel.set(label, '#9ca3af');
      return;
    }
    colorByLabel.set(label, palette[idx % palette.length]);
  });
  return colorByLabel;
}

function buildClusterState(clusterFilter) {
  if (!clusterFilter || !clusterFilter.labels || !clusterFilter.labels.length) return null;
  const labels = Array.from(clusterFilter.labels);
  const colorByLabel = buildClusterColorMap(labels);
  if (!colorByLabel) return null;

  const labelByRow = new Map();
  const rowIndices = clusterFilter.rowIndices ? Array.from(clusterFilter.rowIndices) : null;

  if (rowIndices && rowIndices.length === labels.length) {
    for (let i = 0; i < labels.length; i++) {
      const rowIndex = rowIndices[i];
      if (!Number.isInteger(rowIndex)) continue;
      labelByRow.set(rowIndex, labels[i]);
    }
  } else {
    for (let i = 0; i < labels.length; i++) {
      labelByRow.set(i, labels[i]);
    }
  }

  if (!labelByRow.size) return null;
  return { labelByRow, colorByLabel };
}

function areClusterStatesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (!(a.labelByRow instanceof Map) || !(b.labelByRow instanceof Map)) return false;
  if (a.labelByRow.size !== b.labelByRow.size) return false;
  for (const [key, value] of a.labelByRow.entries()) {
    if (b.labelByRow.get(key) !== value) return false;
  }
  if (a.colorByLabel.size !== b.colorByLabel.size) return false;
  for (const [key, value] of a.colorByLabel.entries()) {
    if (b.colorByLabel.get(key) !== value) return false;
  }
  return true;
}

function splitLineByFilters(points, selectionFilter, clusterState) {
  if (!Array.isArray(points) || !points.length) return [];

  const selectionActive = selectionFilter instanceof Set && selectionFilter.size > 0;
  const clusterActive = clusterState && clusterState.labelByRow instanceof Map && clusterState.labelByRow.size > 0;

  if (!selectionActive && !clusterActive) {
    return [{ selected: true, label: null, points }];
  }

  const segments = [];
  let currentSegment = null;

  points.forEach(point => {
    const rowIndex = point.step - 1;
    const isSelected = selectionActive ? selectionFilter.has(rowIndex) : true;
    const label = clusterActive ? (clusterState.labelByRow.get(rowIndex) ?? null) : null;
    const segmentChanged = !currentSegment
      || currentSegment.selected !== isSelected
      || currentSegment.label !== label;

    if (segmentChanged) {
      if (currentSegment && currentSegment.points.length > 0) {
        const lastPoint = currentSegment.points[currentSegment.points.length - 1];
        currentSegment = { selected: isSelected, label, points: [lastPoint, point] };
      } else {
        currentSegment = { selected: isSelected, label, points: [point] };
      }
      segments.push(currentSegment);
    } else {
      currentSegment.points.push(point);
    }
  });

  return segments;
}

function renderFocusView({
  focusGroup,
  axesGroup,
  series,
  line,
  xFocus,
  yScale,
  colorScale,
  clipId,
  tickValues = [],
  drawPoints,
  settingsState = null,
  selectionFilter = null,
  clusterState = null,
  envelope = null,
}) {
  if (!focusGroup || !axesGroup || !xFocus || !yScale) return;

  // Preserve guide line and intersection points during re-render
  focusGroup.selectAll('*').filter(function() {
    return !this.classList.contains('line-chart__guide-line') &&
           !this.classList.contains('line-chart__intersection-points') &&
           !this.classList.contains('line-chart__time-cursor-line');
  }).remove();
  axesGroup.selectAll('*').remove();

  const xRange = typeof xFocus.range === 'function' ? xFocus.range() : [0, 0];
  const focusWidth = Array.isArray(xRange) ? Math.max(xRange[0], xRange[1]) - Math.min(xRange[0], xRange[1]) : 0;
  const yRange = typeof yScale.range === 'function' ? yScale.range() : [0, 0];
  const focusHeight = Array.isArray(yRange) ? Math.max(yRange[0], yRange[1]) - Math.min(yRange[0], yRange[1]) : 0;
  if (!Number.isFinite(focusWidth) || focusWidth <= 0 || !Number.isFinite(focusHeight) || focusHeight <= 0) return;

  const gridGroup = focusGroup.append('g')
    .attr('class', 'line-chart__grid')
    .attr('stroke', '#e5e7eb')
    .attr('stroke-width', 1)
    .attr('stroke-dasharray', '2,2');

  gridGroup.selectAll('line')
    .data(yScale.ticks(5))
    .join('line')
    .attr('x1', 0).attr('x2', focusWidth)
    .attr('y1', d => yScale(d)).attr('y2', d => yScale(d));

  const seriesGroup = focusGroup.append('g').attr('class', 'line-chart__series line-chart__series--focus');
  if (clipId) seriesGroup.attr('clip-path', `url(#${clipId})`);

  line.x(d => xFocus(d.step)).y(d => yScale(d.value));

  const hasEnvelope = Array.isArray(envelope) && envelope.length;
  if (hasEnvelope) {
    const baseColor = series.length ? colorScale(series[0].key) : DEFAULT_COLOR_PALETTE[0];
    const area = d3.area()
      .defined(d => Number.isFinite(d.step) && Number.isFinite(d.min) && Number.isFinite(d.max))
      .x(d => xFocus(d.step))
      .y0(d => yScale(d.min))
      .y1(d => yScale(d.max));

    seriesGroup.append('path')
      .attr('class', 'line-chart__band line-chart__band--focus')
      .attr('fill', baseColor)
      .attr('opacity', 0.15)
      .attr('d', area(envelope));

    const boundsLine = d3.line()
      .defined(d => Number.isFinite(d.step) && Number.isFinite(d.min) && Number.isFinite(d.max))
      .x(d => xFocus(d.step));

    seriesGroup.append('path')
      .attr('class', 'line-chart__band-boundary line-chart__band-boundary--lower')
      .attr('fill', 'none')
      .attr('stroke', baseColor)
      .attr('stroke-width', 1)
      .attr('opacity', 0.6)
      .attr('d', boundsLine.y(d => yScale(d.min))(envelope));

    seriesGroup.append('path')
      .attr('class', 'line-chart__band-boundary line-chart__band-boundary--upper')
      .attr('fill', 'none')
      .attr('stroke', baseColor)
      .attr('stroke-width', 1)
      .attr('opacity', 0.6)
      .attr('d', boundsLine.y(d => yScale(d.max))(envelope));
  }

  // Render each series with selection-aware segments
  series.forEach(seriesData => {
    const segments = splitLineByFilters(seriesData.points, selectionFilter, clusterState);
    const baseColor = colorScale(seriesData.key);
    const greyColor = '#d1d5db'; // gray-300 for non-selected segments
    const clusterColorMap = clusterState?.colorByLabel || null;

    // Render each segment as a separate path
    segments.forEach((segment, segmentIdx) => {
      const clusterColor = clusterColorMap ? clusterColorMap.get(segment.label) : null;
      const isClustered = clusterColorMap && segment.label !== null;
      const strokeColor = segment.selected
        ? (clusterColor || (isClustered ? greyColor : baseColor))
        : greyColor;
      seriesGroup.append('path')
        .attr('class', `line-chart__path line-chart__path--focus ${segment.selected ? 'selected' : 'non-selected'}`)
        .attr('fill', 'none')
        .attr('stroke', strokeColor)
        .attr('stroke-width', 2)
        .attr('opacity', segment.selected ? 1 : 0.5)
        .attr('d', line(segment.points))
        .datum({ seriesKey: seriesData.key, segmentIdx, selected: segment.selected });
    });
  });

  if (drawPoints) {
    series.forEach(seriesData => {
      const baseColor = colorScale(seriesData.key);
      const greyColor = '#d1d5db';
      const clusterColorMap = clusterState?.colorByLabel || null;
      
      seriesData.points.forEach(point => {
        const rowIndex = point.step - 1;
        const isSelected = !selectionFilter || selectionFilter.size === 0 || selectionFilter.has(rowIndex);
        const clusterLabel = clusterColorMap ? (clusterState?.labelByRow?.get(rowIndex) ?? null) : null;
        const clusterColor = clusterColorMap ? clusterColorMap.get(clusterLabel) : null;
        const isClustered = clusterColorMap && clusterLabel !== null;
        const fillColor = isSelected
          ? (clusterColor || (isClustered ? greyColor : baseColor))
          : greyColor;
        
        seriesGroup.append('circle')
          .attr('class', `line-chart__point line-chart__point--focus ${isSelected ? 'selected' : 'non-selected'}`)
          .attr('cx', xFocus(point.step))
          .attr('cy', yScale(point.value))
          .attr('r', 3)
          .attr('fill', fillColor)
          .attr('opacity', isSelected ? 1 : 0.5);
      });
    });
  }

  focusGroup.append('rect')
    .attr('class', 'line-chart__focus-overlay')
    .attr('width', focusWidth)
    .attr('height', focusHeight)
    .attr('fill', 'transparent')
    .attr('pointer-events', 'all');

  const focusTickValues = tickValues.length ? tickValues : computeStepTickValues(xFocus, settingsState);

  axesGroup.append('g')
    .attr('class', 'line-chart__axis line-chart__axis--x')
    .attr('transform', `translate(0,${yScale.range()[0]})`)
    .call(d3.axisBottom(xFocus).tickValues(focusTickValues).tickFormat(value => formatTimeTickValue(value, settingsState)).tickSizeOuter(0))
    .selectAll('text').attr('font-size', 12).attr('fill', '#374151');

  axesGroup.append('g')
    .attr('class', 'line-chart__axis line-chart__axis--y')
    .call(d3.axisLeft(yScale).ticks(5).tickSizeOuter(0))
    .selectAll('text').attr('font-size', 12).attr('fill', '#374151');
}

function renderContextView({
  contextGroup,
  series,
  line,
  xContext,
  yScale,
  colorScale,
  clipId,
  tickValues = [],
  onBrush = null,
  isSuppressed = null,
  drawPoints,
  settingsState = null,
  selectionFilter = null,
  clusterState = null,
  envelope = null,
}) {
  if (!contextGroup) return { brush: null, contextBrush: null, foregroundGroup: null };

  contextGroup.selectAll('*').remove();

  const contentGroup = contextGroup.append('g').attr('class', 'line-chart__content line-chart__content--context');
  const seriesGroup = contentGroup.append('g').attr('class', 'line-chart__series line-chart__series--context');
  if (clipId) seriesGroup.attr('clip-path', `url(#${clipId})`);

  line.x(d => xContext(d.step)).y(d => yScale(d.value));
  
  const hasEnvelope = Array.isArray(envelope) && envelope.length;
  if (hasEnvelope) {
    const baseColor = series.length ? colorScale(series[0].key) : DEFAULT_COLOR_PALETTE[0];
    const area = d3.area()
      .defined(d => Number.isFinite(d.step) && Number.isFinite(d.min) && Number.isFinite(d.max))
      .x(d => xContext(d.step))
      .y0(d => yScale(d.min))
      .y1(d => yScale(d.max));

    seriesGroup.append('path')
      .attr('class', 'line-chart__band line-chart__band--context')
      .attr('fill', baseColor)
      .attr('opacity', 0.12)
      .attr('d', area(envelope));

    const boundsLine = d3.line()
      .defined(d => Number.isFinite(d.step) && Number.isFinite(d.min) && Number.isFinite(d.max))
      .x(d => xContext(d.step));

    seriesGroup.append('path')
      .attr('class', 'line-chart__band-boundary line-chart__band-boundary--context-lower')
      .attr('fill', 'none')
      .attr('stroke', baseColor)
      .attr('stroke-width', 1)
      .attr('opacity', 0.5)
      .attr('d', boundsLine.y(d => yScale(d.min))(envelope));

    seriesGroup.append('path')
      .attr('class', 'line-chart__band-boundary line-chart__band-boundary--context-upper')
      .attr('fill', 'none')
      .attr('stroke', baseColor)
      .attr('stroke-width', 1)
      .attr('opacity', 0.5)
      .attr('d', boundsLine.y(d => yScale(d.max))(envelope));
  }
  // Render each series with selection-aware segments
  series.forEach(seriesData => {
    const segments = splitLineByFilters(seriesData.points, selectionFilter, clusterState);
    const baseColor = colorScale(seriesData.key);
    const greyColor = '#d1d5db'; // gray-300 for non-selected segments
    const clusterColorMap = clusterState?.colorByLabel || null;

    // Render each segment as a separate path
    segments.forEach((segment, segmentIdx) => {
      const clusterColor = clusterColorMap ? clusterColorMap.get(segment.label) : null;
      const isClustered = clusterColorMap && segment.label !== null;
      const strokeColor = segment.selected
        ? (clusterColor || (isClustered ? greyColor : baseColor))
        : greyColor;
      seriesGroup.append('path')
        .attr('class', `line-chart__path line-chart__path--context ${segment.selected ? 'selected' : 'non-selected'}`)
        .attr('fill', 'none')
        .attr('stroke', strokeColor)
        .attr('stroke-width', 1.5)
        .attr('opacity', segment.selected ? 0.8 : 0.4)
        .attr('d', line(segment.points))
        .datum({ seriesKey: seriesData.key, segmentIdx, selected: segment.selected });
    });
  });

  if (drawPoints) {
    series.forEach(seriesData => {
      const baseColor = colorScale(seriesData.key);
      const greyColor = '#d1d5db';
      const clusterColorMap = clusterState?.colorByLabel || null;
      
      seriesData.points.forEach(point => {
        const rowIndex = point.step - 1;
        const isSelected = !selectionFilter || selectionFilter.size === 0 || selectionFilter.has(rowIndex);
        const clusterLabel = clusterColorMap ? (clusterState?.labelByRow?.get(rowIndex) ?? null) : null;
        const clusterColor = clusterColorMap ? clusterColorMap.get(clusterLabel) : null;
        const isClustered = clusterColorMap && clusterLabel !== null;
        const fillColor = isSelected
          ? (clusterColor || (isClustered ? greyColor : baseColor))
          : greyColor;
        
        seriesGroup.append('circle')
          .attr('class', `line-chart__point line-chart__point--context ${isSelected ? 'selected' : 'non-selected'}`)
          .attr('cx', xContext(point.step))
          .attr('cy', yScale(point.value))
          .attr('r', 2)
          .attr('fill', fillColor)
          .attr('opacity', isSelected ? 0.8 : 0.4);
      });
    });
  }

  const contextHeight = yScale.range()[0];
  const contextTickValues = tickValues.length ? tickValues : computeStepTickValues(xContext, settingsState);

  const axisGroup = contextGroup.append('g')
    .attr('class', 'line-chart__axes-layer line-chart__axes-layer--context')
    .append('g')
    .attr('class', 'line-chart__axis line-chart__axis--x')
    .attr('transform', `translate(0,${contextHeight})`)
    .call(d3.axisBottom(xContext).tickValues(contextTickValues).tickFormat(value => formatTimeTickValue(value, settingsState)).tickSizeOuter(0));

  axisGroup.selectAll('text').attr('font-size', 10).attr('fill', '#4b5563');
  axisGroup.attr('pointer-events', 'none');

  let brush = null;
  let contextBrush = null;
  const range = xContext.range();
  const rangeStart = Array.isArray(range) ? Math.min(range[0], range[1]) : 0;
  const rangeEnd = Array.isArray(range) ? Math.max(range[0], range[1]) : 0;

  if (Number.isFinite(contextHeight) && contextHeight > 0 && Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeEnd > rangeStart) {
    brush = d3.brushX().extent([[rangeStart, 0], [rangeEnd, contextHeight]]);
    contextBrush = contextGroup.append('g').attr('class', 'line-chart__brush');
    contextBrush.call(brush);
    // Style brush handles to be subtly visible
    contextBrush.selectAll('.handle')
      .attr('stroke', '#999')
      .attr('stroke-width', 1)
      .attr('fill', 'rgba(0,0,0,0.03)');
    // Debug: verify brush is initialized and where listeners are attached
    try { console.log('[LineChart:renderContextView] Brush initialized', { extent: [[rangeStart, 0], [rangeEnd, contextHeight]], selectionHasOn: typeof contextBrush?.on === 'function', brushHasOn: typeof brush?.on === 'function' }); } catch (_) {}

    if (typeof onBrush === 'function') {
      const brushed = (event) => {
        try { console.log('[LineChart:brush] event', { type: event?.type, selection: event?.selection }); } catch (_) {}
        if (!event) return;
        if (typeof isSuppressed === 'function' && isSuppressed()) return;

        const [dMin, dMax] = xContext.domain().slice().sort((a, b) => a - b);
        let domainPair;
        if (!event.selection) {
          domainPair = [dMin, dMax];
        } else {
          const [px0, px1] = event.selection;
          const a = xContext.invert(Math.min(px0, px1));
          const b = xContext.invert(Math.max(px0, px1));
          domainPair = [Math.max(dMin, Math.min(a, b)), Math.min(dMax, Math.max(a, b))];
        }
        try { console.log('[LineChart:brush] calling onBrush with domain', domainPair); } catch (_) {}
        onBrush(domainPair);
      };
      // Update domain while dragging and on release
      brush.on('brush end', brushed);
    }
  }

  const foregroundGroup = contextGroup.append('g').attr('class', 'line-chart__foreground line-chart__foreground--context');

  return { brush, contextBrush, foregroundGroup };
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const s = value.replace(/\u00A0/g, ' ').trim().replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) return null;
    const parsed = Number.parseFloat(s);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseNonNegativeInteger(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

// Function to apply subject name mapping from project metadata
function applySubjectNameMapping(label, seriesKey, projectName) {
  try {
    // Get project metadata from snapshot
    const snapshot = getSnapshot();
    const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
    const project = projects.find(p => p?.name === projectName) || null;
    
    if (!project) return label; // No project found, return original label
    
    // Get subject names from project metadata
    const subjectNames = project.subject_names || {};
    
    // Check if this label contains a subject ID in parentheses pattern like "Column Name (1)"
    const subjectMatch = label.match(/^(.+)\s*\(([^)]+)\)$/);
    if (subjectMatch) {
      const columnName = subjectMatch[1].trim();
      const subjectId = subjectMatch[2].trim();
      
      // Check if we have a mapped name for this subject ID
      if (subjectNames[subjectId]) {
        // Replace the ID with the mapped name
        return `${columnName} (${subjectNames[subjectId]})`;
      } else {
        // No mapped name found, add "Subject" prefix to the ID
        return `${columnName} (Subject ${subjectId})`;
      }
    }
    
    return label; // No subject pattern found, return original
  } catch (error) {
    // If there's any error in mapping, return original label
    console.warn('[LineChart] Failed to apply subject name mapping:', error);
    return label;
  }
}

function buildRequestParams(configuration, options = {}) {
  if (!configuration || typeof configuration !== 'object') return null;

  const {
    fieldValues = {},
    dataSourceId,
    dataset,
    datasetId,
    projectName: configurationProjectName,
    resolvedDatasetId: configurationResolvedDatasetId,
  } = configuration;

  const optionProjectName = typeof options.projectName === 'string' && options.projectName.trim() ? options.projectName.trim() : null;
  const projectName = optionProjectName || (typeof configurationProjectName === 'string' && configurationProjectName.trim() ? configurationProjectName.trim() : null);

  const subjectSelection = normalizeSubjectSelection(options.subjects);

  const optionResolvedDataset = typeof options.resolvedDatasetId === 'string' && options.resolvedDatasetId.trim() ? options.resolvedDatasetId.trim() : null;
  const resolvedDatasetOverride = optionResolvedDataset || (typeof configurationResolvedDatasetId === 'string' && configurationResolvedDatasetId.trim() ? configurationResolvedDatasetId.trim() : null);

  const datasetOverride = typeof options.datasetId === 'string' && options.datasetId.trim()
    ? options.datasetId.trim()
    : (typeof options.dataset === 'string' && options.dataset.trim() ? options.dataset.trim() : null);

  const measureOverride = typeof options.measureColumn === 'string' && options.measureColumn.trim()
    ? options.measureColumn.trim()
    : (typeof options.measure === 'string' && options.measure.trim() ? options.measure.trim() : null);

  let datasetIdValue = resolvedDatasetOverride || null;
  if (!datasetIdValue && typeof dataset === 'string' && dataset.trim()) datasetIdValue = dataset.trim();
  else if (!datasetIdValue && typeof datasetId === 'string' && datasetId.trim()) datasetIdValue = datasetId.trim();
  else if (!datasetIdValue && typeof dataSourceId === 'string' && dataSourceId.trim()) datasetIdValue = dataSourceId.trim();

  const measures = Array.isArray(fieldValues.measures) ? fieldValues.measures : [];
  const requestedColumns = [];
  if (measures.length) {
    for (const entry of measures) {
      if (!entry || typeof entry !== 'object') continue;

      if (!datasetIdValue) {
        const sourceCandidates = [entry.source, entry.sourceId, entry.source_id];
        const source = sourceCandidates.find(c => typeof c === 'string' && c.trim());
        if (source) datasetIdValue = source.trim();
      }

      const columnCandidates = [entry.column, entry.columnId, entry.column_id];
      const column = columnCandidates.find(c => typeof c === 'string' && c.trim());
      if (column) requestedColumns.push(column.trim());
    }
  }

  if (typeof fieldValues.measure === 'string' && fieldValues.measure.trim()) {
    requestedColumns.push(fieldValues.measure.trim());
  } else if (Array.isArray(fieldValues.y) && fieldValues.y.length) {
    fieldValues.y.forEach(v => { if (typeof v === 'string' && v.trim()) requestedColumns.push(v.trim()); });
  } else if (typeof fieldValues.y === 'string' && fieldValues.y.trim()) {
    requestedColumns.push(fieldValues.y.trim());
  }

  if (datasetOverride) datasetIdValue = datasetOverride;
  if (measureOverride) requestedColumns.unshift(measureOverride);

  if (typeof datasetIdValue === 'string') datasetIdValue = datasetIdValue.trim();
  if (datasetIdValue && projectName && !datasetIdValue.includes('::')) datasetIdValue = `${projectName}::${datasetIdValue}`;

  const measureColumns = [];
  for (const col of requestedColumns) {
    if (typeof col !== 'string') continue;
    const normalized = col.trim();
    if (normalized && !measureColumns.includes(normalized)) measureColumns.push(normalized);
  }

  // Determine subject selection (if consistently specified)
  const subjectIds = [];
  let hasAllSubjectsSelection = false;
  let hasMultiSubjectMeasures = false;
  if (Array.isArray(measures)) {
    for (const entry of measures) {
      if (!entry || typeof entry !== 'object') continue;
      const multiSubjectFlag =
        typeof entry.multiSubject === 'boolean'
          ? entry.multiSubject
          : (typeof entry.multi_subject === 'boolean'
            ? entry.multi_subject
            : (typeof entry.requiresSubject === 'boolean'
              ? entry.requiresSubject
              : (typeof entry.subjectRequired === 'boolean'
              ? entry.subjectRequired
              : null)));
      if (multiSubjectFlag === true) hasMultiSubjectMeasures = true;
      const candidate =
        (typeof entry.subject === 'string' && entry.subject.trim())
          ? entry.subject.trim()
          : ((typeof entry.subjectId === 'string' && entry.subjectId.trim())
              ? entry.subjectId.trim()
              : ((typeof entry.subject_id === 'string' && entry.subject_id.trim())
              ? entry.subject_id.trim()
                  : ''));
      if (multiSubjectFlag === false) continue;
      if (isAllSubjectsSelection(candidate)) {
        hasAllSubjectsSelection = true;
        continue;
      }
      if (candidate) subjectIds.push(candidate);
    }
  }
  const uniqueSubjects = Array.from(new Set(subjectIds.filter(Boolean)));
  let resolvedSubjectId = hasAllSubjectsSelection ? null : (uniqueSubjects.length === 1 ? uniqueSubjects[0] : null);

  const selectorSubjects = subjectSelection;
  if ((hasMultiSubjectMeasures || selectorSubjects.length) && selectorSubjects.length) {
    if (selectorSubjects.length === 1) {
      hasAllSubjectsSelection = false;
      // Prefer selection from the Subject Selector when available
      uniqueSubjects.length = 0;
      resolvedSubjectId = selectorSubjects[0];
    } else {
      hasAllSubjectsSelection = true;
      resolvedSubjectId = null;
    }
  }

  // Enforce a single dataset/column selection:
  // If a subject is selected, pick the column from the first measure that uses this subject.
  // Otherwise, use the first requested column.
  let selectedColumn = null;
  let selectedSource = null;

  if (resolvedSubjectId && Array.isArray(measures)) {
    for (const entry of measures) {
      if (!entry || typeof entry !== 'object') continue;
      const multiSubjectFlag =
        typeof entry.multiSubject === 'boolean'
          ? entry.multiSubject
          : (typeof entry.multi_subject === 'boolean'
            ? entry.multi_subject
            : (typeof entry.requiresSubject === 'boolean'
              ? entry.requiresSubject
              : (typeof entry.subjectRequired === 'boolean'
                ? entry.subjectRequired
                : null)));
      if (multiSubjectFlag === false) continue;
      const subj =
        (typeof entry.subject === 'string' && entry.subject.trim())
          ? entry.subject.trim()
          : ((typeof entry.subjectId === 'string' && entry.subjectId.trim())
              ? entry.subjectId.trim()
              : ((typeof entry.subject_id === 'string' && entry.subject_id.trim())
              ? entry.subject_id.trim()
                  : ''));
      if (isAllSubjectsSelection(subj)) continue;
      if (subj === resolvedSubjectId) {
        const col =
          (typeof entry.column === 'string' && entry.column.trim())
            ? entry.column.trim()
            : ((typeof entry.columnId === 'string' && entry.columnId.trim())
                ? entry.columnId.trim()
                : ((typeof entry.column_id === 'string' && entry.column_id.trim())
                    ? entry.column_id.trim()
                    : ''));
        if (col) {
          selectedColumn = col;
          const src =
            (typeof entry.source === 'string' && entry.source.trim())
              ? entry.source.trim()
              : ((typeof entry.sourceId === 'string' && entry.sourceId.trim())
                  ? entry.sourceId.trim()
                  : ((typeof entry.source_id === 'string' && entry.source_id.trim())
                      ? entry.source_id.trim()
                      : ''));
          selectedSource = src || selectedSource;
          break;
        }
      }
    }
  }

  if (!selectedColumn) {
    selectedColumn = measureColumns.length ? measureColumns[0] : null;
  }

  // Treat 'multiple' as unresolved so we can pick a concrete source
  if (typeof datasetIdValue === 'string' && datasetIdValue.trim().toLowerCase() === 'multiple') {
    datasetIdValue = null;
  }

  // If dataset was not resolved earlier, try resolving from the selected measure's source
  if (!datasetIdValue && selectedSource) {
    datasetIdValue = selectedSource.trim();
  }

  // Normalize dataset to "<project>::<arrayIdOrName>"
  if (typeof datasetIdValue === 'string') datasetIdValue = datasetIdValue.trim();
  if (datasetIdValue && projectName && !datasetIdValue.includes('::')) {
    datasetIdValue = `${projectName}::${datasetIdValue}`;
  }

  if (!datasetIdValue || !measureColumns.length) return null;

  // Send all configured measure columns to render multiple lines
  const payload = { dataset: datasetIdValue, measure_column: measureColumns };
  if (resolvedSubjectId) payload.subject_id = resolvedSubjectId;
  return payload;
}

export class LineChart {
  static setFetcher(fetcher) {
    LineChart.fetcher = typeof fetcher === 'function' ? fetcher : requestJson;
    return LineChart.fetcher;
  }

  constructor(container, options = {}) {
    if (!container) throw new Error('A container element is required to initialize LineChart.');

    this.container = container;
    this.options = { ...options, subjects: normalizeSubjectSelection(options.subjects) };
    this.configuration = options.configuration || null;
    this.endpoint = options.endpoint || LINE_CHART_ENDPOINT;
    const defaultFetcher = typeof LineChart.fetcher === 'function' ? LineChart.fetcher : requestJson;
    this.fetcher = typeof options.fetcher === 'function' ? options.fetcher : defaultFetcher;
    this.sheetId = typeof options.sheetId === 'string' && options.sheetId.trim() ? options.sheetId.trim() : null;
    this.options.sheetId = this.sheetId;

    this.height = Number.isFinite(options.height) ? options.height : DEFAULT_HEIGHT;
    this.defaultHeight = this.height;
    this.minHeight = Number.isFinite(options.minHeight) ? options.minHeight : null;
    this.minWidth = Number.isFinite(options.minWidth) ? options.minWidth : DEFAULT_MIN_WIDTH;

    this.resizeObserver = null;
    this.abortController = null;
    this.isMounted = false;
    this._suppressBrush = false;
    this._resizeRaf = null;
    this._kbdStep = null;
    this.state = { loading: false, error: null, series: [], lastParams: null };

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'line-chart__wrapper relative w-full h-full';

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'line-chart__status text-sm text-gray-500';
    this.statusEl.setAttribute('role', 'status');
    this.wrapper.append(this.statusEl);

    this.legendEl = document.createElement('div');
    this.legendEl.className = 'line-chart__legend pointer-events-none absolute top-0 right-3 flex flex-wrap items-center gap-3 rounded-md bg-white/20 px-3 py-2 text-xs font-medium text-gray-700 shadow-sm backdrop-blur-sm';
    this.legendEl.style.display = 'none';
    this.wrapper.append(this.legendEl);

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('line-chart__svg');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('aria-label', options.ariaLabel || 'Line chart visualization');
    this.wrapper.append(this.svg);

    this.focusDomain = null;
    this.focusContentGroup = null;
    this.focusAxesGroup = null;
    this.focusForegroundGroup = null;
    this.contextGroup = null;
    this.contextForegroundGroup = null;
    this.focusClipId = null;
    this.xFocus = null;
    this.xContext = null;
    this.yScaleFocus = null;
    this.yScaleContext = null;
    this.colorScale = null;
    this.lineGenerator = null;
    this.series = [];
    this.brush = null;
    this.contextBrush = null;
    this.tooltipEl = null;
    this.legendItems = new Map();
    this.activeSeriesKey = null;
    this.timeCursorUnsubscribe = null;
    this.timeCursorState = null;
    this.timeCursorLine = null;
    this.contextTimeCursorLine = null;
    this.timeCursorFocusPoints = null;
    this.timeCursorContextPoints = null;
    this.orderedSteps = [];
    this.stepIndexLookup = new Map();
    this._latestPointerInfo = null;
    this.filteredOrderedSteps = [];
    this.guideLine = null;
    this.intersectionPoints = null;
    this.globalOrderedSteps = [];
    this.globalStepIndexLookup = new Map();
    this.settingsUnsubscribe = null;
    this.settingsState = null;
    this._defaultFocusDomain = null;
    this.timeRangeUnsubscribe = null;
    this.activeTimeRange = null;
    this.appliedStepRange = null;
    this._rawTotalPoints = 0;
    this._drawPointsPreference = null;
    this.pointSelectionUnsubscribe = null;
    this.activePointSelection = null;
    this.clusterFilterUnsubscribe = null;
    this.activeClusterFilter = null;
    this.aggregateModeActive = false;
    this.aggregateEnvelope = null;
    this.aggregateAvailable = false;
    this._lastSelectionActive = false;

    this.handleTimeCursorUpdate = this.handleTimeCursorUpdate.bind(this);
    this.onResize = this.onResize.bind(this);
    this.handleTimeRangeFilterUpdate = this.handleTimeRangeFilterUpdate.bind(this);
    this.handlePointSelectionUpdate = this.handlePointSelectionUpdate.bind(this);
    this.handleClusterFilterUpdate = this.handleClusterFilterUpdate.bind(this);
  }

  mount({ configuration } = {}) {
    if (this.isMounted) {
      if (configuration) this.setConfiguration(configuration);
      else this.refresh();
      return;
    }
    this.isMounted = true;
    if (this.container.children.length) this.container.innerHTML = '';
    this.container.append(this.wrapper);

    if (configuration) this.configuration = configuration;

    this.attachTimeCursorSubscription();
    this.attachSettingsSubscription();
    this.attachTimeRangeFilterSubscription();
    this.attachPointSelectionSubscription();
    this.attachClusterFilterSubscription();
    this.showStatus('Loading chart data…');
    this.attachResizeObserver();
    this.refresh();
  }

  unmount() {
    this.isMounted = false;
    this.detachResizeObserver();
    this.cancelOngoingRequest();
    if (this.wrapper.parentNode === this.container) this.container.removeChild(this.wrapper);
    this.detachTimeCursorSubscription();
    this.detachSettingsSubscription();
    this.detachTimeRangeFilterSubscription();
    this.detachPointSelectionSubscription();
    this.detachClusterFilterSubscription();
    this.state = { loading: false, error: null, series: [], lastParams: null };
  }

  setSheetContext(sheetId) {
    const normalized = typeof sheetId === 'string' && sheetId.trim() ? sheetId.trim() : null;
    if (this.sheetId === normalized) {
      return;
    }
    this.sheetId = normalized;
    this.options.sheetId = this.sheetId;
    if (this.isMounted) {
      this.attachTimeRangeFilterSubscription();
      this.attachPointSelectionSubscription();
      this.attachClusterFilterSubscription();
    }
  }

  setConfiguration(configuration) {
    this.configuration = configuration || null;
    if (this.isMounted) this.refresh();
  }

  setSubjectSelection(subjects) {
    const normalized = normalizeSubjectSelection(subjects);
    const current = Array.isArray(this.options?.subjects) ? this.options.subjects : [];
    const sameLength = normalized.length === current.length;
    const sameValues = sameLength && normalized.every((value, idx) => value === current[idx]);
    if (sameLength && sameValues) return;
    this.options.subjects = normalized;
    if (this.isMounted) {
      this.refresh();
    }
  }

  refresh() {
    if (!this.isMounted) return;

    const params = buildRequestParams(this.configuration, this.options);
    if (!params) {
      this.state.series = [];
      this.state.error = null;
      this.state.lastParams = null;
      this.showStatus('Line chart is not fully configured yet.');
      this.clearChart();
      return;
    }

    if (this.state.loading && this.state.lastParams && JSON.stringify(this.state.lastParams) === JSON.stringify(params)) return;

    this.cancelOngoingRequest();
    this.state.loading = true;
    this.state.error = null;
    this.state.lastParams = params;
    this.showStatus('Loading chart data…');

    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach(item => { if (item !== undefined && item !== null) searchParams.append(key, `${item}`); });
      } else if (value !== undefined && value !== null) {
        searchParams.append(key, `${value}`);
      }
    });
    const url = `${this.endpoint}?${searchParams.toString()}`;
    const usePost = url.length > 1800;
    this.abortController = new AbortController();

    const fetcher = typeof this.fetcher === 'function' ? this.fetcher : (typeof LineChart.fetcher === 'function' ? LineChart.fetcher : requestJson);
    this.fetcher = fetcher;

    const reqInit = usePost
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(searchParams)), signal: this.abortController.signal }
      : { method: 'GET', signal: this.abortController.signal };

    fetcher(usePost ? this.endpoint : url, reqInit)
      .then(payload => {
        if (!this.isMounted) return;
        const series = this.parsePayload(payload);
        this.state.loading = false;
        this.state.series = series;
        if (!series.length) {
          this.showStatus('No data available for the selected configuration.');
          this.clearChart();
          return;
        }
        this.hideStatus();
        this.renderChart();
      })
      .catch(error => {
        if (error?.name === 'AbortError') return;
        if (!this.isMounted) return;
        console.error('[LineChart] Failed to load data', error);
        this.state.loading = false;
        this.state.error = error;
        this.state.series = [];
        this.showStatus(error?.message ? `Unable to load chart data: ${error.message}` : 'Unable to load chart data.', 'error');
        this.clearChart();
      });
  }

  cancelOngoingRequest() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  attachResizeObserver() {
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(this.container);
    } else {
      window.addEventListener('resize', this.onResize);
    }
  }

  detachResizeObserver() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    } else {
      window.removeEventListener('resize', this.onResize);
    }
  }

  onResize() {
    if (!this.isMounted) return;
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = requestAnimationFrame(() => {
      if (!this.isMounted) return;
      if (this.state.series?.some(entry => entry?.points?.length)) {
        this.renderChart();
      }
    });
  }

  getContainerDimensions() {
    const widthCandidates = [];
    const heightCandidates = [];

    if (this.container) {
      widthCandidates.push(this.container.clientWidth);
      heightCandidates.push(this.container.clientHeight);
      if (typeof this.container.getBoundingClientRect === 'function') {
        const rect = this.container.getBoundingClientRect();
        widthCandidates.push(rect?.width);
        heightCandidates.push(rect?.height);
      }
    }

    if (this.wrapper) {
      widthCandidates.push(this.wrapper.clientWidth);
      heightCandidates.push(this.wrapper.clientHeight);
      if (typeof this.wrapper.getBoundingClientRect === 'function') {
        const rect = this.wrapper.getBoundingClientRect();
        widthCandidates.push(rect?.width);
        heightCandidates.push(rect?.height);
      }
    }

    const resolveDimension = (candidates, fallback) => {
      for (const value of candidates) {
        if (Number.isFinite(value) && value > 0) return value;
      }
      return fallback;
    };

    const fallbackHeight = Number.isFinite(this.minHeight) && this.minHeight > 0
      ? this.minHeight
      : (Number.isFinite(this.height) && this.height > 0
        ? this.height
        : (Number.isFinite(this.defaultHeight) ? this.defaultHeight : DEFAULT_HEIGHT));

    const width = resolveDimension(widthCandidates, this.minWidth);
    const height = resolveDimension(heightCandidates, fallbackHeight);

    return { width, height };
  }

  parsePayload(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const timestamps = Array.isArray(payload.timestamps) ? payload.timestamps : [];
    const rawSeries = Array.isArray(payload.series) ? payload.series : [];
    const fallbackValues = Array.isArray(payload.values) ? payload.values : [];

    const normalizeSeries = (entry, index = 0) => {
      const values = Array.isArray(entry?.values) ? entry.values : [];
      const length = timestamps.length ? Math.min(values.length, timestamps.length) : values.length;
      if (!length) return null;

      const points = [];
      for (let pos = 0; pos < length; pos += 1) {
        const numeric = toNumber(values[pos]);
        if (!Number.isFinite(numeric)) continue;
        const timestamp = pos < timestamps.length ? timestamps[pos] : null;
        points.push({ step: pos + 1, value: numeric, timestamp: timestamp ?? null });
      }
      if (!points.length) return null;

      const key = typeof entry?.key === 'string' && entry.key.trim() ? entry.key.trim() : `series_${index + 1}`;
      const labelCandidate = typeof entry?.label === 'string' && entry.label.trim()
        ? entry.label.trim()
        : (typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : '');
      const label = labelCandidate || key;
      const columnIndexValue = entry?.columnIndex ?? entry?.column_index;
      const columnIndex = parseNonNegativeInteger(columnIndexValue);

      return { key, label, columnIndex, points };
    };

    const normalizedSeries = [];
    rawSeries.forEach((entry, idx) => {
      const normalized = normalizeSeries(entry, idx);
      if (normalized) normalizedSeries.push(normalized);
    });

    if (!normalizedSeries.length && fallbackValues.length) {
      const fallback = normalizeSeries(
        { values: fallbackValues, key: 'series_1', label: typeof payload.label === 'string' ? payload.label : null, columnIndex: payload.columnIndex ?? payload.column_index ?? null },
        0
      );
      if (fallback) normalizedSeries.push(fallback);
    }

    const subjectSelection = normalizeSubjectSelection(this.options?.subjects);
    if (subjectSelection.length > 1 && normalizedSeries.length) {
      const filtered = normalizedSeries.filter(entry => {
        const subjectId = extractSubjectIdFromSeries(entry);
        if (!subjectId) return false;
        return subjectSelection.includes(subjectId);
      });
      if (filtered.length) {
        const maxDataPoints = filtered.reduce((max, series) => Math.max(max, series.points?.length ?? 0), 0);
        if (maxDataPoints > 0) {
          const projectName = this.options?.projectName || null;
          const sheetId = this.options?.sheetId || null;
          const chartId = this.chartId || null;
          if (projectName) {
            document.dispatchEvent(new CustomEvent('time-controls:runtime-timesteps', {
              detail: { projectName, sheetId, chartId, timesteps: maxDataPoints },
            }));
          }
        }
        return filtered;
      }
    }

    return normalizedSeries;
  }

  showStatus(message, variant = 'info') {
    if (!this.statusEl) return;
    this.statusEl.textContent = message || '';
    this.statusEl.dataset.variant = variant;
    this.statusEl.style.display = message ? 'block' : 'none';
    if (this.svg) this.svg.style.display = message ? 'none' : 'block';
    if (this.legendEl) { this.legendEl.style.display = 'none'; this.legendEl.innerHTML = ''; }
    if (this.tooltipEl) this.tooltipEl.style.display = 'none';
  }

  hideStatus() {
    if (this.statusEl) { this.statusEl.textContent = ''; this.statusEl.style.display = 'none'; delete this.statusEl.dataset.variant; }
    if (this.svg) this.svg.style.display = 'block';
  }

  clearChart() {
    if (!this.svg) return;
    // Preserve guide line and intersection points during clear
    d3.select(this.svg).selectAll('*').filter(function() {
      return !this.classList.contains('line-chart__guide-line') &&
             !this.classList.contains('line-chart__intersection-points') &&
             !this.classList.contains('line-chart__time-cursor-line');
    }).remove();
    if (this.legendEl) { this.legendEl.innerHTML = ''; this.legendEl.style.display = 'none'; }
    if (this.tooltipEl) this.tooltipEl.style.display = 'none';

    this.focusDomain = null;
    this.focusContentGroup = null;
    this.focusAxesGroup = null;
    this.focusForegroundGroup = null;
    this.contextGroup = null;
    this.contextForegroundGroup = null;
    this.focusClipId = null;
    this.xFocus = null;
    this.xContext = null;
    this.yScaleFocus = null;
    this.yScaleContext = null;
    this.colorScale = null;
    this.lineGenerator = null;
    this.series = [];
    this.brush = null;
    this.contextBrush = null;
    if (this.legendItems) this.legendItems.clear();
    this.activeSeriesKey = null;
    this.timeCursorLine = null;
    this.contextTimeCursorLine = null;
    this.timeCursorFocusPoints = null;
    this.timeCursorContextPoints = null;
    this.orderedSteps = [];
    this.stepIndexLookup = new Map();
    this.filteredOrderedSteps = [];
    this.guideLine = null;
    this.intersectionPoints = null;
    this.globalOrderedSteps = [];
    this.globalStepIndexLookup = new Map();
    this._latestPointerInfo = null;
    this.appliedStepRange = null;
    this._rawTotalPoints = 0;
    this._drawPointsPreference = null;
    this.aggregateEnvelope = null;
    this.aggregateAvailable = false;
    this.aggregateModeActive = false;
    this._lastSelectionActive = false;
  }

  renderChart() {
    if (!this.svg) return;
    const rawSeries = Array.isArray(this.state.series) ? this.state.series : [];

    const rawTotalPoints = rawSeries.reduce((sum, entry) => {
      const points = Array.isArray(entry?.points) ? entry.points : [];
      return sum + points.length;
    }, 0);
    this._rawTotalPoints = rawTotalPoints;
    this._drawPointsPreference = rawSeries.length
      ? rawTotalPoints <= MAX_POINTS_FOR_CIRCLES_TOTAL
      : null;

    const globalOrderedSteps = collectOrderedSteps(rawSeries);
    this.globalOrderedSteps = globalOrderedSteps;
    this.globalStepIndexLookup = new Map(globalOrderedSteps.map((stepValue, index) => [stepValue, index]));

    const { series: filteredSeries, appliedRange } = this.filterSeriesByActiveRange(rawSeries);
    const usingFilteredRange = !!this.activeTimeRange;
    this.appliedStepRange = appliedRange;

    if (usingFilteredRange && rawSeries.length && (!Array.isArray(filteredSeries) || !filteredSeries.length)) {
      this.clearChart();
      this.showStatus('No data available in the selected time range.');
      this.emitUiState({ selectionActive: false, aggregateAvailable: false, aggregateActive: false });
      return;
    }

    const seriesForChart = Array.isArray(filteredSeries) && filteredSeries.length ? filteredSeries : rawSeries;

    const hasMultipleSeries = Array.isArray(seriesForChart) && seriesForChart.length > 1;
    this.aggregateAvailable = hasMultipleSeries;
    if (!hasMultipleSeries && this.aggregateModeActive) {
      this.aggregateModeActive = false;
    }

    let chartSeries = seriesForChart;
    this.aggregateEnvelope = null;
    if (this.aggregateModeActive && hasMultipleSeries) {
      const { meanSeries, envelope } = computeAggregateSeries(seriesForChart);
      if (meanSeries.length) {
        chartSeries = meanSeries;
        this.aggregateEnvelope = envelope;
      } else {
        this.aggregateModeActive = false;
      }
    }

    this.emitUiState({ aggregateAvailable: this.aggregateAvailable, aggregateActive: this.aggregateModeActive });

    const { width: measuredWidth, height: measuredHeight } = this.getContainerDimensions();
    const width = Math.max(this.minWidth, measuredWidth);
    const height = Math.max(0, measuredHeight);
    this.height = height;
    const margins = getEffectiveMargins(height);
    const innerWidth = Math.max(0, width - margins.left - margins.right);
    const innerHeight = Math.max(0, height - margins.top - margins.bottom);

    const { focusHeight, contextHeight, gap: verticalGap } = computeLayoutHeights(innerHeight);

    const chartState = buildChartState(chartSeries, innerWidth, focusHeight, contextHeight);
    if (!chartState) {
      this.clearChart();
      this.emitUiState({ selectionActive: false, aggregateAvailable: this.aggregateAvailable, aggregateActive: this.aggregateModeActive });
      return;
    }

    const { series, xFocus, xContext, yScale, colorScale, line, orderedSteps } = chartState;
    const yScaleFocus = yScale;
    const yScaleContext = yScale.copy().range([contextHeight, 0]);
    const tickValues = computeStepTickValues(xFocus);

    const root = d3.select(this.svg);
    root.attr('width', width).attr('height', height);
    root.selectAll('*').remove();
    this.timeCursorLine = null;
    this.contextTimeCursorLine = null;
    this.timeCursorFocusPoints = null;
    this.timeCursorContextPoints = null;
    this.guideLine = null;
    this.intersectionPoints = null;

    const clipIdSuffix = Math.random().toString(36).slice(2);
    const focusClipId = `line-chart__focus-clip-${clipIdSuffix}`;
    const contextClipId = `line-chart__context-clip-${clipIdSuffix}`;

    const defs = root.append('defs');
    defs.append('clipPath').attr('id', focusClipId).append('rect').attr('width', innerWidth).attr('height', focusHeight);
    defs.append('clipPath').attr('id', contextClipId).append('rect').attr('width', innerWidth).attr('height', contextHeight);

  const rootGroup = root.append('g').attr('class', 'line-chart__root-group').attr('transform', `translate(${margins.left},${margins.top})`);

    const focusGroup = rootGroup.append('g').attr('class', 'line-chart__group line-chart__group--focus').attr('transform', 'translate(0,0)');
    const contextGroup = rootGroup.append('g').attr('class', 'line-chart__group line-chart__group--context').attr('transform', `translate(0,${focusHeight + verticalGap})`);
    const focusContentGroup = focusGroup.append('g').attr('class', 'line-chart__content line-chart__content--focus');
    const focusAxesGroup = focusGroup.append('g').attr('class', 'line-chart__axes-layer line-chart__axes-layer--focus');
    // Create a foreground group for time cursor to ensure it's on top
    const focusForegroundGroup = focusGroup.append('g').attr('class', 'line-chart__foreground line-chart__foreground--focus');

    const previousFocusDomain = Array.isArray(this.focusDomain) ? [...this.focusDomain] : null;

    this.focusContentGroup = focusContentGroup;
    this.focusAxesGroup = focusAxesGroup;
    this.focusForegroundGroup = focusForegroundGroup;
    this.contextGroup = contextGroup;
    this.contextForegroundGroup = null;
    this.focusClipId = focusClipId;
    this.xFocus = xFocus;
    this.xContext = xContext;
    this.yScaleFocus = yScaleFocus;
    this.yScaleContext = yScaleContext;
    this.colorScale = colorScale;
    this.lineGenerator = line;
    this.series = series;
    this.filteredOrderedSteps = Array.isArray(orderedSteps) ? orderedSteps : [];
    this.orderedSteps = Array.isArray(this.globalOrderedSteps) ? this.globalOrderedSteps : [];
    this.stepIndexLookup = this.globalStepIndexLookup instanceof Map ? this.globalStepIndexLookup : new Map();
    this._latestPointerInfo = null;

    const contextDomain = xContext.domain();
    const contextStart = Math.min(contextDomain[0], contextDomain[1]);
    const contextEnd = Math.max(contextDomain[0], contextDomain[1]);
    const defaultFocusDomain = xFocus.domain();
    let desiredDomain = [...defaultFocusDomain];
    let brushSelection = null;
    let clearBrushOnInit = false;
    
    // Calculate initial window (first 10% or max 10,000 points)
    const totalPoints = series.reduce((s, e) => s + (e.points?.length || 0), 0);
    const initialWindowSize = Math.min(10000, Math.round(totalPoints * 0.1));
    const initialEnd = Math.min(contextStart + initialWindowSize, contextEnd);
    
    if (usingFilteredRange) {
      // After applying TimeRangeFilter, the filtered domain becomes the new full domain.
      // Show the full filtered domain in focus and clear the overview brush overlay.
      desiredDomain = [contextStart, contextEnd];
      brushSelection = null;
      clearBrushOnInit = true;
    } else if (previousFocusDomain && previousFocusDomain.length === 2) {
      const previousStart = Math.min(previousFocusDomain[0], previousFocusDomain[1]);
      const previousEnd = Math.max(previousFocusDomain[0], previousFocusDomain[1]);
      const clampedStart = Math.max(previousStart, contextStart);
      const clampedEnd = Math.min(previousEnd, contextEnd);
      if (Number.isFinite(clampedStart) && Number.isFinite(clampedEnd) && clampedEnd >= clampedStart) {
        desiredDomain = [clampedStart, clampedEnd];
        const matchesDefault = Math.abs(clampedStart - defaultFocusDomain[0]) < 1e-6 && Math.abs(clampedEnd - defaultFocusDomain[1]) < 1e-6;
        if (!matchesDefault) {
          const candidateSelection = desiredDomain.map(v => xContext(v));
          if (Array.isArray(candidateSelection) && candidateSelection.length === 2) brushSelection = candidateSelection;
        }
      }
    } else {
      // Set initial window to first 10% or 10,000 points
      desiredDomain = [contextStart, initialEnd];
      brushSelection = [xContext(contextStart), xContext(initialEnd)];
    }

    if (!this._defaultFocusDomain && Array.isArray(desiredDomain) && desiredDomain.length === 2) {
      this._defaultFocusDomain = [...desiredDomain];
    }
    this.focusDomain = null;
    this.updateFocusDomain(desiredDomain);

    const shouldDrawPoints = this.shouldDrawPoints();
    const drawPointsFocus = shouldDrawPoints;
    const drawPointsContext = shouldDrawPoints;

    const { brush, contextBrush, foregroundGroup: contextForegroundGroup } = renderContextView({
      contextGroup,
      series,
      line,
      xContext,
      yScale: yScaleContext,
      colorScale,
      clipId: contextClipId,
      tickValues,
      onBrush: domain => this.updateFocusDomain(domain),
      isSuppressed: () => this._suppressBrush,
      drawPoints: drawPointsContext,
      settingsState: this.settingsState,
      selectionFilter: this.activePointSelection,
      clusterState: this.activeClusterFilter,
      envelope: this.aggregateEnvelope,
    });

    this.brush = brush;
    this.contextBrush = contextBrush;
    this.contextForegroundGroup = contextForegroundGroup || null;

    if (this.contextBrush && this.brush) {
      let moved = false;

      // If the current focus domain equals the full context domain, clear the brush.
      const domainNow = this.xContext.domain();
      const cStartNow = Math.min(domainNow[0], domainNow[1]);
      const cEndNow = Math.max(domainNow[0], domainNow[1]);
      const isFullRangeNow =
        Array.isArray(this.focusDomain) &&
        Math.abs(this.focusDomain[0] - cStartNow) < 1e-6 &&
        Math.abs(this.focusDomain[1] - cEndNow) < 1e-6;

      if (clearBrushOnInit || isFullRangeNow) {
        this._suppressBrush = true;
        this.contextBrush.call(this.brush.move, null); // Clear overlay
        this._suppressBrush = false;
        moved = true;
      }

      if (!moved && Array.isArray(brushSelection) && brushSelection.length === 2) {
        const selectionStart = Math.min(brushSelection[0], brushSelection[1]);
        const selectionEnd = Math.max(brushSelection[0], brushSelection[1]);
        if (Number.isFinite(selectionStart) && Number.isFinite(selectionEnd) && selectionEnd > selectionStart) {
          this._suppressBrush = true;
          this.contextBrush.call(this.brush.move, [selectionStart, selectionEnd]);
          this._suppressBrush = false;
          moved = true;
        }
      }
      if (!moved) {
        const range = xContext.range();
        if (Array.isArray(range) && range.length === 2) {
          this._suppressBrush = true;
          this.contextBrush.call(this.brush.move, range);
          this._suppressBrush = false;
        }
      }
    }

    const showLegend = this.options.showLegend ?? true;
    if (this.legendEl) {
      this.legendEl.innerHTML = '';
      if (showLegend) {
        const fragment = document.createDocumentFragment();
        if (this.legendItems) this.legendItems.clear();
        series.forEach(entry => {
          const item = document.createElement('div');
          item.className = 'line-chart__legend-item flex items-center gap-2';
          item.dataset.seriesKey = entry.key;

          const swatch = document.createElement('span');
          swatch.className = 'inline-block h-2.5 w-2.5 rounded-full';
          swatch.style.backgroundColor = colorScale(entry.key);

          const label = document.createElement('span');
          label.className = 'whitespace-nowrap';
          // Apply subject name mapping if project name is available
          const projectName = this.options.projectName || this.configuration?.projectName || null;
          const mappedLabel = applySubjectNameMapping(entry.label || entry.key, entry.key, projectName);
          label.textContent = mappedLabel;

          item.append(swatch, label);
          fragment.append(item);
          if (this.legendItems) this.legendItems.set(entry.key, item);
        });
        this.legendEl.append(fragment);
        this.legendEl.style.display = 'flex';
      } else {
        this.legendEl.style.display = 'none';
      }
    }

    renderFocusView({
      focusGroup: this.focusContentGroup,
      axesGroup: this.focusAxesGroup,
      series: this.series,
      line: this.lineGenerator,
      xFocus: this.xFocus,
      yScale: this.yScaleFocus,
      colorScale: this.colorScale,
      clipId: this.focusClipId,
      tickValues,
      drawPoints: drawPointsFocus,
      settingsState: this.settingsState,
      selectionFilter: this.activePointSelection,
      clusterState: this.activeClusterFilter,
      envelope: this.aggregateEnvelope,
    });
    this.ensureTimeCursorLine();
    this.updateTimeCursorIndicator();
    this.bindFocusInteractions();
  }

  getOrCreateTooltip() {
    if (!this.wrapper) return null;
    if (!this.tooltipEl) {
      const tooltip = document.createElement('div');
      tooltip.className = 'line-chart__tooltip pointer-events-none absolute z-20 rounded-md bg-gray-900/90 px-3 py-2 text-xs text-white shadow-lg';
      tooltip.style.display = 'none';
      tooltip.style.maxWidth = '260px';
      tooltip.style.lineHeight = '1.4';
      this.wrapper.append(tooltip);
      this.tooltipEl = tooltip;
    }
    return this.tooltipEl;
  }

  hideTooltip() {
    if (this.tooltipEl) this.tooltipEl.style.display = 'none';
  }

  positionTooltip(tooltip, event) {
    if (!tooltip || !event || !this.wrapper) return;
    const wrapperRect = this.wrapper.getBoundingClientRect();
    const pointerX = event.clientX - wrapperRect.left;
    const pointerY = event.clientY - wrapperRect.top;
    tooltip.style.display = 'block';
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;

    let left = pointerX + 16;
    if (left + tooltipWidth > wrapperRect.width) left = Math.max(pointerX - tooltipWidth - 16, 0);

    let top = pointerY - tooltipHeight - 16;
    if (top < 0) top = Math.min(pointerY + 16, wrapperRect.height - tooltipHeight);

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  // TOOLTIP: do NOT show date/time, only Step + values
  updateFocusTooltip(step, nearestEntries, activeKey, event) {
    const tooltip = this.getOrCreateTooltip();
    if (!tooltip) return;

    tooltip.innerHTML = '';

    if (!Number.isFinite(step) || !Array.isArray(nearestEntries) || !nearestEntries.length) {
      this.hideTooltip();
      return;
    }

    const header = document.createElement('div');
    header.className = 'line-chart__tooltip-step mb-1 font-semibold';

    // Check if we should show time instead of step
    const recordingDuration = this.settingsState?.recordingDuration;
    const selectedTimesteps = this.settingsState?.selected;

    if (Number.isFinite(recordingDuration) && recordingDuration > 0 &&
        Number.isInteger(selectedTimesteps) && selectedTimesteps > 0) {
      // Convert step to seconds
      const maxIndex = Math.max(selectedTimesteps - 1, 1);
      const clampedValue = Math.min(Math.max(step, 0), maxIndex);
      const seconds = (clampedValue / maxIndex) * recordingDuration;

      // Format based on scale
      if (seconds >= 60) {
        const minutes = seconds / 60;
        header.textContent = `${minutes.toFixed(1)}m`;
      } else {
        const maxFractionDigits = seconds >= 10 ? 1 : 2;
        header.textContent = `${seconds.toFixed(maxFractionDigits)}s`;
      }
    } else {
      header.textContent = `Step ${STEP_FORMATTER(step)}`;
    }

    tooltip.append(header);

    const list = document.createElement('div');
    list.className = 'line-chart__tooltip-series flex flex-col gap-1';

    nearestEntries.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'line-chart__tooltip-row flex items-center justify-between gap-4';
      if (entry?.series?.key === activeKey) row.classList.add('is-active', 'font-semibold');

      const labelGroup = document.createElement('div');
      labelGroup.className = 'flex items-center gap-2';

      const swatch = document.createElement('span');
      swatch.className = 'inline-block h-2 w-2 rounded-full';
      if (this.colorScale && entry?.series?.key) swatch.style.backgroundColor = this.colorScale(entry.series.key);

      const label = document.createElement('span');
      label.textContent = entry?.series?.label || entry?.series?.key || '';
      labelGroup.append(swatch, label);

      const value = document.createElement('span');
      value.className = 'tabular-nums';
      value.textContent = formatTooltipValue(entry?.point?.value);

      row.append(labelGroup, value);
      list.append(row);
    });

    tooltip.append(list);
    this.positionTooltip(tooltip, event);
  }

  applySeriesHighlight(activeKey, activePoint = null) {
    if (this.focusContentGroup) {
      const focusSelection = typeof this.focusContentGroup.selectAll === 'function' ? this.focusContentGroup : d3.select(this.focusContentGroup);

      focusSelection.selectAll('.line-chart__path--focus')
        .attr('stroke-width', d => (activeKey && d.key === activeKey ? 2.5 : 2))
        .attr('opacity', 1);

      const pointGroups = focusSelection.selectAll('.line-chart__points--focus')
        .attr('opacity', 1);

      pointGroups.selectAll('circle')
        .attr('r', function (d) {
          const parentData = d3.select(this.parentNode).datum();
          return activeKey && parentData?.key === activeKey && activePoint && Math.abs(d.step - activePoint.step) < 1e-6 ? 5 : 3;
        })
        .attr('stroke', function (d) {
          const parentData = d3.select(this.parentNode).datum();
          return activeKey && parentData?.key === activeKey && activePoint && Math.abs(d.step - activePoint.step) < 1e-6 ? '#ffffff' : 'none';
        })
        .attr('stroke-width', function (d) {
          const parentData = d3.select(this.parentNode).datum();
          return activeKey && parentData?.key === activeKey && activePoint && Math.abs(d.step - activePoint.step) < 1e-6 ? 1.5 : 0;
        });
    }

    if (this.legendItems && this.legendItems.size) {
      this.legendItems.forEach((node, key) => {
        if (!node) return;
        if (!activeKey) {
          node.style.opacity = '';
          node.classList.remove('is-active');
        } else if (key === activeKey) {
          node.style.opacity = '';
          node.classList.add('is-active');
        } else {
          node.style.opacity = '';
          node.classList.remove('is-active');
        }
      });
    }

    this.activeSeriesKey = activeKey || null;
  }

  bindFocusInteractions() {
    if (!this.xFocus) return;
    const root = this.focusContentGroup || this.focusAxesGroup || null;
    if (!root) return;

    const groupSel = typeof root.select === 'function' ? root : d3.select(root);
    let overlay = groupSel.select('.line-chart__focus-overlay');
    if (overlay.empty() && root.parentNode) overlay = d3.select(root.parentNode).select('.line-chart__focus-overlay');
    if (overlay.empty()) return;

    overlay
      .on('pointermove', (event) => this.handleFocusPointerMove(event))
      .on('pointerdown', (event) => this.handleFocusPointerDown(event))
      .on('pointerleave', () => this.handleFocusPointerLeave())
      .attr('tabindex', 0)
      .on('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        if (!this.xFocus) return;
        const delta = event.key === 'ArrowLeft' ? -1 : 1;
        const domain = this.xFocus.domain().slice().sort((a, b) => a - b);
        const center = Math.round((domain[0] + domain[1]) / 2);
        this._kbdStep = (this._kbdStep ?? center) + delta;
        const x = this.xFocus(this._kbdStep);
        const rect = this.wrapper.getBoundingClientRect();
        const fake = { clientX: rect.left + x, clientY: rect.top, currentTarget: overlay.node() };
        this.handleFocusPointerMove(fake);
        event.preventDefault();
      });
  }

  handleFocusPointerMove(event) {
    if (!event || !this.xFocus || !Array.isArray(this.series) || !this.series.length) return;
    const target = event.currentTarget || this.focusContentGroup;
    const [pointerX] = d3.pointer(event, target);

    this._latestPointerInfo = null;
    
    // Initialize guide line and intersection points group
    const guideLineMissing = !this.guideLine
      || typeof this.guideLine.node !== 'function'
      || !this.guideLine.node();
    if (guideLineMissing) {
      this.guideLine = this.focusContentGroup.append('line')
        .attr('class', 'line-chart__guide-line')
        .attr('stroke', '#666')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2,2')
        .attr('y1', 0)
        .attr('y2', this.yScaleFocus.range()[0])
        .style('pointer-events', 'none');
    }
    const intersectionMissing = !this.intersectionPoints
      || typeof this.intersectionPoints.node !== 'function'
      || !this.intersectionPoints.node();
    if (intersectionMissing) {
      this.intersectionPoints = this.focusContentGroup.append('g')
        .attr('class', 'line-chart__intersection-points');
    }
    
    // Update guide line position
    this.guideLine.attr('x1', pointerX).attr('x2', pointerX);
    
    const range = this.xFocus.range();
    const minX = Math.min(range[0], range[1]);
    const maxX = Math.max(range[0], range[1]);
    if (!Number.isFinite(pointerX) || pointerX < minX || pointerX > maxX) { this.handleFocusPointerLeave(); return; }
    const candidateStep = this.xFocus.invert(pointerX);
    if (!Number.isFinite(candidateStep)) { this.handleFocusPointerLeave(); return; }

    const orderedSteps = Array.isArray(this.orderedSteps) ? this.orderedSteps : [];
    if (!orderedSteps.length) { this.handleFocusPointerLeave(); return; }
    
    // Update intersection points
    const intersectionPoints = this.intersectionPoints.selectAll('circle')
      .data(this.series, d => d.key);
    
    intersectionPoints.join(
      enter => enter.append('circle')
        .attr('class', 'line-chart__intersection-point')
        .attr('r', 4)
        .attr('fill', d => this.colorScale(d.key))
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5),
      update => update
        .attr('cx', d => {
          const nearestPoint = findNearestPoint(d.points, candidateStep);
          return nearestPoint ? this.xFocus(nearestPoint.step) : -100;
        })
        .attr('cy', d => {
          const nearestPoint = findNearestPoint(d.points, candidateStep);
          return nearestPoint ? this.yScaleFocus(nearestPoint.value) : -100;
        }),
      exit => exit.remove()
    );

    const nearestEntries = [];
    this.series.forEach(seriesEntry => {
      const nearestPoint = findNearestPoint(seriesEntry.points, candidateStep);
      if (!nearestPoint) return;
      nearestEntries.push({ series: seriesEntry, point: nearestPoint, distance: Math.abs(nearestPoint.step - candidateStep) });
    });
    if (!nearestEntries.length) { this.handleFocusPointerLeave(); return; }

    nearestEntries.sort((a, b) => (a.distance === b.distance ? (a.series?.key || '').localeCompare(b.series?.key || '') : a.distance - b.distance));

    const activeEntry = nearestEntries[0];
    if (!activeEntry?.series || !activeEntry.point) { this.handleFocusPointerLeave(); return; }

    const stepValue = activeEntry.point.step;
    if (!Number.isFinite(stepValue)) { this.handleFocusPointerLeave(); return; }

    let pointerInfo = null;
    if (this.stepIndexLookup && this.stepIndexLookup.has(stepValue)) {
      const index = this.stepIndexLookup.get(stepValue);
      if (Number.isInteger(index)) pointerInfo = { index, value: stepValue };
    }
    if (!pointerInfo) {
      pointerInfo = findNearestStepIndex(orderedSteps, stepValue) || findNearestStepIndex(orderedSteps, candidateStep);
    }
    if (pointerInfo) {
      this._latestPointerInfo = pointerInfo;
    }

    this.updateFocusTooltip(activeEntry.point.step, nearestEntries, activeEntry.series.key, event);
    this.applySeriesHighlight(activeEntry.series.key, activeEntry.point);
  }

  handleFocusPointerLeave() {
    this.hideTooltip();
    this.applySeriesHighlight(null, null);
    if (this.guideLine && typeof this.guideLine.attr === 'function') {
      this.guideLine.attr('x1', -100).attr('x2', -100);
    }
    if (this.intersectionPoints && typeof this.intersectionPoints.selectAll === 'function') {
      this.intersectionPoints.selectAll('circle')
        .attr('cx', -100)
        .attr('cy', -100);
    }
    this._latestPointerInfo = null;
  }

  handleFocusPointerDown(event) {
    if (!event) return;
    const isLeftClick = event.button === undefined || event.button === 0;
    if (!isLeftClick) return;

    if (!this._latestPointerInfo) {
      this.handleFocusPointerMove(event);
    }

    const info = this._latestPointerInfo;
    if (!info || !Number.isInteger(info.index)) return;

    try {
      if (typeof pauseTimeCursor === 'function') {
        pauseTimeCursor();
      }
      if (typeof setTimeCursorIndex === 'function') {
        setTimeCursorIndex(info.index);
      }
    } catch (error) {
      console.error('[LineChart] Failed to update time cursor from chart interaction', error);
    }

    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
  }

  ensureTimeCursorLine() {
    if (this.focusForegroundGroup) {
      if (this.timeCursorLine && typeof this.timeCursorLine.node === 'function' && this.timeCursorLine.node()) {
        // Keep existing focus line reference
      } else {
        const existing = this.focusForegroundGroup.select('.line-chart__time-cursor-line--focus');
        if (!existing.empty()) {
          this.timeCursorLine = existing;
        } else {
          this.timeCursorLine = this.focusForegroundGroup.append('line')
            .attr('class', 'line-chart__time-cursor-line line-chart__time-cursor-line--focus')
            .attr('stroke', '#2563eb')
            .attr('stroke-width', 1.5)
            .attr('pointer-events', 'none')
            .attr('opacity', 0);
        }
      }

      // Ensure focus intersection points group
      if (!this.timeCursorFocusPoints || typeof this.timeCursorFocusPoints.node !== 'function' || !this.timeCursorFocusPoints.node()) {
        const existingPoints = this.focusForegroundGroup.select('.line-chart__time-cursor-points--focus');
        if (!existingPoints.empty()) {
          this.timeCursorFocusPoints = existingPoints;
        } else {
          this.timeCursorFocusPoints = this.focusForegroundGroup.append('g')
            .attr('class', 'line-chart__time-cursor-points line-chart__time-cursor-points--focus')
            .attr('pointer-events', 'none');
        }
      }
    } else {
      this.timeCursorLine = null;
      this.timeCursorFocusPoints = null;
    }

    if (this.contextForegroundGroup) {
      if (!this.contextTimeCursorLine || typeof this.contextTimeCursorLine.node !== 'function' || !this.contextTimeCursorLine.node()) {
        const existingContext = this.contextForegroundGroup.select('.line-chart__time-cursor-line--context');
        if (!existingContext.empty()) {
          this.contextTimeCursorLine = existingContext;
        } else {
          this.contextTimeCursorLine = this.contextForegroundGroup.append('line')
            .attr('class', 'line-chart__time-cursor-line line-chart__time-cursor-line--context')
            .attr('stroke', '#2563eb')
            .attr('stroke-width', 1)
            .attr('pointer-events', 'none')
            .attr('opacity', 0);
        }
      }

      // Ensure context intersection points group
      if (!this.timeCursorContextPoints || typeof this.timeCursorContextPoints.node !== 'function' || !this.timeCursorContextPoints.node()) {
        const existingPoints = this.contextForegroundGroup.select('.line-chart__time-cursor-points--context');
        if (!existingPoints.empty()) {
          this.timeCursorContextPoints = existingPoints;
        } else {
          this.timeCursorContextPoints = this.contextForegroundGroup.append('g')
            .attr('class', 'line-chart__time-cursor-points line-chart__time-cursor-points--context')
            .attr('pointer-events', 'none');
        }
      }
    } else {
      this.contextTimeCursorLine = null;
      this.timeCursorContextPoints = null;
    }

    return this.timeCursorLine;
  }

  handleTimeCursorUpdate(state) {
    this.timeCursorState = state || null;
    this.updateTimeCursorIndicator();
  }

  attachTimeCursorSubscription() {
    if (this.timeCursorUnsubscribe || typeof subscribeToTimeCursor !== 'function') {
      if (!this.timeCursorState && typeof getTimeCursorState === 'function') {
        try {
          this.handleTimeCursorUpdate(getTimeCursorState());
        } catch (error) {
          console.error('[LineChart] Failed to read time cursor state', error);
        }
      }
      return;
    }

    try {
      this.timeCursorUnsubscribe = subscribeToTimeCursor(this.handleTimeCursorUpdate);
    } catch (error) {
      console.error('[LineChart] Failed to subscribe to time cursor updates', error);
      this.timeCursorUnsubscribe = null;
    }

    if (!this.timeCursorState && typeof getTimeCursorState === 'function') {
      try {
        this.handleTimeCursorUpdate(getTimeCursorState());
      } catch (error) {
        console.error('[LineChart] Failed to read time cursor state', error);
      }
    }
  }

  detachTimeCursorSubscription() {
    if (typeof this.timeCursorUnsubscribe === 'function') {
      try {
        this.timeCursorUnsubscribe();
      } catch (error) {
        console.error('[LineChart] Failed to detach time cursor subscription', error);
      }
    }
    this.timeCursorUnsubscribe = null;
    this.timeCursorState = null;
  }

  attachSettingsSubscription() {
    if (this.settingsUnsubscribe || typeof subscribeToSettings !== 'function') {
      return;
    }

    try {
      this.settingsUnsubscribe = subscribeToSettings(this.handleSettingsUpdate.bind(this));
    } catch (error) {
      console.error('[LineChart] Failed to subscribe to settings updates', error);
      this.settingsUnsubscribe = null;
    }
  }

  detachSettingsSubscription() {
    if (typeof this.settingsUnsubscribe === 'function') {
      try {
        this.settingsUnsubscribe();
      } catch (error) {
        console.error('[LineChart] Failed to detach settings subscription', error);
      }
    }
    this.settingsUnsubscribe = null;
    this.settingsState = null;
  }

  handleSettingsUpdate(state) {
    this.settingsState = state || null;
    if (this.isMounted && this.state.series?.length) {
      this.renderChart();
    }
  }

  attachTimeRangeFilterSubscription() {
    this.detachTimeRangeFilterSubscription();
    if (!this.sheetId || typeof subscribeToTimeRangeFilter !== 'function') {
      this.activeTimeRange = null;
      this.appliedStepRange = null;
      return;
    }

    try {
      this.timeRangeUnsubscribe = subscribeToTimeRangeFilter(this.sheetId, this.handleTimeRangeFilterUpdate);
    } catch (error) {
      console.error('[LineChart] Failed to subscribe to time range filter updates', error);
      this.timeRangeUnsubscribe = null;
    }

    if (!this.activeTimeRange && typeof getActiveTimeRangeDomain === 'function') {
      try {
        this.handleTimeRangeFilterUpdate(getActiveTimeRangeDomain(this.sheetId));
      } catch (error) {
        console.error('[LineChart] Failed to read time range filter state', error);
      }
    }
  }

  detachTimeRangeFilterSubscription() {
    if (typeof this.timeRangeUnsubscribe === 'function') {
      try {
        this.timeRangeUnsubscribe();
      } catch (error) {
        console.error('[LineChart] Failed to detach time range filter subscription', error);
      }
    }
    this.timeRangeUnsubscribe = null;
    this.activeTimeRange = null;
    this.appliedStepRange = null;
  }

  handleTimeRangeFilterUpdate(domain) {
    let nextRange = null;
    if (domain && Number.isInteger(domain.domainStartIndex) && Number.isInteger(domain.domainEndIndex)) {
      const start = Math.min(domain.domainStartIndex, domain.domainEndIndex);
      const end = Math.max(domain.domainStartIndex, domain.domainEndIndex);
      nextRange = { startIndex: start, endIndex: end };
    }

    const changed = !(
      (!this.activeTimeRange && !nextRange)
      || (this.activeTimeRange
        && nextRange
        && this.activeTimeRange.startIndex === nextRange.startIndex
        && this.activeTimeRange.endIndex === nextRange.endIndex)
    );

    this.activeTimeRange = nextRange;
    if (changed) {
      this.appliedStepRange = null;
      this._defaultFocusDomain = null;
      if (this.isMounted && this.state.series?.length) {
        this.renderChart();
        this.updateTimeCursorIndicator();
      }
    }
  }

  attachPointSelectionSubscription() {
    this.detachPointSelectionSubscription();
    if (!this.sheetId || typeof subscribeToPointSelection !== 'function') {
      this.activePointSelection = null;
      return;
    }

    try {
      this.pointSelectionUnsubscribe = subscribeToPointSelection(this.sheetId, this.handlePointSelectionUpdate);
    } catch (error) {
      console.error('[LineChart] Failed to subscribe to point selection updates', error);
      this.pointSelectionUnsubscribe = null;
    }

    if (!this.activePointSelection && typeof getPointSelection === 'function') {
      try {
        this.handlePointSelectionUpdate(getPointSelection(this.sheetId));
      } catch (error) {
        console.error('[LineChart] Failed to read point selection state', error);
      }
    }
  }

  detachPointSelectionSubscription() {
    if (typeof this.pointSelectionUnsubscribe === 'function') {
      try {
        this.pointSelectionUnsubscribe();
      } catch (error) {
        console.error('[LineChart] Failed to detach point selection subscription', error);
      }
    }
    this.pointSelectionUnsubscribe = null;
    this.activePointSelection = null;
  }

  handlePointSelectionUpdate(selection) {
    // selection is a Set<number> or null
    const nextSelection = selection instanceof Set && selection.size > 0 ? selection : null;
    
    // Check if selection actually changed
    const changed = !(
      (!this.activePointSelection && !nextSelection)
      || (this.activePointSelection instanceof Set
        && nextSelection instanceof Set
        && this.activePointSelection.size === nextSelection.size
        && Array.from(this.activePointSelection).every(idx => nextSelection.has(idx)))
    );

    this.activePointSelection = nextSelection;
    
    if (changed && this.isMounted && this.state.series?.length) {
      // Re-render the chart to apply the new selection filter
      this.renderChart();
    }
  }

  attachClusterFilterSubscription() {
    this.detachClusterFilterSubscription();
    if (!this.sheetId || typeof subscribeToClusterFilter !== 'function') {
      this.activeClusterFilter = null;
      return;
    }

    try {
      this.clusterFilterUnsubscribe = subscribeToClusterFilter(this.sheetId, this.handleClusterFilterUpdate);
    } catch (error) {
      console.error('[LineChart] Failed to subscribe to cluster filter updates', error);
      this.clusterFilterUnsubscribe = null;
    }

    if (!this.activeClusterFilter && typeof getClusterFilter === 'function') {
      try {
        this.handleClusterFilterUpdate(getClusterFilter(this.sheetId));
      } catch (error) {
        console.error('[LineChart] Failed to read cluster filter state', error);
      }
    }
  }

  detachClusterFilterSubscription() {
    if (typeof this.clusterFilterUnsubscribe === 'function') {
      try {
        this.clusterFilterUnsubscribe();
      } catch (error) {
        console.error('[LineChart] Failed to detach cluster filter subscription', error);
      }
    }
    this.clusterFilterUnsubscribe = null;
    this.activeClusterFilter = null;
  }

  handleClusterFilterUpdate(clusterFilter) {
    const nextCluster = buildClusterState(clusterFilter);
    const changed = !areClusterStatesEqual(this.activeClusterFilter, nextCluster);
    this.activeClusterFilter = nextCluster;

    if (changed && this.isMounted && this.state.series?.length) {
      this.renderChart();
    }
  }

  emitUiState(detail = {}) {
    const payload = {
      selectionActive: this._lastSelectionActive || false,
      aggregateAvailable: this.aggregateAvailable || false,
      aggregateActive: this.aggregateModeActive || false,
      ...detail,
    };

    try {
      this.container?.dispatchEvent?.(new CustomEvent('line:ui-state', {
        detail: payload,
        bubbles: true,
      }));
    } catch (_) {
      // ignore ui-state errors
    }
  }

  shouldDrawPoints() {
    const candidateModes = [
      this.options?.lineRenderMode,
      this.options?.renderMode,
      this.settingsState?.lineChartRenderMode,
      this.settingsState?.lineChartMode,
      this.settingsState?.lineRenderMode,
      this.settingsState?.renderMode,
      this.settingsState?.lineChart?.renderMode,
    ];
    for (const candidate of candidateModes) {
      if (typeof candidate !== 'string') continue;
      const normalized = candidate.trim().toLowerCase();
      if (!normalized) continue;
      if (normalized === 'points' || normalized === 'point') return true;
      if (normalized === 'line' || normalized === 'lines') return false;
    }

    if (typeof this._drawPointsPreference === 'boolean') {
      return this._drawPointsPreference;
    }

    if (Number.isFinite(this._rawTotalPoints)) {
      return this._rawTotalPoints <= MAX_POINTS_FOR_CIRCLES_TOTAL;
    }

    const fallbackTotal = Array.isArray(this.series)
      ? this.series.reduce((sum, entry) => sum + (Array.isArray(entry?.points) ? entry.points.length : 0), 0)
      : 0;
    return fallbackTotal <= MAX_POINTS_FOR_CIRCLES_TOTAL;
  }

  isAggregateModeActive() {
    return !!this.aggregateModeActive;
  }

  setAggregateMode(enabled) {
    const next = !!enabled && this.aggregateAvailable;
    const changed = next !== this.aggregateModeActive;
    this.aggregateModeActive = next;
    this.aggregateEnvelope = null;

    if (changed && this.isMounted && this.state.series?.length) {
      this.renderChart();
    } else {
      this.emitUiState({ aggregateActive: this.aggregateModeActive, aggregateAvailable: this.aggregateAvailable });
    }

    return this.aggregateModeActive;
  }

  toggleAggregateMode() {
    return this.setAggregateMode(!this.aggregateModeActive);
  }

  filterSeriesByActiveRange(series) {
    if (!Array.isArray(series) || !series.length) {
      return { series: [], appliedRange: null };
    }

    const range = this.activeTimeRange;
    if (!range) {
      return { series, appliedRange: null };
    }

    const allSteps = [];
    series.forEach(entry => {
      const points = Array.isArray(entry?.points) ? entry.points : [];
      points.forEach(point => {
        const value = Number.isFinite(point?.step) ? point.step : null;
        if (value != null) allSteps.push(value);
      });
    });

    if (!allSteps.length) {
      return { series: [], appliedRange: null };
    }

    const orderedSteps = Array.from(new Set(allSteps)).sort((a, b) => a - b);
    if (!orderedSteps.length) {
      return { series: [], appliedRange: null };
    }

    const maxIndex = orderedSteps.length - 1;
    const startIdxRaw = Number.isInteger(range.startIndex) ? range.startIndex : 0;
    const endIdxRaw = Number.isInteger(range.endIndex) ? range.endIndex : startIdxRaw;
    const clampedStartIndex = Math.min(Math.max(startIdxRaw, 0), maxIndex);
    const clampedEndIndex = Math.min(Math.max(endIdxRaw, 0), maxIndex);
    const indexStart = Math.min(clampedStartIndex, clampedEndIndex);
    const indexEnd = Math.max(clampedStartIndex, clampedEndIndex);

    const startStep = orderedSteps[indexStart];
    const endStep = orderedSteps[indexEnd];
    if (!Number.isFinite(startStep) || !Number.isFinite(endStep)) {
      return { series, appliedRange: null };
    }

    const filtered = series.map(entry => {
      const points = Array.isArray(entry?.points) ? entry.points : [];
      const filteredPoints = points.filter(point => {
        const value = Number.isFinite(point?.step) ? point.step : null;
        if (value == null) return false;
        return value >= startStep && value <= endStep;
      });
      if (!filteredPoints.length) return null;
      return { ...entry, points: filteredPoints };
    }).filter(Boolean);

    if (!filtered.length) {
      return { series: [], appliedRange: { start: startStep, end: endStep, startIndex: indexStart, endIndex: indexEnd } };
    }

    return { series: filtered, appliedRange: { start: startStep, end: endStep, startIndex: indexStart, endIndex: indexEnd } };
  }

  updateTimeCursorIndicator() {
    this.ensureTimeCursorLine();

    const focusLine = this.timeCursorLine || null;
    const contextLine = this.contextTimeCursorLine || null;
    const focusPoints = this.timeCursorFocusPoints || null;
    const contextPoints = this.timeCursorContextPoints || null;

    const steps = Array.isArray(this.orderedSteps) ? this.orderedSteps : [];
    const state = this.timeCursorState || (typeof getTimeCursorState === 'function' ? getTimeCursorState() : null);
    const indexCandidate = state && Number.isFinite(state.index) ? state.index : null;

    if (!steps.length || indexCandidate === null) {
      if (focusLine) focusLine.attr('opacity', 0);
      if (contextLine) contextLine.attr('opacity', 0);
      if (focusPoints) focusPoints.selectAll('circle').attr('opacity', 0);
      if (contextPoints) contextPoints.selectAll('circle').attr('opacity', 0);
      return;
    }

    const clampedIndex = Math.min(Math.max(Math.round(indexCandidate), 0), steps.length - 1);
    const stepValue = steps[clampedIndex];
    if (!Number.isFinite(stepValue)) {
      if (focusLine) focusLine.attr('opacity', 0);
      if (contextLine) contextLine.attr('opacity', 0);
      if (focusPoints) focusPoints.selectAll('circle').attr('opacity', 0);
      if (contextPoints) contextPoints.selectAll('circle').attr('opacity', 0);
      return;
    }

    if (focusLine && this.xFocus && this.yScaleFocus) {
      const focusDomain = this.xFocus.domain();
      const domainStart = Math.min(focusDomain[0], focusDomain[1]);
      const domainEnd = Math.max(focusDomain[0], focusDomain[1]);
      if (stepValue < domainStart || stepValue > domainEnd) {
        focusLine.attr('opacity', 0);
        if (focusPoints) focusPoints.selectAll('circle').attr('opacity', 0);
      } else {
        const x = this.xFocus(stepValue);
        if (Number.isFinite(x)) {
          const yRange = this.yScaleFocus.range();
          const yStart = Math.min(yRange[0], yRange[1]);
          const yEnd = Math.max(yRange[0], yRange[1]);
          focusLine
            .attr('x1', x)
            .attr('x2', x)
            .attr('y1', yStart)
            .attr('y2', yEnd)
            .attr('opacity', 1);

          // Update focus intersection points
          if (focusPoints && Array.isArray(this.series)) {
            const pointsData = this.series.map(seriesEntry => {
              const nearestPoint = findNearestPoint(seriesEntry.points, stepValue);
              return nearestPoint ? { series: seriesEntry, point: nearestPoint } : null;
            }).filter(Boolean);

            focusPoints.selectAll('circle')
              .data(pointsData, d => d.series.key)
              .join(
                enter => enter.append('circle')
                  .attr('r', 4)
                  .attr('fill', d => this.colorScale(d.series.key))
                  .attr('stroke', '#fff')
                  .attr('stroke-width', 1.5),
                update => update,
                exit => exit.attr('opacity', 0)
              )
              .attr('cx', d => this.xFocus(d.point.step))
              .attr('cy', d => this.yScaleFocus(d.point.value))
              .attr('opacity', 1);
          }
        } else {
          focusLine.attr('opacity', 0);
          if (focusPoints) focusPoints.selectAll('circle').attr('opacity', 0);
        }
      }
    } else if (focusLine) {
      focusLine.attr('opacity', 0);
      if (focusPoints) focusPoints.selectAll('circle').attr('opacity', 0);
    }

    if (contextLine && this.xContext && this.yScaleContext) {
      const contextDomain = this.xContext.domain();
      const contextStart = Math.min(contextDomain[0], contextDomain[1]);
      const contextEnd = Math.max(contextDomain[0], contextDomain[1]);
      if (stepValue < contextStart || stepValue > contextEnd) {
        contextLine.attr('opacity', 0);
        if (contextPoints) contextPoints.selectAll('circle').attr('opacity', 0);
      } else {
        const xContext = this.xContext(stepValue);
        if (Number.isFinite(xContext)) {
          const contextRange = this.yScaleContext.range();
          const yStartContext = Math.min(contextRange[0], contextRange[1]);
          const yEndContext = Math.max(contextRange[0], contextRange[1]);
          contextLine
            .attr('x1', xContext)
            .attr('x2', xContext)
            .attr('y1', yStartContext)
            .attr('y2', yEndContext)
            .attr('opacity', 1);

          // Update context intersection points
          if (contextPoints && Array.isArray(this.series)) {
            const pointsData = this.series.map(seriesEntry => {
              const nearestPoint = findNearestPoint(seriesEntry.points, stepValue);
              return nearestPoint ? { series: seriesEntry, point: nearestPoint } : null;
            }).filter(Boolean);

            contextPoints.selectAll('circle')
              .data(pointsData, d => d.series.key)
              .join(
                enter => enter.append('circle')
                  .attr('r', 3)
                  .attr('fill', d => this.colorScale(d.series.key))
                  .attr('stroke', '#fff')
                  .attr('stroke-width', 1),
                update => update,
                exit => exit.attr('opacity', 0)
              )
              .attr('cx', d => this.xContext(d.point.step))
              .attr('cy', d => this.yScaleContext(d.point.value))
              .attr('opacity', 1);
          }
        } else {
          contextLine.attr('opacity', 0);
          if (contextPoints) contextPoints.selectAll('circle').attr('opacity', 0);
        }
      }
    } else if (contextLine) {
      contextLine.attr('opacity', 0);
      if (contextPoints) contextPoints.selectAll('circle').attr('opacity', 0);
    }
  }

  updateFocusDomain(domain) {
    try { console.log('[LineChart:updateFocusDomain] called', { domain, hasXFocus: !!this.xFocus, hasXContext: !!this.xContext }); } catch (_) {}
    if (!this.xFocus || !this.xContext) return;
    if (!Array.isArray(domain) || domain.length !== 2) { try { console.log('[LineChart:updateFocusDomain] invalid domain shape', domain); } catch (_) {} return; }
   
    const [rawStart, rawEnd] = domain;
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) { try { console.log('[LineChart:updateFocusDomain] non-finite inputs', { rawStart, rawEnd }); } catch (_) {} return; }
   
    const contextDomain = this.xContext.domain();
    const contextStart = Math.min(contextDomain[0], contextDomain[1]);
    const contextEnd = Math.max(contextDomain[0], contextDomain[1]);
    const normalizedStart = Math.max(Math.min(rawStart, rawEnd), contextStart);
    const normalizedEnd = Math.min(Math.max(rawStart, rawEnd), contextEnd);
    if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) { try { console.log('[LineChart:updateFocusDomain] non-finite normalized', { normalizedStart, normalizedEnd }); } catch (_) {} return; }
    try { console.log('[LineChart:updateFocusDomain] normalized', [normalizedStart, normalizedEnd]); } catch (_) {}
   
    const unchanged = this.focusDomain
      && Math.abs(this.focusDomain[0] - normalizedStart) < 1e-6
      && Math.abs(this.focusDomain[1] - normalizedEnd) < 1e-6;
   
    this.focusDomain = [normalizedStart, normalizedEnd];
    this.xFocus.domain(this.focusDomain);
   
    const tickValues = computeStepTickValues(this.xFocus, this.settingsState);
   
    this.handleFocusPointerLeave();
   
    const drawPointsFocus = this.shouldDrawPoints();

    renderFocusView({
      focusGroup: this.focusContentGroup,
      axesGroup: this.focusAxesGroup,
      series: this.series,
      line: this.lineGenerator,
      xFocus: this.xFocus,
      yScale: this.yScaleFocus,
      colorScale: this.colorScale,
      clipId: this.focusClipId,
      tickValues,
      drawPoints: drawPointsFocus,
      settingsState: this.settingsState,
      selectionFilter: this.activePointSelection,
      clusterState: this.activeClusterFilter,
      envelope: this.aggregateEnvelope,
    });
    this.ensureTimeCursorLine();
    this.updateTimeCursorIndicator();
    this.bindFocusInteractions();

    // Keep brush synced with the new focus domain
    if (this.contextBrush && this.brush && this.xContext) {
      const contextDomain = this.xContext.domain();
      const contextStart = Math.min(contextDomain[0], contextDomain[1]);
      const contextEnd = Math.max(contextDomain[0], contextDomain[1]);
      const isFullRange = Math.abs(this.focusDomain[0] - contextStart) < 1e-6 && Math.abs(this.focusDomain[1] - contextEnd) < 1e-6;

      if (isFullRange) {
        // Clear brush selection when entire time range is selected
        this._suppressBrush = true;
        this.contextBrush.call(this.brush.move, null);
        this._suppressBrush = false;
      } else {
        const [d0, d1] = this.focusDomain;
        const sel = [this.xContext(d0), this.xContext(d1)];
        if (Number.isFinite(sel[0]) && Number.isFinite(sel[1]) && sel[1] > sel[0]) {
          this._suppressBrush = true;
          this.contextBrush.call(this.brush.move, sel);
          this._suppressBrush = false;
        }
      }
    }
    try {
      const contextDomain2 = this.xContext.domain();
      const cStart2 = Math.min(contextDomain2[0], contextDomain2[1]);
      const cEnd2 = Math.max(contextDomain2[0], contextDomain2[1]);
      const isFullRangeNow = Math.abs(this.focusDomain[0] - cStart2) < 1e-6 && Math.abs(this.focusDomain[1] - cEnd2) < 1e-6;
      this._lastSelectionActive = !isFullRangeNow;
      this.emitUiState({ selectionActive: this._lastSelectionActive });
      console.log('[LineChart:updateFocusDomain] render complete', { focusDomain: this.focusDomain, selectionActive: this._lastSelectionActive });
    } catch (_) {}
    
    // We purposely do NOT early-return on unchanged, to ensure a redraw in edge cases.
    void unchanged; // eslint silencer
  }

    // Reset must never (re)apply a TimeRangeFilter.
    // It clears only the temporary overview selection (brush) and reframes to the current working domain:
    //   workingDomain = activeTimeRange ? filtered domain (xContext.domain()) : global full domain (xContext.domain()).
    resetView() {
      if (!this.isMounted) return;
      if (!this.xContext || typeof this.xContext.domain !== 'function') return;
  
      // Determine the working domain from the current context scale.
      // When a TimeRangeFilter is active, rendering already set xContext to the filtered domain.
      // Without a filter, xContext spans the global full domain.
      const workingDomain = this.xContext.domain();
  
      // Clear the temporary overview selection overlay (brush), if present.
      if (this.contextBrush && this.brush) {
        this._suppressBrush = true;
        try {
          this.contextBrush.call(this.brush.move, null);
        } finally {
          this._suppressBrush = false;
        }
      }
  
      // Apply the working domain to the focus (upper) chart.
      this.updateFocusDomain(workingDomain);
  
      // Do not carry over any stale "default window" that could reintroduce an old filter view.
      this._defaultFocusDomain = null;
    }
}

LineChart.fetcher = requestJson;

export default LineChart;
