import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { drawAxes2D, render2DCanvas } from "./ScatterChart2D.js";
import {
  DEFAULT_ROTATION,
  MIN_SCALE,
  MAX_SCALE,
  ROTATION_SETTINGS,
  STYLE_3D,
  INTERACTION_IDLE_MS,
  clampPitch,
  drawAxes3D,
  render3DCanvas,
  bind3DInteractionsCanvas,
  buildColorLUT
} from "./ScatterChart3D.js";
import { HIGHLIGHT_STYLE } from "./highlightCore.js";
import { getRandomSampleIndices } from "./performanceUtils.js";
import { subscribe as subscribeToTimeRangeFilter, getActiveDomain as getActiveTimeRangeDomain } from "../../state/timeRangeFilter.js";
import {
  subscribe as subscribeToTimeCursor,
  getState as getTimeCursorState
} from "../../features/timeControls/timeCursor.js";
import { 
  subscribe as subscribeToPointSelection, 
  getPointSelection, 
  setPointSelection, 
  clearPointSelection 
} from "../../state/pointSelection.js";
import { createSelectionManager, SelectionTools } from "./selectionTools.js";
import { create2DSelectionAdapter } from "./selectionTools2DAdapter.js";
import { create3DSelectionAdapter } from "./selectionTools3DAdapter.js";
import { createPcaOverlay } from "./PcaOverlay.js";
import { createUmapOverlay } from "./UmapOverlay.js";
import { createTsneOverlay } from "./TsneOverlay.js";

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 420;
// kompaktere Default-Margins für bessere Raumausnutzung
const MARGINS = { top: 14, right: 4, bottom: 10, left: 30 };
const AXIS_BOTTOM_PADDING_2D = 10;

const AXIS_REDRAW_DELAY = 80; // ms, throttle axes updates on zoom

function sanitizeLabel(value, fallback) {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function expandExtent(extent) {
  const [min, max] = extent;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.05, 1e-6);
    return [min - pad, max + pad];
  }
  const span = max - min;
  const padding = span * 0.05;
  return [min - padding, max + padding];
}

function normalizePoints(points, dimension) {
  if (!Array.isArray(points)) return [];
  return points
    .map(entry => {
      const coords = Array.isArray(entry?.coordinates) ? entry.coordinates : [];
      if (coords.length < dimension) return null;
      const parsed = coords.slice(0, dimension).map(value => Number(value));
      if (!parsed.every(Number.isFinite)) return null;
      const rowIndex = Number(entry?.rowIndex);
      return { rowIndex: Number.isInteger(rowIndex) ? rowIndex : null, coordinates: parsed };
    })
    .filter(Boolean);
}

function normalizeColumns(columns, dimension) {
  if (!Array.isArray(columns)) return [];
  const normalized = columns
    .map((column, index) => {
      if (!column || typeof column !== "object") return null;
      const key = sanitizeLabel(column.key, `column_${index + 1}`);
      const label = sanitizeLabel(column.label, `Dimension ${column.columnIndex ?? index + 1}`);
      return { key, label, columnIndex: column.columnIndex ?? index + 1 };
    })
    .filter(Boolean);
  if (normalized.length >= dimension) return normalized.slice(0, dimension);
  return normalized;
}

function normalizeColumnLabels(columnLabels, fallbackColumns) {
  if (!Array.isArray(columnLabels) || !columnLabels.length) {
    return fallbackColumns.map(column => column.label);
  }
  const labels = columnLabels.map(label => sanitizeLabel(label)).filter(Boolean);
  if (labels.length === fallbackColumns.length) return labels;
  return fallbackColumns.map((column, index) => labels[index] || column.label);
}

function normalizeSubjectId(value) {
  if (value == null) return null;
  const raw = typeof value === "string" ? value.trim() : Number.isFinite(value) ? String(value) : String(value ?? "").trim();
  if (!raw || raw === "0") return null;

  // Normalize numeric strings so "1.0" and "1" match
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    const asInt = Math.round(asNumber);
    if (Math.abs(asNumber - asInt) < 1e-6) {
      return String(asInt);
    }
  }

  return raw;
}

function normalizeSubjectSelection(values) {
  if (!Array.isArray(values) || !values.length) return [];
  const unique = new Set();
  values.forEach(entry => {
    const id = normalizeSubjectId(entry);
    if (id) unique.add(id);
  });
  return Array.from(unique);
}

function toFloat32(points, dim) {
  const n = points.length;
  const coords = new Float32Array(n * dim);
  const rowIndices = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const entry = points[i];
    const p = entry.coordinates;
    for (let d = 0; d < dim; d++) coords[i * dim + d] = p[d];
    const rowIndex = Number.isInteger(entry.rowIndex) ? entry.rowIndex : i;
    rowIndices[i] = rowIndex;
  }
  return { coords, rowIndices };
}

// Compute centroid (mean) for 2D/3D
function computeCentroid(pointsF32, dim) {
  const n = pointsF32.length / dim;
  if (n === 0) return dim === 3 ? [0,0,0] : [0,0];
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    sx += pointsF32[i*dim];
    sy += pointsF32[i*dim + 1];
    if (dim === 3) sz += pointsF32[i*dim + 2];
  }
  if (dim === 3) return [sx/n, sy/n, sz/n];
  return [sx/n, sy/n];
}

function createSvg(container, width, height) {
  const svg = d3
    .select(container)
    .append("svg")
    .attr("class", "scatter-chart__svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .style("display", "block")
    .style("max-width", "100%")
    .style("width", "100%")
    .style("height", "100%")
    .style("overflow", "hidden")
    .style("touch-action", "none")
    // Ensure the entire SVG (axes + overlay + geometry) sits above the 3D canvas
    // and acts as a dedicated 2D front-most layer.
    .style("position", "absolute")
    .style("left", "0")
    .style("top", "0")
    .style("z-index", "1");

  svg.append("g").attr("class", "scatter-chart__plot");
  svg.append("g").attr("class", "scatter-chart__axes");
  svg.append("g").attr("class", "scatter-chart__legend"); // bleibt als Gruppe vorhanden, wird aber geleert
  return svg;
}

function ensureDefs(svg) {
  if (svg.select("defs").empty()) svg.append("defs");
  return svg.select("defs");
}

function ensureStatusElement(container) {
  const existing = container.querySelector(".scatter-chart__status");
  if (existing) return existing;
  const status = document.createElement("div");
  status.className = "scatter-chart__status text-sm text-gray-600";
  status.style.padding = "1rem";
  status.style.textAlign = "center";
  container.appendChild(status);
  return status;
}

function ensureSpinnerStyle() {
  if (document.getElementById('scatter-spinner-style')) return;
  const style = document.createElement('style');
  style.id = 'scatter-spinner-style';
  style.textContent = `
    @keyframes scatter-spinner-rotate {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .scatter-chart__spinner {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background:
        conic-gradient(
          from 90deg,
          rgba(37,99,235,0.1) 0deg,
          rgba(37,99,235,0.35) 120deg,
          rgba(37,99,235,0.65) 240deg,
          rgba(37,99,235,1) 360deg
        );
      -webkit-mask: radial-gradient(farthest-side, #0000 calc(100% - 6px), #000 calc(100% - 4px));
      mask: radial-gradient(farthest-side, #0000 calc(100% - 6px), #000 calc(100% - 4px));
      animation: scatter-spinner-rotate 0.8s linear infinite;
      will-change: transform;
    }
  `;
  document.head.appendChild(style);
}

function ensureStatusSections(status) {
  if (status.__scatterStatusSections) {
    return status.__scatterStatusSections;
  }

  const spinnerContainer = document.createElement("div");
  spinnerContainer.className = "scatter-chart__status-spinner";
  spinnerContainer.style.display = "flex";
  spinnerContainer.style.alignItems = "center";
  spinnerContainer.style.justifyContent = "center";
  spinnerContainer.style.marginBottom = "0.75rem";

  const spinner = document.createElement("div");
  spinner.className = "scatter-chart__spinner";
  ensureSpinnerStyle();
  spinnerContainer.appendChild(spinner);

  const messageEl = document.createElement("div");
  messageEl.className = "scatter-chart__status-message";
  messageEl.style.marginBottom = "0.75rem";
  messageEl.style.fontWeight = "500";

  const stageContainer = document.createElement("div");
  stageContainer.className = "scatter-chart__status-stages";
  stageContainer.style.display = "flex";
  stageContainer.style.flexDirection = "column";
  stageContainer.style.gap = "0.35rem";

  status.appendChild(spinnerContainer);
  status.appendChild(messageEl);
  status.appendChild(stageContainer);

  status.__scatterStatusSections = { spinnerContainer, spinner, messageEl, stageContainer };
  return status.__scatterStatusSections;
}

function renderStageProgress(stageContainer, method, percentage, providedStageLabel = null) {
  if (!stageContainer) return;

  const hasProgress = Number.isFinite(percentage);
  const clampedPercentage = hasProgress
    ? Math.max(0, Math.min(percentage, 100))
    : 0;

  if (!hasProgress) {
    stageContainer.innerHTML = "";
    stageContainer.style.display = "none";
    return;
  }

  stageContainer.style.display = "flex";
  stageContainer.innerHTML = "";

  const progressRow = document.createElement("div");
  progressRow.style.display = "flex";
  progressRow.style.alignItems = "center";
  progressRow.style.gap = "0.5rem";

  const barWrapper = document.createElement("div");
  barWrapper.style.flex = "1";
  barWrapper.style.height = "8px";
  barWrapper.style.background = "#e5e7eb";
  barWrapper.style.borderRadius = "999px";
  barWrapper.style.overflow = "hidden";

  const barFill = document.createElement("div");
  barFill.style.height = "100%";
  barFill.style.width = `${clampedPercentage}%`;
  barFill.style.background = "linear-gradient(90deg, #60a5fa, #2563eb)";
  barFill.style.borderRadius = "999px";
  barFill.style.transition = "width 0.4s ease";
  barWrapper.appendChild(barFill);

  const percentLabel = document.createElement("span");
  percentLabel.textContent = `${Math.round(clampedPercentage)}%`;
  percentLabel.style.fontVariantNumeric = "tabular-nums";
  percentLabel.style.fontSize = "0.9rem";
  percentLabel.style.fontWeight = "600";
  percentLabel.style.color = "#1f2937";

  progressRow.appendChild(barWrapper);
  progressRow.appendChild(percentLabel);
  stageContainer.appendChild(progressRow);

  // The stage label is still resolved by the caller to update the textual
  // status message. We intentionally omit a secondary caption next to the
  // progress bar to avoid showing duplicate stage names.
}

function renderSubjectBadge(container, subject) {
  if (!subject || typeof subject !== "object") return;
  const id = sanitizeLabel(subject.id, "");
  const label = sanitizeLabel(subject.label, id || "");
  if (!label) return;
  let badge = container.querySelector(".scatter-chart__subject");
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "scatter-chart__subject text-xs text-gray-500";
    badge.style.marginTop = "0.5rem";
    container.appendChild(badge);
  }
  badge.textContent = `Subject: ${label}`;
}

function clearSubjectBadge(container) {
  const badge = container.querySelector(".scatter-chart__subject");
  if (badge) badge.remove();
}

function renderStatus(container, message, tone = "muted", percentage = null, meta = null) {
  const status = ensureStatusElement(container);
  const { spinnerContainer, messageEl, stageContainer } = ensureStatusSections(status);

  const resolvedTone = tone === "error" ? "error" : tone === "info" ? "info" : "muted";

  spinnerContainer.style.display = resolvedTone === "info" ? "flex" : "none";

  messageEl.textContent = message;
  messageEl.style.color = resolvedTone === "error" ? "#dc2626" : resolvedTone === "info" ? "#2563eb" : "#4b5563";

  const stagePercentage = Number.isFinite(percentage)
    ? percentage
    : Number.isFinite(meta?.percentage)
      ? meta.percentage
      : null;

  if (resolvedTone === "info" && Number.isFinite(stagePercentage)) {
    renderStageProgress(stageContainer, meta?.method, stagePercentage, meta?.stageLabel);
  } else {
    stageContainer.innerHTML = "";
    stageContainer.style.display = "none";
  }

  status.hidden = false;
  const svg = container.querySelector("svg.scatter-chart__svg");
  if (svg) svg.style.display = "none";
  const canvas = container.querySelector("canvas.scatter-chart__canvas");
  if (canvas) canvas.style.display = "none";
  clearSubjectBadge(container);
}

function hideStatus(container) {
  const status = ensureStatusElement(container);
  status.hidden = true;
  const svg = container.querySelector("svg.scatter-chart__svg");
  if (svg) svg.style.display = "block";
  const canvas = container.querySelector("canvas.scatter-chart__canvas");
  if (canvas) canvas.style.display = "block";
}

function ensureCanvas(container, width, height) {
  let canvas = container.querySelector("canvas.scatter-chart__canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "scatter-chart__canvas";
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.pointerEvents = "none"; // perf: no per-point hit testing
    // sicherstellen, dass die Canvas NICHT die Statusfläche überdeckt
    canvas.style.zIndex = "0";
    container.appendChild(canvas);
  }
  resizeCanvas(canvas, width, height);
  return canvas;
}

function resizeCanvas(canvas, width, height) {
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) ? window.devicePixelRatio : 1;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export class ScatterChart {
  constructor(container, options = {}) {
    if (!container) throw new Error("ScatterChart requires a container element.");
    this.container = container;
    this.options = { ...options };

    this._baseData = null;
    this._clusterMeta = null;
    this._subjectSelection = normalizeSubjectSelection(this.options?.subjects);

    this.svg = null;
    this.canvas = null;
    this.ctx = null;

    this.statusMessage = null;
    this.data = null; // {pointsF32, columns, columnLabels, subject, extents, origin}
    this.dimension = 2;
    this.currentSize = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

    this._renderMode = "points";
    this._liveMode = null;

    this.resizeObserver = null;

    this._margins2D = Object.freeze({
      top: MARGINS.top,
      right: MARGINS.right,
      left: MARGINS.left,
      bottom: MARGINS.bottom + AXIS_BOTTOM_PADDING_2D
    });

    // Interactions/state
    this.transform = d3.zoomIdentity; // 2D
    this.zoomBehavior = null;
    this.zoomSel = null;
    this.axesThrottleTimer = null;

    this.rotation = { ...DEFAULT_ROTATION }; // 3D
    this.unbind3D = null;

    // Inertia (spin after drag)
    this._spinRAF = null;
    this._spinVel = { yaw: 0, pitch: 0 }; // radians/frame
    this._spinDamp = 0.94;                // damping per frame
    this._spinMin = 0.0003;               // stop threshold

    // Unified rotation state
    this._rotationMode = "idle";
    this._rotationFrame = 0;
    this._axesEvery = ROTATION_SETTINGS.idle.axesEvery;

    // Auto-rotation (default idle animation)
    this._autoSpinRAF = null;
    this._autoSpinSpeed = 0.003;          // radians per frame (for reference)
    this._autoSpinSpeedPerMs = 0.18;      // radians per second (~10 degrees/sec) - time-based for consistent visual speed
    this._autoSpinEnabled = true;
    this._lastAutoSpinTime = null;

    // Performance mode: sampling is always applied
    this._performanceModeEnabled = true;
    
    this._samplingPercentage = 20;
    
    // Sampling cache to prevent "disco effect" - stable sampling per percentage
    this._samplingCache = {
      percentage: null,
      pointCount: null,
      indices: null
    };

    // Quality/runtime
    this._quality = ROTATION_SETTINGS.active.quality;  // Always use sampling quality
    this._interacting = false;
    this._interactTimer = null;

    this._colorLUT = buildColorLUT(256);
    this._fogBg = null;
    this._runtime3D = {
      bucketsCache: null,
      sizesCache: null,
      colorLUT: this._colorLUT,
      fogBgParsed: this._fogBg,
      quality: this._quality,
      trailGlowQueue: null,
      trailGlowColorCache: null
    };

    // Time cursor integration and highlight tuning
    this._timeCursorUnsubscribe = null;
    this._timeCursorListener = null;
    this._timeCursorState = null;
    this._highlightConfig = {
      fadeWindowFactor: 0.12,
      minFadeWindow: 10,
      maxFadeWindow: 64
    };

    // rAF render scheduler
    this._scheduled = false;
    this._needsAxes = true;

    // Keyboard handlers
    this._keyHandler = null;

    // Flag, ob wir beim nächsten 3D-Render auto-fitten sollen
    this._pendingAutoFit3D = false;

    // Sheet context for TimeRangeFilter (sheet-wide range for greying/clipping)
    this.sheetId = (typeof this.options.sheetId === "string" && this.options.sheetId.trim()) ? this.options.sheetId.trim() : null;
    this._timeRangeUnsubscribe = null;
    this._activeTimeRange = null;

    // Point selection state (committed/confirmed selection from selection tools)
    this._pointSelectionUnsubscribe = null;
    this._activePointSelection = null;

    // Filtered visibility toggle: 'grey' (default) | 'hide'
    // Applies to BOTH time range filtering AND point selection filtering
    this._filteredVisibilityMode = "grey";
    // Optional per-sheet persistence during session
    this._visibilityBySheet = new Map();

    // Selection tools state (visual-only)
    this._selectionMgr = null;
    this._selectionAdapter = null;
    this._selectionToolbar = null;
    // Selection toolbox visibility (UI overlay in chart). Default hidden.
    this._selectionToolbarVisible = false;

    // PCA overlay state
    this._pcaOverlay = null;
    this._pcaMetadata = null;
    this._pcaComponentSelection = null;
    this._pcaOverlayVisible = true;

    // UMAP overlay state
    this._umapOverlay = null;
    this._umapParameters = { neighbours: 15 };
    this._umapOverlayVisible = true;

    // T-SNE overlay state
    this._tsneOverlay = null;
    this._tsneController = null;
    this._tsneOverlayVisible = true;
    this._tsneParams = null; // Stores user-defined parameters
    
    // Track current reduction method
    this._reductionMethod = null;
  }

  // ---- sizing ----
  measureContainer(contentRect = null) {
    const widthOption = Number(this.options.width);
    const heightOption = Number(this.options.height);
    const rect =
      contentRect && typeof contentRect === "object"
        ? contentRect
        : typeof this.container.getBoundingClientRect === "function"
        ? this.container.getBoundingClientRect()
        : null;

    let width = Number.isFinite(widthOption) && widthOption > 0 ? widthOption : null;
    if (!width || width <= 0) {
      const rectWidth = rect?.width;
      width = rectWidth && rectWidth > 0 ? rectWidth : this.container.clientWidth;
    }
    width = width && width > 0 ? width : DEFAULT_WIDTH;

    let height = Number.isFinite(heightOption) && heightOption > 0 ? heightOption : null;
    if (!height || height <= 0) {
      const rectHeight = rect?.height;
      height = rectHeight && rectHeight > 0 ? rectHeight : this.container.clientHeight;

      if ((!height || height <= 0) && typeof window !== "undefined" && window.getComputedStyle) {
        const computed = Number.parseFloat(window.getComputedStyle(this.container).height);
        if (Number.isFinite(computed) && computed > 0) height = computed;
      }
    }
    if (!height || height <= 0) height = Math.max(width * 0.65, DEFAULT_HEIGHT * 0.6);

    return { width, height };
  }

  updateSize(contentRect = null) {
    const next = this.measureContainer(contentRect);
    const changed =
      Math.abs(next.width - this.currentSize.width) > 0.5 ||
      Math.abs(next.height - this.currentSize.height) > 0.5;

    if (!changed) return;

    this.currentSize = next;

    if (this.svg) {
      this.svg
        .attr("width", this.currentSize.width)
        .attr("height", this.currentSize.height)
        .attr("viewBox", `0 0 ${this.currentSize.width} ${this.currentSize.height}`);
    }
    if (this.canvas) {
      this.ctx = resizeCanvas(this.canvas, this.currentSize.width, this.currentSize.height);
    }

    // Force axes redraw after resize
    this._needsAxes = true;
    this.requestRender(true);
  }

  ensureResizeObserver() {
    if (typeof ResizeObserver === "undefined") return;
    if (this.resizeObserver) return;
    this.resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === this.container) {
          this.updateSize(entry.contentRect);
        }
      }
    });
    this.resizeObserver.observe(this.container);
  }

  // ---- mounting/unmounting ----
  mount() {
    this.container.classList.add("scatter-chart");
    this.container.style.position = this.container.style.position || "relative";
    this.container.style.overflow = this.container.style.overflow || "hidden";
    this.container.tabIndex = this.container.tabIndex || 0; // focusable for keyboard

    if (!this.svg) {
      this.currentSize = this.measureContainer();
      this.svg = createSvg(this.container, this.currentSize.width, this.currentSize.height);
      this.canvas = ensureCanvas(this.container, this.currentSize.width, this.currentSize.height);
      this.ctx = this.canvas.getContext("2d");
      resizeCanvas(this.canvas, this.currentSize.width, this.currentSize.height);
    }

    this.statusMessage = ensureStatusElement(this.container);
    this.statusMessage.hidden = true;
    this.ensureResizeObserver();

    // Initialize visual selection tools UI/handlers
    this._setupSelection(false);

    // Setup d3-zoom (enabled only in 2D)
    if (!this.zoomBehavior) {
      this.zoomBehavior = d3.zoom()
        .scaleExtent([0.5, 24])
        .on("zoom", (event) => {
          if (this.dimension !== 2) return;
          this.transform = event.transform;
          this._onInteract(); // switch to LOW and render
        })
        .on("end", () => {
          if (this.dimension !== 2) return;
          this._needsAxes = true;
          this.requestRender(true);
        });
      this.zoomSel = d3.select(this.container);
      this.zoomSel.on("dblclick.zoom", null);
      this.zoomSel.on("dblclick", (event) => {
        event.preventDefault();
        if (this.dimension !== 2) return;
        this.transform = d3.zoomIdentity;
        this.zoomSel.transition().duration(0).call(this.zoomBehavior.transform, this.transform);
        this._needsAxes = true;
        this.requestRender(true);
      });
    }

    // Keyboard for presets
    this._bindKeyboard();

    this._attachTimeCursorSubscription();
    this._attachTimeRangeFilterSubscription();
    this._attachPointSelectionSubscription();
    
    // Init overlay if data exists (for page reloads)
    if (this.data && this._reductionMethod) {
      if (this._reductionMethod === 'pca') {
        this._updatePcaOverlay();
      } else if (this._reductionMethod === 'umap') {
        this._updateUmapOverlay();
      }
    }
  }

  unmount() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.zoomSel) {
      this.zoomSel.on(".zoom", null);
      this.zoomSel = null;
    }
    this._unbind3D();
    this._destroySelection();
    this._unbindKeyboard();
    this._stopSpin();
    this._stopAutoSpin(); // rendert jetzt sofort HQ (siehe Methode)
    this._detachTimeCursorSubscription();
    this._detachTimeRangeFilterSubscription();
    this._detachPointSelectionSubscription();
    
    // Destroy PCA overlay
    if (this._pcaOverlay) {
      this._pcaOverlay.destroy();
      this._pcaOverlay = null;
    }

    // Destroy UMAP overlay
    if (this._umapOverlay) {
      this._umapOverlay.destroy();
      this._umapOverlay = null;
    }

    // Destroy T-SNE overlay
    if (this._tsneOverlay) {
      this._tsneOverlay.destroy();
      this._tsneOverlay = null;
    }

    if (this.svg) {
      this.svg.remove();
      this.svg = null;
    }
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
      this.ctx = null;
    }

    clearSubjectBadge(this.container);
    const status = this.container.querySelector(".scatter-chart__status");
    if (status) status.remove();
    this.data = null;
    this.transform = d3.zoomIdentity;
    this.zoomBehavior = null;
    this.rotation = { ...DEFAULT_ROTATION };
    this._rotationMode = "idle";
    this._axesEvery = ROTATION_SETTINGS.idle.axesEvery;
    this._quality = ROTATION_SETTINGS.idle.quality;
    this._scheduled = false;
    this._pendingAutoFit3D = false;
  }

  // ---- public API ----
  setLoading(message = "Preparing scatter plot data…", percentage = null, meta = null) {
    renderStatus(this.container, message, "info", percentage, meta);
  }

  setError(message = "Scatter plot data could not be loaded.") {
    renderStatus(this.container, message, "error");
  }

  setPcaOverlayVisible(visible) {
    const nextVisible = !!visible;
    this._pcaOverlayVisible = nextVisible;
    if (!this._pcaOverlay) {
      return this._pcaOverlayVisible;
    }
    if (nextVisible) {
      this._pcaOverlay.show();
    } else {
      this._pcaOverlay.hide();
    }
    return this._pcaOverlayVisible;
  }

  getPcaOverlayVisible() {
    return !!this._pcaOverlayVisible;
  }

  getPcaSelection() {
    if (!this._pcaOverlay) return null;
    return this._pcaOverlay.getSelection();
  }

  setPcaSelection(selection) {
    if (!this._pcaOverlay || !selection) return;
    this._pcaOverlay.setSelection(selection);
  }

  setUmapOverlayVisible(visible) {
    const nextVisible = !!visible;
    this._umapOverlayVisible = nextVisible;
    if (!this._umapOverlay) {
      return this._umapOverlayVisible;
    }
    if (nextVisible) {
      this._umapOverlay.show();
    } else {
      this._umapOverlay.hide();
    }
    return this._umapOverlayVisible;
  }

  getUmapOverlayVisible() {
    return !!this._umapOverlayVisible;
  }

  getUmapParameters() {
    if (!this._umapOverlay) return this._umapParameters;
    return this._umapOverlay.getParameters();
  }

  setUmapParameters(params) {
    if (!this._umapOverlay || !params) return;
    this._umapOverlay.setParameters(params);
  }

  setUmapLoading(isLoading) {
    if (!this._umapOverlay) return;
    if (typeof this._umapOverlay.setLoading === 'function') {
      this._umapOverlay.setLoading(isLoading);
    }
  }

  setTsneOverlayVisible(visible) {
    const nextVisible = !!visible;
    this._tsneOverlayVisible = nextVisible;
    if (!this._tsneOverlay) {
      return this._tsneOverlayVisible;
    }
    if (nextVisible) {
      this._tsneOverlay.show();
    } else {
      this._tsneOverlay.hide();
    }
    return this._tsneOverlayVisible;
  }

  getTsneOverlayVisible() {
    return !!this._tsneOverlayVisible;
  }

  setReductionMethod(method) {
    const validMethods = ['pca', 'umap', 'tsne'];
    const normalizedMethod = method ? method.toLowerCase() : null;
    
    if (normalizedMethod && !validMethods.includes(normalizedMethod)) {
      console.warn('[ScatterChart] Invalid reduction method:', method);
      return;
    }
    
    this._reductionMethod = normalizedMethod;
    
    // Update overlays based on the new method
    // Only update if chart is mounted (has svg/canvas)
    if (this.svg || this.canvas) {
      if (normalizedMethod === 'pca') {
        this._updatePcaOverlay();
        // Destroy UMAP and T-SNE overlays
        if (this._umapOverlay) {
          this._umapOverlay.destroy();
          this._umapOverlay = null;
        }
        if (this._tsneOverlay) {
          this._tsneOverlay.destroy();
          this._tsneOverlay = null;
        }
      } else if (normalizedMethod === 'umap') {
        this._updateUmapOverlay();
        // Destroy PCA and T-SNE overlays
        if (this._pcaOverlay) {
          this._pcaOverlay.destroy();
          this._pcaOverlay = null;
        }
        if (this._tsneOverlay) {
          this._tsneOverlay.destroy();
          this._tsneOverlay = null;
        }
      } else if (normalizedMethod === 'tsne') {
        this._updateTsneOverlay();
        // Destroy PCA and UMAP overlays
        if (this._pcaOverlay) {
          this._pcaOverlay.destroy();
          this._pcaOverlay = null;
        }
        if (this._umapOverlay) {
          this._umapOverlay.destroy();
          this._umapOverlay = null;
        }
      } else {
        // Destroy all overlays for other methods
        if (this._pcaOverlay) {
          this._pcaOverlay.destroy();
          this._pcaOverlay = null;
        }
        if (this._umapOverlay) {
          this._umapOverlay.destroy();
          this._umapOverlay = null;
        }
        if (this._tsneOverlay) {
          this._tsneOverlay.destroy();
          this._tsneOverlay = null;
        }
      }
    }
  }

  resetView() {
    if (!this.svg || !this.canvas) return;

    if (this.dimension === 2) {
      this.transform = d3.zoomIdentity;
      if (this.zoomSel && this.zoomBehavior) {
        this.zoomSel.transition().duration(0).call(this.zoomBehavior.transform, this.transform);
      }
      this._needsAxes = true;
      this.requestRender(true);
    } else {
      this.rotation.yaw = DEFAULT_ROTATION.yaw;
      this.rotation.pitch = DEFAULT_ROTATION.pitch;
      this.rotation.scale = DEFAULT_ROTATION.scale;

      this._pendingAutoFit3D = true;

      this._stopSpin();
      this._stopAutoSpin(); // sofort HQ-Render
      this._onInteract();
    }
  }

  // Update sheet context for sheet-wide TimeRangeFilter and resubscribe
  setSheetContext(sheetId) {
    const next = (typeof sheetId === "string" && sheetId.trim()) ? sheetId.trim() : null;
    if (this.sheetId === next) return;
    this.sheetId = next;

    // Restore per-sheet filtered visibility preference if available
    if (this.sheetId && this._visibilityBySheet instanceof Map) {
      const saved = this._visibilityBySheet.get(this.sheetId);
      if (saved === "grey" || saved === "hide") {
        this._filteredVisibilityMode = saved;
      } else {
        this._filteredVisibilityMode = "grey";
      }
    } else {
      this._filteredVisibilityMode = "grey";
    }

    if (this.svg || this.canvas) {
      this._detachTimeRangeFilterSubscription();
      this._attachTimeRangeFilterSubscription();
      this._detachPointSelectionSubscription();
      this._attachPointSelectionSubscription();
      this._emitUiState();
      this.requestRender(false);
    }
  }

  setAutoRotationEnabled(enabled) {
    const next = !!enabled;
    this._autoSpinEnabled = next;
    if (next) {
      this._startAutoSpin();
    } else {
      // Auto-Spin aus: sofort HQ in derselben Pose rendern
      this._stopAutoSpin(); // stellt Quali + DPR zurück und rendert sofort
    }
    return this._autoSpinEnabled;
  }

  getAutoRotationEnabled() { return !!this._autoSpinEnabled; }
  isAutoRotationEnabled() { return this.getAutoRotationEnabled(); }
  toggleAutoRotation() { return this.setAutoRotationEnabled(!this._autoSpinEnabled); }

  // ---- Performance Mode API ----
  setPerformanceModeEnabled(enabled) {
    // Performance Mode is now always ON - button is a no-op
    // Return true to indicate Performance Mode is always enabled
    return true;
  }

  // ---- Filtered Visibility API (applies to both TimeRangeFilter and Point Selection) ----
  setFilteredVisibilityMode(mode) {
    const next = mode === "hide" ? "hide" : "grey";
    if (this._filteredVisibilityMode === next) return this._filteredVisibilityMode;
    this._filteredVisibilityMode = next;
    if (this.sheetId && this._visibilityBySheet instanceof Map) {
      this._visibilityBySheet.set(this.sheetId, next);
    }
    this._emitUiState();
    this.requestRender(true);
    return this._filteredVisibilityMode;
  }

  getFilteredVisibilityMode() {
    return this._filteredVisibilityMode === "hide" ? "hide" : "grey";
  }

  toggleFilteredVisibilityMode() {
    const next = this._filteredVisibilityMode === "hide" ? "grey" : "hide";
    return this.setFilteredVisibilityMode(next);
  }

  getPerformanceModeEnabled() { return true; }  // Always return true - Performance Mode is always ON

  togglePerformanceModeEnabled() {
    // No-op: Performance Mode is always ON, button does nothing
    return true;
  }

  // ---- Sampling Percentage API ----
  setSamplingPercentage(percentage) {
    // Clamp to 5-100 range
    const clamped = Math.max(5, Math.min(100, Math.round(percentage)));
    if (this._samplingPercentage === clamped) return this._samplingPercentage;
    this._samplingPercentage = clamped;
    // Invalidate cache when percentage changes
    this._samplingCache.percentage = null;
    this.requestRender(true);  // Force re-render with new sampling
    return this._samplingPercentage;
  }

  getSamplingPercentage() {
    return this._samplingPercentage;
  }
  
  // Get cached sampled indices (stable for same percentage + pointCount)
  _getSampledIndices(pointCount) {
    const percentage = this._samplingPercentage;
    
    // If percentage is 100%, return null to signal "use all points"
    if (percentage >= 100) {
      return null;
    }
    
    // Check if cache is valid
    if (
      this._samplingCache.percentage === percentage &&
      this._samplingCache.pointCount === pointCount &&
      this._samplingCache.indices !== null
    ) {
      return this._samplingCache.indices;
    }
    
    // Cache miss - compute new sample
    const indices = getRandomSampleIndices(pointCount, percentage);
    
    // Store in cache
    this._samplingCache.percentage = percentage;
    this._samplingCache.pointCount = pointCount;
    this._samplingCache.indices = indices;
    
    return indices;
  }

  // Public helper for UI to know if 3D rotation is currently in active/low-detail mode (auto, spin, or during drag)
  isRotationActive() {
    return this.dimension === 3 && this._rotationMode === "active";
  }

  setRenderMode(mode) {
    const next = mode === "line" ? "line" : "points";
    if (this._renderMode === next) return this._renderMode;
    this._renderMode = next;
    this.requestRender(true);
    return this._renderMode;
  }

  getRenderMode() {
    return this._renderMode;
  }

  toggleRenderMode() {
    return this.setRenderMode(this._renderMode === "line" ? "points" : "line");
  }

  setData(payload) {
    if (!this.svg || !this.canvas) this.mount();

    const status = typeof payload?.status === "string" ? payload.status.toLowerCase() : "ready";
    const isLiveTsne = status === "tsne_live";
    if (status !== "ready" && !isLiveTsne) {
      const message = sanitizeLabel(payload?.message, "Data preprocessing not finished yet.");
      renderStatus(this.container, message, status === "error" ? "error" : "info");
      return;
    }

    const dimension = Number(payload?.dimension) === 3 ? 3 : 2;
    const pcaMeta = payload?.pcaMetadata;
    const fullProjection = pcaMeta?.full_projection || null;
    const fullProjectionDim = pcaMeta?.full_projection_dimensions || null;
    
    const points = normalizePoints(payload?.points, dimension);
    if (!points.length) {
      renderStatus(this.container, "No scatter plot data available.", "muted");
      return;
    }

    const columns = normalizeColumns(payload?.columns, dimension);
    const columnLabels = normalizeColumnLabels(payload?.columnLabels, columns);

    const { coords: pointsF32, rowIndices } = toFloat32(points, dimension);
    const rowIndexLookup = new Map();
    for (let i = 0; i < rowIndices.length; i++) {
      const rowIndex = rowIndices[i];
      if (Number.isInteger(rowIndex) && !rowIndexLookup.has(rowIndex)) {
        rowIndexLookup.set(rowIndex, i);
      }
    }
    
    // Convert full projection to Float32Array if present
    let fullProjectionF32 = null;
    if (fullProjection && fullProjectionDim) {
      fullProjectionF32 = new Float32Array(fullProjection.flat());
    }
    
    const extents = [];
    for (let d = 0; d < dimension; d++) {
      const values = [];
      for (let i = 0; i < points.length; i++) {
        values.push(points[i].coordinates[d]);
      }
      extents.push(expandExtent(d3.extent(values)));
    }
    const origin = dimension === 3 ? computeCentroid(pointsF32, 3) : computeCentroid(pointsF32, 2);

    this._subjectSelection = normalizeSubjectSelection(this.options?.subjects);

    this._baseData = {
      pointsF32,
      rowIndices,
      rowIndexLookup,
      columns,
      columnLabels,
      subject: payload?.subject || null,
      multiSubject: payload?.multiSubject || false,
      subjectMapping: payload?.subjectMapping || null,
      extents,
      origin,
      clusterLabels: null,
    };
    this._clusterMeta = null;
    
    // Store PCA metadata if present
    this._pcaMetadata = payload?.pcaMetadata || null;
    // Store full projection for remapping (if available)
    this._pcaFullProjection = fullProjectionF32;
    this._pcaFullProjectionDim = fullProjectionDim || null;
    // Clear original coordinates when new data is loaded
    this._pcaOriginalCoords = null;
    
    // Invalidate sampling cache when data changes
    this._samplingCache.pointCount = null;

    const prevDim = this.dimension;
    this.dimension = dimension;

    this._applySubjectFilter({ skipRender: true });

    if (this.dimension === 2) {
      this._unbind3D();
      this._enable2DZoom();

      if (this.zoomSel && this.zoomBehavior) {
        this.zoomSel.call(this.zoomBehavior.transform, this.transform || d3.zoomIdentity);
      }
      this._rotationMode = "idle";
      this._axesEvery = ROTATION_SETTINGS.idle.axesEvery;
      this._quality = ROTATION_SETTINGS.idle.quality;
      if (this.canvas) this._setDprScale(ROTATION_SETTINGS.idle.dprScale);
      this._needsAxes = true;
      this.requestRender(true);
    } else {
      this._disable2DZoom();

      if (prevDim !== 3) {
        this.rotation = { ...DEFAULT_ROTATION };
        this._pendingAutoFit3D = true;
      }

      this._bind3D();
      this._startAutoSpin();
    }

    // Recreate selection tools (adapter depends on dimension)
    this._setupSelection(true);

      const hasPoints = this._updateFilteredStatus();

      this._liveMode = isLiveTsne ? (payload?.method || "tsne") : null;
      this.updateSize();
      if (this.dimension === 3 && hasPoints) {
        this.requestRender(true);
      }
      if (this.data?.subject) renderSubjectBadge(this.container, this.data.subject);
      else clearSubjectBadge(this.container);
    
    // Track reduction method from payload (preserve current if not specified)
    if (payload?.method) {
      this._reductionMethod = payload.method;
    }
    
    // Setup overlays based on current reduction method
    if (this._reductionMethod === 'pca') {
      this._updatePcaOverlay();
      // Destroy UMAP overlay if exists
      if (this._umapOverlay) {
        this._umapOverlay.destroy();
        this._umapOverlay = null;
      }
    } else if (this._reductionMethod === 'umap') {
      this._updateUmapOverlay();
      // Destroy PCA overlay if exists
      if (this._pcaOverlay) {
        this._pcaOverlay.destroy();
        this._pcaOverlay = null;
      }
    } else {
      // For tsne or other methods, destroy both overlays
      if (this._pcaOverlay) {
        this._pcaOverlay.destroy();
        this._pcaOverlay = null;
      }
      if (this._umapOverlay) {
        this._umapOverlay.destroy();
        this._umapOverlay = null;
      }
    }
  }

  getClusterPayload() {
    if (!this._baseData || this.dimension !== 2) return null;
    const points = this._baseData.pointsF32;
    const rowIndices = this._baseData.rowIndices;
    if (!points || !points.length) return null;
    return {
      dimension: 2,
      points: Array.from(points),
      rowIndices: rowIndices ? Array.from(rowIndices) : null,
    };
  }

  applyClusterLabels(payload) {
    if (!this._baseData || this.dimension !== 2) return false;
    const labels = Array.isArray(payload?.labels) ? payload.labels : null;
    if (!labels || !labels.length) return false;

    const baseRows = this._baseData.rowIndices || [];
    let clusterLabels = null;

    const rowIndices = Array.isArray(payload?.rowIndices) ? payload.rowIndices : null;
    if (rowIndices && this._baseData.rowIndexLookup) {
      clusterLabels = new Int32Array(baseRows.length);
      clusterLabels.fill(-1);
      for (let i = 0; i < labels.length; i++) {
        const rowIndex = rowIndices[i];
        const mappedIndex = this._baseData.rowIndexLookup.get(rowIndex);
        if (mappedIndex == null) continue;
        clusterLabels[mappedIndex] = labels[i];
      }
    } else if (labels.length === baseRows.length) {
      clusterLabels = Int32Array.from(labels);
    }

    if (!clusterLabels) return false;

    this._baseData.clusterLabels = clusterLabels;
    this._clusterMeta = {
      algorithm: payload?.algorithm || "dbscan",
      eps: payload?.eps,
      minSamples: payload?.minSamples,
    };

    this._applySubjectFilter();
    this._updateFilteredStatus();
    hideStatus(this.container);
    this.requestRender(true);
    return true;
  }

  clearClusterLabels() {
    if (!this._baseData) return false;
    if (!this._baseData.clusterLabels && !this._clusterMeta) return false;
    this._baseData.clusterLabels = null;
    this._clusterMeta = null;
    this._applySubjectFilter();
    this._updateFilteredStatus();
    hideStatus(this.container);
    this.requestRender(true);
    return true;
  }

  updateLivePoints(points) {
    const base = this._baseData || this.data;
    if (!base || !Array.isArray(points) || !points.length) return;

    const dimension = this.dimension === 3 ? 3 : 2;
    const normalized = normalizePoints(points, dimension);
    if (!normalized.length) return;

    const { coords: pointsF32, rowIndices } = toFloat32(normalized, dimension);
    const rowIndexLookup = new Map();
    for (let i = 0; i < rowIndices.length; i++) {
      const rowIndex = rowIndices[i];
      if (Number.isInteger(rowIndex) && !rowIndexLookup.has(rowIndex)) {
        rowIndexLookup.set(rowIndex, i);
      }
    }

    const extents = [];
    for (let d = 0; d < dimension; d++) {
      const values = [];
      for (let i = 0; i < normalized.length; i++) {
        values.push(normalized[i].coordinates[d]);
      }
      extents.push(expandExtent(d3.extent(values)));
    }
    const origin = dimension === 3 ? computeCentroid(pointsF32, 3) : computeCentroid(pointsF32, 2);

    this._baseData = {
      ...base,
      pointsF32,
      rowIndices,
      rowIndexLookup,
      extents,
      origin,
    };

    this._applySubjectFilter();
    this._updateFilteredStatus();
  }

  _getClusterPalette() {
    return Array.isArray(d3.schemeTableau10)
      ? d3.schemeTableau10
      : ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0ea5e9', '#f97316', '#059669', '#a855f7', '#ef4444'];
  }

  _getClusterLabelOrder(labels) {
    const unique = new Set();
    for (let i = 0; i < labels.length; i++) {
      const value = labels[i];
      if (!Number.isFinite(value)) continue;
      unique.add(value);
    }
    const ordered = Array.from(unique).filter(label => label >= 0).sort((a, b) => a - b);
    if (unique.has(-1)) {
      ordered.push(-1);
    }
    return ordered;
  }

  _buildClusterLegendItems() {
    if (!this.data || !this.data.clusterLabels || this.dimension !== 2) {
      return [];
    }

    const labels = this.data.clusterLabels;
    if (!labels.length) return [];

    const palette = this._getClusterPalette();
    const ordered = this._getClusterLabelOrder(labels);
    if (!ordered.length) return [];

    return ordered.map((label, idx) => {
      if (label === -1) {
        return { id: "noise", label: "Noise", color: "#9ca3af" };
      }
      const colorHex = palette[idx % palette.length];
      return { id: `cluster-${label}`, label: `Cluster ${label}`, color: colorHex };
    });
  }

  _computeClusterColors() {
    if (!this.data || !this.data.clusterLabels || this.dimension !== 2) {
      return null;
    }

    const labels = this.data.clusterLabels;
    const n = labels.length;
    if (!n) return null;

    const palette = this._getClusterPalette();
    const ordered = this._getClusterLabelOrder(labels);
    if (!ordered.length) return null;

    const colorByLabel = new Map();
    ordered.forEach((label, idx) => {
      if (label === -1) {
        colorByLabel.set(label, [156, 163, 175]);
        return;
      }
      const colorHex = palette[idx % palette.length];
      const rgb = d3.color(colorHex).rgb();
      colorByLabel.set(label, [rgb.r, rgb.g, rgb.b]);
    });

    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const label = labels[i];
      const rgb = colorByLabel.get(label) || [37, 99, 235];
      colors[i * 3] = rgb[0];
      colors[i * 3 + 1] = rgb[1];
      colors[i * 3 + 2] = rgb[2];
    }

    return colors;
  }

  /**
   * Compute subject color assignments from subjectMapping.
   * Returns a Float32Array where each group of 3 values represents RGB for a point index.
   * Returns null if no subject mapping exists.
   */
  _computeSubjectColors() {
    if (!this.data || !this.data.subjectMapping || !this.data.multiSubject) {
      return null;
    }

    const subjectMapping = this.data.subjectMapping;
    const rowIndices = this.data.rowIndices;
    const n = rowIndices.length;

    if (n === 0) return null;

    // Build an array of [subjectId, [startRow, endRow]] pairs and sort by startRow
    const subjectRanges = Object.entries(subjectMapping)
      .map(([subjectId, range]) => ({ subjectId, start: range[0], end: range[1] }))
      .sort((a, b) => a.start - b.start);

    if (subjectRanges.length === 0) return null;

    // Use d3.schemeTableau10 or a default palette
    const palette = Array.isArray(d3.schemeTableau10)
      ? d3.schemeTableau10
      : ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0ea5e9', '#f97316', '#059669', '#a855f7', '#ef4444'];

    // Assign colors to subjects
    const subjectColors = new Map();
    subjectRanges.forEach((range, idx) => {
      const colorHex = palette[idx % palette.length];
      const rgb = d3.color(colorHex).rgb();
      subjectColors.set(range.subjectId, [rgb.r, rgb.g, rgb.b]);
    });

    // Build a color array for each point based on its rowIndex
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const rowIndex = rowIndices[i];
      let rgb = [37, 99, 235]; // default blue

      // Find which subject this rowIndex belongs to
      for (const range of subjectRanges) {
        if (rowIndex >= range.start && rowIndex <= range.end) {
          rgb = subjectColors.get(range.subjectId);
          break;
        }
      }

      colors[i * 3] = rgb[0];
      colors[i * 3 + 1] = rgb[1];
      colors[i * 3 + 2] = rgb[2];
    }

    return colors;
  }

  _filterDataBySubjects(baseData) {
    if (!baseData) return null;
    const selection = normalizeSubjectSelection(this._subjectSelection);
    if (!baseData.multiSubject || !selection.length) return baseData;
    const mapping = baseData.subjectMapping;
    if (!mapping || typeof mapping !== "object") return baseData;

    const ranges = Object.entries(mapping)
      .map(([subjectId, range]) => {
        const id = normalizeSubjectId(subjectId);
        const start = Array.isArray(range) ? Number(range[0]) : null;
        const end = Array.isArray(range) ? Number(range[1]) : null;
        if (!id || !selection.includes(id)) return null;
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        return { id, start: Math.min(start, end), end: Math.max(start, end) };
      })
      .filter(Boolean);

    if (!ranges.length) return baseData;

    const dim = baseData.dimension === 3 ? 3 : 2;
    const sourcePoints = baseData.pointsF32 || new Float32Array();
    const sourceRows = baseData.rowIndices || new Int32Array();
    const keepIndices = [];

    for (let i = 0; i < sourceRows.length; i++) {
      const rowIndex = sourceRows[i];
      if (!Number.isInteger(rowIndex)) continue;
      const keep = ranges.some(range => rowIndex >= range.start && rowIndex <= range.end);
      if (keep) keepIndices.push(i);
    }

    if (!keepIndices.length) {
      return {
        ...baseData,
        pointsF32: new Float32Array(),
        rowIndices: new Int32Array(),
        rowIndexLookup: new Map(),
        extents: baseData.extents,
        origin: baseData.origin,
      };
    }

    if (keepIndices.length === sourceRows.length) {
      return baseData;
    }

    const filteredPoints = new Float32Array(keepIndices.length * dim);
    const filteredRows = new Int32Array(keepIndices.length);
    const sourceClusterLabels = baseData.clusterLabels;
    const filteredClusterLabels = sourceClusterLabels
      ? new Int32Array(keepIndices.length)
      : null;
    for (let j = 0; j < keepIndices.length; j++) {
      const sourceIdx = keepIndices[j];
      filteredRows[j] = sourceRows[sourceIdx];
      if (filteredClusterLabels) {
        filteredClusterLabels[j] = sourceClusterLabels[sourceIdx];
      }
      for (let d = 0; d < dim; d++) {
        filteredPoints[j * dim + d] = sourcePoints[sourceIdx * dim + d];
      }
    }

    const extents = [];
    for (let d = 0; d < dim; d++) {
      let min = Infinity;
      let max = -Infinity;
      for (let j = 0; j < filteredRows.length; j++) {
        const value = filteredPoints[j * dim + d];
        if (value < min) min = value;
        if (value > max) max = value;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        extents.push(baseData.extents?.[d] || [0, 1]);
      } else {
        extents.push(expandExtent([min, max]));
      }
    }

    const rowIndexLookup = new Map();
    filteredRows.forEach((rowIndex, idx) => {
      if (Number.isInteger(rowIndex) && !rowIndexLookup.has(rowIndex)) {
        rowIndexLookup.set(rowIndex, idx);
      }
    });

    const origin = filteredRows.length
      ? (dim === 3 ? computeCentroid(filteredPoints, 3) : computeCentroid(filteredPoints, 2))
      : baseData.origin;

    return {
      ...baseData,
      pointsF32: filteredPoints,
      rowIndices: filteredRows,
      rowIndexLookup,
      extents,
      origin,
      clusterLabels: filteredClusterLabels,
    };
  }

  _applySubjectFilter({ skipRender = false } = {}) {
    if (!this._baseData) return;
    this.data = this._filterDataBySubjects(this._baseData);
    this._samplingCache.pointCount = null;
    this._needsAxes = true;

    let timesteps = null;
    if (this._baseData?.multiSubject && this._baseData?.subjectMapping) {
      const mapping = this._baseData.subjectMapping;
      const selection = normalizeSubjectSelection(this._subjectSelection);
      
      // Calculate max points per subject
      let maxSubjectPoints = 0;
      const subjectsToCheck = selection.length > 0 ? selection : Object.keys(mapping);
      
      subjectsToCheck.forEach(subjectId => {
        const range = mapping[subjectId];
        if (Array.isArray(range) && range.length >= 2) {
          const start = Number(range[0]);
          const end = Number(range[1]);
          if (Number.isFinite(start) && Number.isFinite(end)) {
            const pointCount = Math.abs(end - start) + 1;
            maxSubjectPoints = Math.max(maxSubjectPoints, pointCount);
          }
        }
      });
      
      timesteps = maxSubjectPoints > 0 ? maxSubjectPoints : null;
    } else {
      timesteps = this.data?.rowIndices?.length ?? null;
    }

    if (Number.isInteger(timesteps) && timesteps > 0) {
      const projectName = this.options?.projectName || null;
      const sheetId = this.options?.sheetId || null;
      const chartId = this._chartId || null;
      if (projectName) {
        document.dispatchEvent(new CustomEvent('time-controls:runtime-timesteps', {
          detail: { projectName, sheetId, chartId, timesteps },
        }));
      }
    }

    if (!skipRender) {
      this.requestRender(true);
    }
  }

  _updateFilteredStatus() {
    const hasPoints = Boolean(this.data && this.data.pointsF32 && this.data.pointsF32.length);
    if (!hasPoints) {
      renderStatus(this.container, "No points for the selected subjects.", "muted");
      return false;
    }
    hideStatus(this.container);
    return true;
  }

  setSubjectSelection(subjects) {
    const next = normalizeSubjectSelection(subjects);
    const current = normalizeSubjectSelection(this._subjectSelection);
    const sameLength = next.length === current.length;
    const sameValues = sameLength && next.every((value, idx) => value === current[idx]);
    if (sameValues) return;
    this._subjectSelection = next;
    if (this.options) {
      this.options.subjects = next;
    }
    this._applySubjectFilter();
    if (this.data) {
      this._updateFilteredStatus();
    }
  }

  _buildLegendItems() {
    const clusterItems = this._buildClusterLegendItems();
    if (clusterItems.length) {
      return clusterItems;
    }

    if (!this.data || !this.data.multiSubject || !this.data.subjectMapping) {
      return [];
    }

    const subjectMapping = this.data.subjectMapping;
    const palette = Array.isArray(d3.schemeTableau10)
      ? d3.schemeTableau10
      : ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0ea5e9', '#f97316', '#059669', '#a855f7', '#ef4444'];

    const subjectRanges = Object.entries(subjectMapping)
      .map(([subjectId, range]) => ({ subjectId, start: range[0], end: range[1] }))
      .sort((a, b) => a.start - b.start);

    // Get selected subjects for filtering
    const selection = normalizeSubjectSelection(this._subjectSelection);
    const hasSelection = selection.length > 0;

    const items = [];
    const { subject_names = {}, subjectNames = {} } = this.options || {};
    const nameMap = Object.assign({}, subject_names, subjectNames);

    subjectRanges.forEach((range, idx) => {
      const id = normalizeSubjectId(range.subjectId);
      if (!id) return;
      
      // Filter: only include subjects that are selected (or all if no selection)
      if (hasSelection && !selection.includes(id)) {
        return;
      }
      
      const customLabel = nameMap?.[id] || nameMap?.[range.subjectId];
      const label = customLabel || `Subject ${id}`;
      const colorHex = palette[idx % palette.length];
      items.push({ id, label, color: colorHex });
    });

    return items;
  }

  _renderLegend(legendGroup, width, height, margins) {
    legendGroup.selectAll("*").remove();

    const items = this._buildLegendItems();
    if (!items.length) return;

    const legendMargin = 8;
    const itemHeight = 18;
    const colorBoxSize = 12;
    const colorBoxPadding = 6;
    const textMarginLeft = colorBoxSize + colorBoxPadding;
    const textMarginRight = 8;
    const paddingX = 8;
    const paddingY = 8;

    // Calculate legend width based on longest label
    const tempSvg = d3.select("body").append("svg").style("visibility", "hidden").style("position", "absolute");
    let maxLabelWidth = 0;
    items.forEach(item => {
      const text = tempSvg
        .append("text")
        .attr("font-size", "11px")
        .attr("font-family", "system-ui, -apple-system, sans-serif")
        .text(item.label);
      const bbox = text.node().getBBox();
      maxLabelWidth = Math.max(maxLabelWidth, bbox.width);
      text.remove();
    });
    tempSvg.remove();

    const contentWidth = Math.max(100, maxLabelWidth + textMarginLeft + textMarginRight);
    const legendWidth = contentWidth + paddingX * 2;
    const legendHeight = Math.max(30, items.length * itemHeight + paddingY * 2);

    const innerWidth = Math.max(8, width - margins.left - margins.right);
    const innerHeight = Math.max(8, height - margins.top - margins.bottom);
    const legendX = margins.left + innerWidth - legendWidth - legendMargin;
    const legendY = margins.top + innerHeight - legendHeight - legendMargin;

    const bg = legendGroup
      .append("rect")
      .attr("x", legendX)
      .attr("y", legendY)
      .attr("width", legendWidth)
      .attr("height", legendHeight)
      .attr("fill", "#ffffff")
      .attr("stroke", "#d1d5db")
      .attr("stroke-width", 1)
      .attr("rx", 4)
      .attr("opacity", 0.95);

    const container = legendGroup
      .append("g")
      .attr("transform", `translate(${legendX + paddingX},${legendY + paddingY})`);

    items.forEach((item, idx) => {
      const y = idx * itemHeight;

      container
        .append("rect")
        .attr("x", 0)
        .attr("y", y)
        .attr("width", colorBoxSize)
        .attr("height", colorBoxSize)
        .attr("fill", item.color)
        .attr("stroke", "#999")
        .attr("stroke-width", 0.5)
        .attr("rx", 2);

      container
        .append("text")
        .attr("x", textMarginLeft)
        .attr("y", y + colorBoxSize / 2)
        .attr("dy", "0.35em")
        .attr("font-size", "11px")
        .attr("fill", "#1f2937")
        .attr("font-family", "system-ui, -apple-system, sans-serif")
        .style("user-select", "none")
        .text(item.label);
    });
  }

  // ---- internal rendering ----
  requestRender(forceAxes) {
    if (forceAxes) this._needsAxes = true;
    if (this._scheduled) return;
    this._scheduled = true;
    requestAnimationFrame(() => {
      this._scheduled = false;
      this.render();
    });
  }

  _setRotationMode(mode) {
    if (this.dimension !== 3) return;
    const next = mode === "active" ? "active" : "idle";
    if (this._rotationMode !== next) {
      this._rotationMode = next;
      this._rotationFrame = 0;
      this._needsAxes = true;
    }
 
    // Base config from rotation state
    const config = ROTATION_SETTINGS[this._rotationMode];
 
    // Performance Mode is always ON - always use sampling quality
    // Visual quality stays the same (fog, outline, etc.), only sampling differs
    this._quality = ROTATION_SETTINGS.active.quality;  // Always use sampling
    
    // Axes rendering: use config axes frequency (more frequent when idle, less when active)
    this._axesEvery = Math.max(1, config.axesEvery | 0);
 
    if (this.canvas) {
      this._setDprScale(config.dprScale);
    }
 
    // Notify UI listeners (for enabling/disabling Performance button etc.)
    this._emitUiState();
  }

  _afterRotationFrame() {
    if (this.dimension !== 3) return;
    this._rotationFrame = (this._rotationFrame + 1) | 0;
    if (this._rotationFrame % this._axesEvery === 0) {
      this._needsAxes = true;
    }
  }

  // ---- UI event emitter (bubbles up from the chart container) ----
  _emitUiState() {
    try {
      // Show filtered visibility toggle when either time range OR point selection is active
      const hasActiveFilter = !!this._activeTimeRange || (this._activePointSelection && this._activePointSelection.size > 0);
      
      const detail = {
        rotating: this._rotationMode === "active",
        performance: true,  // Always true - Performance Mode is always ON
        renderMode: this._renderMode,
        // Extended UI state - rangeActive now includes both time range and point selection filters
        rangeActive: hasActiveFilter,
        filteredVisibility: this.getFilteredVisibilityMode(),
        // PCA overlay state
        pcaSelection: this._pcaComponentSelection || null,
      };
      this.container?.dispatchEvent?.(new CustomEvent("scatter:ui-state", { detail, bubbles: true }));
    } catch (_) {
      // no-op
    }
  }

  _onInteract() {
    this._stopSpin();
    this._stopAutoSpin(false); // stoppt Auto-Spin, behält aber Rotationsmodus
    this._interacting = true;
    if (this.dimension === 3) this._setRotationMode("active");
    this.requestRender(false);

    if (this._interactTimer) clearTimeout(this._interactTimer);
    this._interactTimer = setTimeout(() => {
      this._interacting = false;
      if (this.dimension === 3) this._setRotationMode("idle");
      this.requestRender(true);
      if (this.dimension === 3 && this._autoSpinEnabled) this._startAutoSpin();
    }, INTERACTION_IDLE_MS);
  }

  // --- 3D Auto-Fit Helper ---
  _autoFit3DOnceIfPending() {
    if (!this._pendingAutoFit3D || !this.data || this.dimension !== 3) return;

    const { width, height } = this.currentSize;
    const innerWidth  = Math.max(40, width  - MARGINS.left - MARGINS.right);
    const innerHeight = Math.max(40, height - MARGINS.top  - MARGINS.bottom);

    const [xExtent, yExtent, zExtent] = this.data.extents;
    const xScale = d3.scaleLinear().domain(xExtent).range([-0.5, 0.5]);
    const yScale = d3.scaleLinear().domain(yExtent).range([-0.5, 0.5]);
    const zScale = d3.scaleLinear().domain(zExtent).range([-0.5, 0.5]);

    const usePerspective = !!STYLE_3D.perspective.enabled;
    const zEye = STYLE_3D.perspective.zEye;

    const cosYaw = Math.cos(this.rotation.yaw);
    const sinYaw = Math.sin(this.rotation.yaw);
    const cosPitch = Math.cos(this.rotation.pitch);
    const sinPitch = Math.sin(this.rotation.pitch);

    function projectUnit(x, y, z) {
      const nx = xScale(x);
      const ny = yScale(y);
      const nz = zScale(z);
      const yawX = nx * cosYaw + nz * sinYaw;
      const yawZ = -nx * sinYaw + nz * cosYaw;
      const pitchY = ny * cosPitch - yawZ * sinPitch;
      const pitchZ = ny * sinPitch + yawZ * cosPitch;

      if (usePerspective) {
        const zCam = (pitchZ + 1.0) * 0.5 * 2.0;
        const k = 1.0 / Math.max(0.1, zEye + zCam);
        return { x: yawX * innerWidth * 0.65 * k, y: pitchY * innerHeight * 0.65 * k };
      } else {
        return { x: yawX * innerWidth * 0.65, y: pitchY * innerHeight * 0.65 };
      }
    }

    const n = this.data.pointsF32.length / 3;
    if (n === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const step = n > 20000 ? Math.ceil(n / 20000) : 1;
    for (let i = 0; i < n; i += step) {
      const x = this.data.pointsF32[i * 3];
      const y = this.data.pointsF32[i * 3 + 1];
      const z = this.data.pointsF32[i * 3 + 2];
      const p = projectUnit(x, y, z);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);

    const targetX = innerWidth * 1.05;
    const targetY = innerHeight * 1.05;
    let sX = targetX / spanX;
    let sY = targetY / spanY;
    let s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(sX, sY)));

    this.rotation.scale = s;
    this._pendingAutoFit3D = false;
  }

  render() {
    if (!this.svg || !this.canvas || !this.data) return;

    const { width, height } = this.currentSize;
    const margins = this.dimension === 2 ? this._margins2D : MARGINS;
    const plotGroup = this.svg.select(".scatter-chart__plot");
    const axesGroup = this.svg.select(".scatter-chart__axes");
    const legendGroup = this.svg.select(".scatter-chart__legend");

    plotGroup.attr("transform", `translate(${margins.left},${margins.top})`);
    axesGroup.attr("transform", `translate(${margins.left},${margins.top})`);

    const innerWidth  = Math.max(8, width  - margins.left - margins.right);
    const innerHeight = Math.max(8, height - margins.top  - margins.bottom);
    const highlightOptions = this._buildHighlightOptions();

    const clusterColors = this.dimension === 2 ? this._computeClusterColors() : null;
    const subjectColors = clusterColors ? null : this._computeSubjectColors();
    const pointColors = clusterColors || subjectColors;

    if (this.dimension === 2) {
      const [xExtent, yExtent] = this.data.extents;
      const xScale = d3.scaleLinear().domain(xExtent).range([0, innerWidth]);
      const yScale = d3.scaleLinear().domain(yExtent).range([innerHeight, 0]);

      // Get cached sampled indices (or null for 100%)
      const pointCount = this.data.pointsF32.length / 2;
      const sampledIndices = this._getSampledIndices(pointCount);

      render2DCanvas(
        this.ctx,
        width,
        height,
        this.data.pointsF32,
        xScale,
        yScale,
        this.transform,
        margins,
        this._renderMode,
        highlightOptions,
        { performanceMode: true, activeRange: this._activeTimeRange, pointSelection: this._activePointSelection, filteredVisibility: this.getFilteredVisibilityMode(), sampledIndices, pointColors }
      );
      drawAxes2D(axesGroup, innerWidth, innerHeight, xScale, yScale, this.transform, this.data.columnLabels);
      this._renderLegend(legendGroup, width, height, margins);
    } else {
      this._autoFit3DOnceIfPending();

      this._runtime3D.quality = this._quality;
      this._runtime3D.colorLUT = this._colorLUT;
      this._runtime3D.fogBgParsed = this._fogBg || (this._fogBg = d3.color(STYLE_3D.fog.background));

      // Get cached sampled indices (or null for 100%)
      const pointCount = this.data.pointsF32.length / 3;
      const sampledIndices = this._getSampledIndices(pointCount);

      render3DCanvas(
        this.ctx,
        width,
        height,
        this.data.pointsF32,
        this.rotation,
        this.data.extents,
        this._runtime3D,
        margins,
        highlightOptions,
        this._renderMode,
        sampledIndices,
        subjectColors
      );

      if (this._needsAxes) {
        drawAxes3D(axesGroup, width, height, this.data.columnLabels, this.data.extents, this.rotation, this.data.origin, margins);
        this._needsAxes = false;
      }
      this._renderLegend(legendGroup, width, height, margins);
    }
  }

  // ---- interaction toggles ----
  _enable2DZoom() {
    if (!this.zoomSel || !this.zoomBehavior) return;
    this.zoomSel.on(".zoom", null);
    this.zoomSel.call(this.zoomBehavior);

    const t = this.transform || d3.zoomIdentity;
    this.zoomSel.call(this.zoomBehavior.transform, t);
    this._needsAxes = true;
    this.requestRender(true);
  }

  _disable2DZoom() {
    if (!this.zoomSel) return;
    this.zoomSel.on(".zoom", null);
  }

  _bind3D() {
    if (this.unbind3D) return;
    this.unbind3D = bind3DInteractionsCanvas(
      this.container,
      this.rotation,
      () => this._onInteract(),
      (vel) => this._startSpinFromPointerVelocity(vel),
      () => this._afterRotationFrame()
    );
  }

  _unbind3D() {
    if (!this.unbind3D) return;
    this.unbind3D();
    this.unbind3D = null;
  }

  // ---- inertia spin ----
  _startSpinFromPointerVelocity({ vx, vy }) {
    const k = 0.0167 * 0.9; // ~60fps scaling
    this._spinVel.yaw   = vx * k;       // horizontal → yaw
    this._spinVel.pitch = -vy * k;      // invert vertical
    if (Math.abs(this._spinVel.yaw) < this._spinMin && Math.abs(this._spinVel.pitch) < this._spinMin) {
      // Velocity too small for inertia spin - transition immediately to idle/auto-spin
      // Clear the interaction timer to prevent delayed state change
      if (this._interactTimer) {
        clearTimeout(this._interactTimer);
        this._interactTimer = null;
      }
      this._interacting = false;
      
      // Transition to idle mode and restart auto-spin if enabled
      if (this.dimension === 3) {
        this._setRotationMode("idle");
        this.requestRender(true);
        if (this._autoSpinEnabled) this._startAutoSpin();
      }
      return;
    }
    this._stopAutoSpin(false);
    if (this.dimension === 3) this._setRotationMode("active");
    this._spinLoop();
  }

  _spinLoop() {
    this._stopSpin();
    const animate = () => {
      if (this._interacting) { this._stopSpin(); return; }
      if (this.dimension === 3) this._setRotationMode("active");
      this.rotation.yaw   += this._spinVel.yaw;
      this.rotation.pitch  = clampPitch(this.rotation.pitch + this._spinVel.pitch);
      this._spinVel.yaw   *= this._spinDamp;
      this._spinVel.pitch *= this._spinDamp;
      this._afterRotationFrame();
      this.requestRender(false);
      if (Math.abs(this._spinVel.yaw) < this._spinMin && Math.abs(this._spinVel.pitch) < this._spinMin) {
        this._stopSpin();
        // Clear the interaction timer to prevent redundant state transitions
        if (this._interactTimer) {
          clearTimeout(this._interactTimer);
          this._interactTimer = null;
        }
        this._interacting = false;
        if (this.dimension === 3) this._setRotationMode("idle");
        if (this._autoSpinEnabled && !this._interacting) this._startAutoSpin();
        return;
      }
      this._spinRAF = requestAnimationFrame(animate);
    };
    this._spinRAF = requestAnimationFrame(animate);
  }

  _stopSpin() {
    if (this._spinRAF) cancelAnimationFrame(this._spinRAF);
    this._spinRAF = null;
  }

  // ---- gentle auto-rotation (idle animation) ----
  _startAutoSpin() {
    if (!this._autoSpinEnabled || this._autoSpinRAF || this.dimension !== 3) return;

    this._setRotationMode("active");
    this._lastAutoSpinTime = performance.now();

    const tick = (timestamp) => {
      if (this._interacting || document.hidden) {
        this._lastAutoSpinTime = timestamp;
        this._autoSpinRAF = requestAnimationFrame(tick);
        return;
      }

      // Time-based rotation for consistent visual speed regardless of frame rate
      const deltaTime = timestamp - this._lastAutoSpinTime;
      this._lastAutoSpinTime = timestamp;
      
      // Convert speed from radians/second to radians based on actual elapsed time
      const deltaYaw = (this._autoSpinSpeedPerMs / 1000) * deltaTime;
      this.rotation.yaw += deltaYaw;
      
      this._afterRotationFrame();

      // Direkt rendern (keine zweite rAF-Schicht)
      this.render();

      this._autoSpinRAF = requestAnimationFrame(tick);
    };
    this._autoSpinRAF = requestAnimationFrame(tick);
  }

  _stopAutoSpin(restore = true) {
    if (this._autoSpinRAF) cancelAnimationFrame(this._autoSpinRAF);
    this._autoSpinRAF = null;
    this._lastAutoSpinTime = null;

    if (!restore || this.dimension !== 3) return;

    this._setRotationMode("idle");
    if (this.data) {
      this.render();
    }
  }

  // ---- DPR-Scaling Helper (optional) ----
  _setDprScale(scale = 1.0) {
    if (!this.canvas) return;
    const cssW = this.currentSize.width, cssH = this.currentSize.height;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const eff = Math.max(0.5, Math.min(1.0, scale)) * dpr; // clamp 0.5–1.0
    this.canvas.width = Math.max(1, Math.floor(cssW * eff));
    this.canvas.height = Math.max(1, Math.floor(cssH * eff));
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(eff, 0, 0, eff, 0, 0);
    this.ctx = ctx;
  }

  // Exposed for 3D selection adapter to match plot area margins
  getCurrentMargins() {
    return this.dimension === 2 ? this._margins2D : MARGINS;
  }

  // ----- selection tools integration (visual-only) -----
  _setupSelection(recreate = false) {
    try {
      if (recreate) this._destroySelection();
      // Ensure SVG exists
      if (!this.svg || !this.container) return;

      // Adapter per dimension
      if (this.dimension === 2) {
        this._selectionAdapter = create2DSelectionAdapter(this);
      } else if (this.dimension === 3) {
        this._selectionAdapter = create3DSelectionAdapter(this);
      } else {
        this._selectionAdapter = null;
      }

      if (!this._selectionAdapter) return;

      // Build selection manager
      this._selectionMgr = createSelectionManager({
        container: this.container,
        svg: this.svg.node ? this.svg.node() : this.svg, // d3 selection or DOM
        getProjectedPoints: this._selectionAdapter.getProjectedPoints,
        getPlotRect: this._selectionAdapter.getPlotRect,
        onActivate: (tool) => {
          this._selectionAdapter.onActivate?.(tool);
          this._updateSelectionToolbarState(tool);
        },
        onDeactivate: (prevTool) => {
          this._selectionAdapter.onDeactivate?.(prevTool);
          this._updateSelectionToolbarState(null);
        },
        onSelectionChange: (selectedSet) => {
          this._updateSelectionToolbarState(this._selectionMgr?.getActiveTool?.());
        },
        cursorForTool: this._selectionAdapter.cursorForTool,
        is3D: this._selectionAdapter.is3D ?? false  // Pass 3D flag from adapter
      });

      // Create toolbar UI if not present
      this._initSelectionToolbar();
      this._updateSelectionToolbarState(this._selectionMgr?.getActiveTool?.());
    } catch (err) {
      console.warn("[ScatterChart] Failed to initialize selection tools", err);
    }
  }

  _destroySelection() {
    try {
      if (this._selectionMgr && typeof this._selectionMgr.destroy === "function") {
        this._selectionMgr.destroy();
      }
    } catch (_) {}
    this._selectionMgr = null;
    this._selectionAdapter = null;
    if (this._selectionToolbar && this._selectionToolbar.parentNode) {
      this._selectionToolbar.parentNode.removeChild(this._selectionToolbar);
    }
    this._selectionToolbar = null;
  }

  _initSelectionToolbar() {
    if (!this.container) return;
    // Remove previous
    if (this._selectionToolbar && this._selectionToolbar.parentNode) {
      this._selectionToolbar.parentNode.removeChild(this._selectionToolbar);
      this._selectionToolbar = null;
    }
    // Build toolbar
    const bar = document.createElement("div");
    bar.className = "scatter-chart__selection-toolbar";
    Object.assign(bar.style, {
      position: "absolute",
      top: "1px",           // moved closer to top edge
      right: "1px",         // moved closer to right edge
      display: "inline-flex",
      gap: "4px",
      padding: "4px",
      borderRadius: "9999px",
      background: "rgba(255,255,255,0.85)",
      backdropFilter: "blur(4px)",
      border: "1px solid rgba(148,163,184,0.35)",
      boxShadow: "0 2px 8px rgba(15,23,42,0.12)",
      zIndex: "20",
      pointerEvents: "auto",
    });
    // Prevent 3D rotation handlers from intercepting toolbar interactions
    const stop = (e) => { e.stopPropagation(); };
    bar.addEventListener("pointerdown", stop);
    bar.addEventListener("pointermove", stop);
    bar.addEventListener("pointerup", stop);
    bar.addEventListener("pointercancel", stop);
    bar.addEventListener("dblclick", stop);
    bar.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: false });

    const mkBtn = (tool, label, title, icon) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scatter-selection__btn";
      btn.dataset.tool = tool;
      btn.setAttribute("data-tool-button", "true");
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("title", title);
      btn.setAttribute("aria-label", label);
      Object.assign(btn.style, {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "24px",                 // h-6 w-6 (exact match to header button size)
        height: "24px",                // h-6 w-6 (exact match to header button size)
        borderRadius: "9999px",        // rounded-full
        border: "1px solid #d1d5db",   // border-gray-300
        background: "#ffffff",
        color: "#4b5563",              // text-gray-600
        fontSize: "14px",
        boxShadow: "0 1px 2px rgba(15,23,42,0.08)",
        transition: "border-color 0.2s ease, color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease",
      });
      btn.addEventListener("mouseenter", () => {
        btn.style.borderColor = "#60a5fa"; // hover:border-blue-400
        btn.style.color = "#3b82f6";       // hover:text-blue-500
      });
      btn.addEventListener("mouseleave", () => {
        const pressed = btn.getAttribute("aria-pressed") === "true";
        btn.style.borderColor = pressed ? "#60a5fa" : "#d1d5db";        // border-blue-400 when active
        btn.style.color = pressed ? "#2563eb" : "#4b5563";              // text-blue-500 when active
      });
      btn.addEventListener("focus", () => {
        btn.style.outline = "none";
        btn.style.boxShadow = "0 0 0 2px rgba(59,130,246,0.5)"; // focus-visible:ring-2 focus-visible:ring-blue-500
      });
      btn.addEventListener("blur", () => {
        const pressed = btn.getAttribute("aria-pressed") === "true";
        btn.style.boxShadow = pressed ? "0 0 0 1px rgba(59,130,246,0.28)" : "0 1px 2px rgba(15,23,42,0.08)";
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (!this._selectionMgr) return;
        const current = this._selectionMgr.getActiveTool?.();
        const t = btn.dataset.tool;
        if (current === t) {
          this._selectionMgr.deactivate();
        } else {
          this._selectionMgr.activate(t);
        }
      });
      // Keyboard toggle (Enter/Space)
      btn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          btn.click();
        }
      });

      // icon (string or SVG element)
      if (typeof icon === "string") {
        const span = document.createElement("span");
        span.setAttribute("aria-hidden", "true");
        span.textContent = icon;
        btn.appendChild(span);
      } else if (icon && typeof icon === "object" && icon.nodeType === 1) {
        icon.setAttribute("aria-hidden", "true");
        btn.appendChild(icon);
      } else {
        const span = document.createElement("span");
        span.setAttribute("aria-hidden", "true");
        span.textContent = "?";
        btn.appendChild(span);
      }

      return btn;
    };

    // Create a cleaner rope-loop lasso icon (SVG, stroke-based, matches header icon style)
    const buildRopeIcon = () => {
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", "0 0 20 20");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "1.6");
      svg.style.width = "20px";
      svg.style.height = "20px";

      const p1 = document.createElementNS(NS, "path");
      p1.setAttribute("stroke-linecap", "round");
      p1.setAttribute("stroke-linejoin", "round");
      // loop with subtle variation
      p1.setAttribute("d", "M8 6.5c2-2.2 5.2-2 6.8 0 1.4 1.8 1.2 4.4-.6 5.8-1.7 1.3-4.1 1.1-5.6-.5-1.1-1.2-1.1-2.8 0-4 1.1-1.2 2.9-1.2 4 0 .9 1 .8 2.4-.3 3.2");
      const p2 = document.createElementNS(NS, "path");
      p2.setAttribute("stroke-linecap", "round");
      p2.setAttribute("stroke-linejoin", "round");
      // trailing rope
      p2.setAttribute("d", "M7 13.5c-1.2 1.1-2.5 1.8-4 2");

      svg.appendChild(p1);
      svg.appendChild(p2);
      return svg;
    };

    // Build cancel button (X)
    const btnCancel = document.createElement("button");
    btnCancel.type = "button";
    btnCancel.className = "scatter-selection__action-btn";
    btnCancel.dataset.action = "cancel";
    btnCancel.setAttribute("data-action-button", "true");
    btnCancel.setAttribute("title", "Cancel selection");
    btnCancel.setAttribute("aria-label", "Cancel selection");
    Object.assign(btnCancel.style, {
      display: "none",  // Hidden by default
      alignItems: "center",
      justifyContent: "center",
      width: "24px",
      height: "24px",
      borderRadius: "9999px",
      border: "1px solid #d1d5db",
      background: "#ffffff",
      color: "#dc2626",  // red-600 for cancel
      fontSize: "14px",
      fontWeight: "600",
      boxShadow: "0 1px 2px rgba(15,23,42,0.08)",
      transition: "border-color 0.2s ease, color 0.2s ease, background-color 0.2s ease",
    });
    btnCancel.textContent = "✕";
    btnCancel.addEventListener("mouseenter", () => {
      btnCancel.style.borderColor = "#f87171";  // hover:border-red-400
      btnCancel.style.color = "#ef4444";        // hover:text-red-500
    });
    btnCancel.addEventListener("mouseleave", () => {
      btnCancel.style.borderColor = "#d1d5db";
      btnCancel.style.color = "#dc2626";
    });
    btnCancel.addEventListener("click", (e) => {
      e.preventDefault();
      if (this._selectionMgr) {
        this._selectionMgr.clearSelection();
      }
    });

    // Build confirm button (✓)
    const btnConfirm = document.createElement("button");
    btnConfirm.type = "button";
    btnConfirm.className = "scatter-selection__action-btn";
    btnConfirm.dataset.action = "confirm";
    btnConfirm.setAttribute("data-action-button", "true");
    btnConfirm.setAttribute("title", "Confirm selection");
    btnConfirm.setAttribute("aria-label", "Confirm selection");
    Object.assign(btnConfirm.style, {
      display: "none",  // Hidden by default
      alignItems: "center",
      justifyContent: "center",
      width: "24px",
      height: "24px",
      borderRadius: "9999px",
      border: "1px solid #d1d5db",
      background: "#ffffff",
      color: "#16a34a",  // green-600 for confirm
      fontSize: "14px",
      fontWeight: "600",
      boxShadow: "0 1px 2px rgba(15,23,42,0.08)",
      transition: "border-color 0.2s ease, color 0.2s ease, background-color 0.2s ease",
    });
    btnConfirm.textContent = "✓";
    btnConfirm.addEventListener("mouseenter", () => {
      btnConfirm.style.borderColor = "#4ade80";  // hover:border-green-400
      btnConfirm.style.color = "#22c55e";        // hover:text-green-500
    });
    btnConfirm.addEventListener("mouseleave", () => {
      btnConfirm.style.borderColor = "#d1d5db";
      btnConfirm.style.color = "#16a34a";
    });
    btnConfirm.addEventListener("click", (e) => {
      e.preventDefault();
      if (!this._selectionMgr) return;
      
      // Get the confirmed selection from the selection manager
      const selection = this._selectionMgr.confirmSelection();
      
      if (selection && selection.size > 0 && this.sheetId) {
        // Store the selection in persistent state
        try {
          setPointSelection(this.sheetId, selection);
        } catch (error) {
          console.error("[ScatterChart] Failed to store point selection", error);
        }
      }
      
      // Deactivate the selection tool (this hides the overlay and clears temporary state)
      this._selectionMgr.deactivate();
      
      // Clear the selection manager's internal state
      this._selectionMgr.clearSelection();
      
      // Close the selection toolbox after applying the selection
      this.setSelectionToolbarVisible(false);
      
      // Trigger render to show the committed selection
      this.requestRender(true);
    });

    const btnLasso = mkBtn(SelectionTools.LASSO, "Lasso selection", "Lasso selection", buildRopeIcon());
    // Keep Brush and Freehand icons unchanged
    const btnBox = mkBtn(SelectionTools.BOX, "Brush (box) selection", "Brush (box) selection", "▭");
    const btnFree = mkBtn(SelectionTools.FREEHAND, "Freehand brush selection", "Freehand brush selection", "✎");

    // Add buttons in order: Cancel, Confirm, then selection tools
    bar.appendChild(btnCancel);
    bar.appendChild(btnConfirm);
    bar.appendChild(btnLasso);
    bar.appendChild(btnBox);
    bar.appendChild(btnFree);

    // Keep for updates
    this._selectionToolbar = bar;

    // Apply initial visibility (hidden by default)
    this._applySelectionToolbarVisibility?.();

    // Append inside container
    this.container.appendChild(bar);
  }

  _updateSelectionToolbarState(activeTool) {
    if (!this._selectionToolbar) return;
    
    // Update tool buttons (lasso, box, freehand)
    const buttons = Array.from(this._selectionToolbar.querySelectorAll("[data-tool-button]"));
    buttons.forEach((btn) => {
      const pressed = btn.dataset.tool === activeTool;
      btn.setAttribute("aria-pressed", pressed ? "true" : "false");
      // style switch (exact match to standard header button visuals)
      btn.style.background = pressed ? "#eef2ff" : "#ffffff";          // matches active state
      btn.style.borderColor = pressed ? "#60a5fa" : "#d1d5db";         // border-blue-400 when active
      btn.style.color = pressed ? "#3b82f6" : "#4b5563";               // text-blue-500 when active
      btn.style.boxShadow = pressed ? "0 0 0 2px rgba(59,130,246,0.5)" : "0 1px 2px rgba(15,23,42,0.08)";
    });

    // Show/hide action buttons (cancel, confirm) based on selection state
    const hasSelection = this._selectionMgr?.hasSelection?.() || false;
    const actionButtons = Array.from(this._selectionToolbar.querySelectorAll("[data-action-button]"));
    actionButtons.forEach((btn) => {
      btn.style.display = hasSelection ? "inline-flex" : "none";
    });
  }

  _handleTimeCursorUpdate(state) {
    if (!state || typeof state !== "object") {
      this._timeCursorState = null;
    } else {
      this._timeCursorState = state;
    }
    if (this.data) {
      this.requestRender(false);
    }
  }

  _attachTimeCursorSubscription() {
    if (this._timeCursorUnsubscribe || typeof subscribeToTimeCursor !== "function") {
      if (!this._timeCursorState && typeof getTimeCursorState === "function") {
        try {
          this._handleTimeCursorUpdate(getTimeCursorState());
        } catch (error) {
          console.error("[ScatterChart] Failed to read time cursor state", error);
        }
      }
      return;
    }

    try {
      this._timeCursorListener = (state) => this._handleTimeCursorUpdate(state);
      this._timeCursorUnsubscribe = subscribeToTimeCursor(this._timeCursorListener);
    } catch (error) {
      console.error("[ScatterChart] Failed to subscribe to time cursor updates", error);
      this._timeCursorUnsubscribe = null;
      this._timeCursorListener = null;
    }

    if (!this._timeCursorState && typeof getTimeCursorState === "function") {
      try {
        this._handleTimeCursorUpdate(getTimeCursorState());
      } catch (error) {
        console.error("[ScatterChart] Failed to read time cursor state", error);
      }
    }
  }

  _detachTimeCursorSubscription() {
    if (typeof this._timeCursorUnsubscribe === "function") {
      try {
        this._timeCursorUnsubscribe();
      } catch (error) {
        console.error("[ScatterChart] Failed to detach time cursor subscription", error);
      }
    }
    this._timeCursorUnsubscribe = null;
    this._timeCursorListener = null;
    this._timeCursorState = null;
  }

  // ----- sheet-wide TimeRangeFilter integration -----
  _handleTimeRangeFilterUpdate(domain) {
    let next = null;
    if (domain && Number.isInteger(domain.domainStartIndex) && Number.isInteger(domain.domainEndIndex)) {
      const start = Math.min(domain.domainStartIndex, domain.domainEndIndex);
      const end = Math.max(domain.domainStartIndex, domain.domainEndIndex);
      next = { startIndex: start, endIndex: end };
    }
    const changed = !(
      (!this._activeTimeRange && !next) ||
      (this._activeTimeRange &&
        next &&
        this._activeTimeRange.startIndex === next.startIndex &&
        this._activeTimeRange.endIndex === next.endIndex)
    );
  
    this._activeTimeRange = next;
    if (changed && this.data) {
      this._emitUiState();
      this.requestRender(false);
    } else {
      // Still emit so UI can hide the button when the range is cleared
      this._emitUiState();
    }
  }

  _attachTimeRangeFilterSubscription() {
    this._detachTimeRangeFilterSubscription();
    if (!this.sheetId || typeof subscribeToTimeRangeFilter !== "function") {
      this._activeTimeRange = null;
      return;
    }
    try {
      this._timeRangeUnsubscribe = subscribeToTimeRangeFilter(this.sheetId, (domain) =>
        this._handleTimeRangeFilterUpdate(domain)
      );
    } catch (error) {
      console.error("[ScatterChart] Failed to subscribe to time range filter updates", error);
      this._timeRangeUnsubscribe = null;
    }

    if (!this._activeTimeRange && typeof getActiveTimeRangeDomain === "function") {
      try {
        const domain = getActiveTimeRangeDomain(this.sheetId);
        this._handleTimeRangeFilterUpdate(domain);
      } catch (error) {
        console.error("[ScatterChart] Failed to read time range filter state", error);
      }
    }
  }

  _detachTimeRangeFilterSubscription() {
    if (typeof this._timeRangeUnsubscribe === "function") {
      try {
        this._timeRangeUnsubscribe();
      } catch (error) {
        console.error("[ScatterChart] Failed to detach time range filter subscription", error);
      }
    }
    this._timeRangeUnsubscribe = null;
    this._activeTimeRange = null;
  }

  // ----- Point Selection integration -----
  _handlePointSelectionUpdate(selection) {
    this._activePointSelection = selection ? new Set(selection) : null;
    this._emitUiState();  // Update UI state (e.g., eye button visibility) when selection changes
    this.requestRender(true);
  }

  _attachPointSelectionSubscription() {
    this._detachPointSelectionSubscription();
    if (!this.sheetId || typeof subscribeToPointSelection !== "function") {
      this._activePointSelection = null;
      return;
    }
    try {
      this._pointSelectionUnsubscribe = subscribeToPointSelection(this.sheetId, (selection) =>
        this._handlePointSelectionUpdate(selection)
      );
    } catch (error) {
      console.error("[ScatterChart] Failed to subscribe to point selection updates", error);
      this._pointSelectionUnsubscribe = null;
    }

    // Get initial state
    if (!this._activePointSelection && typeof getPointSelection === "function") {
      try {
        const selection = getPointSelection(this.sheetId);
        this._handlePointSelectionUpdate(selection);
      } catch (error) {
        console.error("[ScatterChart] Failed to read point selection state", error);
      }
    }
  }

  _detachPointSelectionSubscription() {
    if (typeof this._pointSelectionUnsubscribe === "function") {
      try {
        this._pointSelectionUnsubscribe();
      } catch (error) {
        console.error("[ScatterChart] Failed to detach point selection subscription", error);
      }
    }
    this._pointSelectionUnsubscribe = null;
    this._activePointSelection = null;
  }

  _updatePcaOverlay() {
    // Destroy existing overlay if present
    if (this._pcaOverlay) {
      this._pcaOverlay.destroy();
      this._pcaOverlay = null;
    }

    // Only create overlay if we have PCA metadata
    if (!this._pcaMetadata || !this._pcaMetadata.explained_variance) {
      return;
    }

    // Create the overlay
    this._pcaOverlay = createPcaOverlay({
      container: this.container,
      pcaMetadata: this._pcaMetadata,
      dimension: this.dimension,
      onComponentChange: (selection) => {
        // Store the selection
        this._pcaComponentSelection = selection;
        
        // Emit UI state update
        this._emitUiState();
        
        // Remap the axes based on the new component selection
        this._remapPcaAxes(selection);
      },
    });

    // Restore previous selection if available
    if (this._pcaComponentSelection && this._pcaOverlay) {
      this._pcaOverlay.setSelection(this._pcaComponentSelection);
    }

    if (this._pcaOverlay) {
      if (this._pcaOverlayVisible) {
        this._pcaOverlay.show();
      } else {
        this._pcaOverlay.hide();
      }
    }
  }

  _remapPcaAxes(selection) {
    if (!this.data || !this.data.pointsF32) {
      return;
    }

    const dimension = this.dimension === 3 ? 3 : 2;

    // Use the full projection if available, otherwise fall back to display points
    const fullProjection = this._pcaFullProjection || this.data.pointsF32;
    const fullDim = this._pcaFullProjectionDim || dimension;
    
    // Store original full projection if not already stored
    if (!this._pcaOriginalCoords) {
      this._pcaOriginalCoords = new Float32Array(fullProjection);
      this._pcaOriginalDimension = fullDim;
    }

    const pointCount = this._pcaOriginalCoords.length / this._pcaOriginalDimension;
    
    // Create mapping: which original component goes to which display axis (2D: X,Y; 3D: X,Y,Z)
    const mapping = dimension === 3 
      ? [selection.x, selection.y, selection.z]
      : [selection.x, selection.y];
    
    // Validate that selected components are within available dimensions
    if (mapping.some(idx => idx >= this._pcaOriginalDimension)) {
      console.warn('[ScatterChart] Selected component is beyond available projection dimensions.');
      return;
    }

    // Remap the coordinates from full projection to display dimensions
    const remapped = new Float32Array(pointCount * dimension);
    for (let i = 0; i < pointCount; i++) {
      for (let d = 0; d < dimension; d++) {
        const sourceIdx = i * this._pcaOriginalDimension + mapping[d];
        const targetIdx = i * dimension + d;
        remapped[targetIdx] = this._pcaOriginalCoords[sourceIdx];
      }
    }

    // Update the data
    this.data.pointsF32 = remapped;

    // Recalculate extents for the remapped axes
    const extents = [];
    for (let d = 0; d < dimension; d++) {
      const values = [];
      for (let i = 0; i < pointCount; i++) {
        values.push(remapped[i * dimension + d]);
      }
      extents.push(expandExtent(d3.extent(values)));
    }
    this.data.extents = extents;
    this.data.origin = dimension === 3 
      ? computeCentroid(remapped, 3) 
      : computeCentroid(remapped, 2);

    // Update column labels to reflect the remapped components
    if (this.data.columns && this.data.columns.length >= dimension) {
      const newColumns = mapping.map((componentIdx, axisIdx) => ({
        ...this.data.columns[axisIdx],
        label: `PC ${componentIdx + 1}`
      }));
      this.data.columns = newColumns;
    }

    // Invalidate sampling cache
    this._samplingCache.pointCount = null;

    // Request re-render
    this.requestRender(true);
  }

  _updateUmapOverlay() {
    // Destroy existing overlay if present
    if (this._umapOverlay) {
      this._umapOverlay.destroy();
      this._umapOverlay = null;
    }

    // Create the UMAP overlay (always available when UMAP is selected)
    this._umapOverlay = createUmapOverlay({
      container: this.container,
      neighbours: this._umapParameters.neighbours,
      onRun: (parameters) => {
        // Store the parameters
        this._umapParameters = parameters;
        
        // Emit UI state update
        this._emitUiState();
        
        // Trigger UMAP recomputation
        if (typeof this._onUmapRecompute === 'function') {
          this._onUmapRecompute(parameters);
        }
      },
    });

    // Restore previous parameters if available
    if (this._umapParameters && this._umapOverlay) {
      this._umapOverlay.setParameters(this._umapParameters);
    }

    if (this._umapOverlay) {
      if (this._umapOverlayVisible) {
        this._umapOverlay.show();
      } else {
        this._umapOverlay.hide();
      }
    }
  }
  
  setUmapRecomputeCallback(callback) {
    this._onUmapRecompute = callback;
  }

  _updateTsneOverlay() {
    // Destroy existing overlay if present
    if (this._tsneOverlay) {
      this._tsneOverlay.destroy();
      this._tsneOverlay = null;
    }

    // Only create overlay if we have a T-SNE controller
    if (!this._tsneController) {
      return;
    }

    // Create the T-SNE overlay
    this._tsneOverlay = createTsneOverlay({
      container: this.container,
      controller: this._tsneController,
      initialParams: this._tsneParams,
      onStop: () => {
        if (this._tsneController) {
          this._tsneController.sendAction('stop');
        }
      },
      onRun: async (params) => {
        // Store the user-defined parameters
        this._tsneParams = { ...params };
        
        // Call the external handler to start a fresh t-SNE session
        if (typeof this._tsneRestartHandler === 'function') {
          try {
            await this._tsneRestartHandler(params);
          } catch (error) {
            console.error('[ScatterChart] Failed to start new t-SNE session', error);
          }
        }
      },
    });

    if (this._tsneOverlay) {
      if (this._tsneOverlayVisible) {
        this._tsneOverlay.show();
      } else {
        this._tsneOverlay.hide();
      }
    }
  }

  setTsneController(controller) {
    this._tsneController = controller;
    // Update overlay if t-SNE is the current reduction method
    if (this._reductionMethod === 'tsne') {
      this._updateTsneOverlay();
    }
  }

  setTsneRestartHandler(handler) {
    this._tsneRestartHandler = handler;
    // Update overlay if t-SNE is active
    if (this._reductionMethod === 'tsne' && this._tsneController) {
      this._updateTsneOverlay();
    }
  }

  resetTsneParameters() {
    // Reset to default parameters for fresh t-SNE initialization
    this._tsneParams = null;
  }

  updateTsneState(state) {
    if (this._tsneOverlay && typeof this._tsneOverlay.updateState === 'function') {
      this._tsneOverlay.updateState(state);
    }
  }

  _buildHighlightOptions() {
    if (!this.data) return null;

    const pointsF32 = this.data.pointsF32;
    if (!pointsF32 || pointsF32.length === 0) return null;

    const dimension = this.dimension === 3 ? 3 : 2;
    const pointCount = pointsF32.length / dimension;
    if (!Number.isFinite(pointCount) || pointCount <= 0) return null;

    const rowIndices = this.data.rowIndices;
    if (!rowIndices || rowIndices.length !== pointCount) return null;

    const state = this._timeCursorState;
    const timesteps = Number.isInteger(state?.timesteps) ? state.timesteps : null;
    if (!timesteps || timesteps <= 0) return null;

    let index = Number.isInteger(state?.index) ? state.index : 0;
    if (index < 0) index = 0;
    if (index >= timesteps) index = timesteps - 1;

    let pointIndex = null;
    if (this.data.rowIndexLookup && typeof this.data.rowIndexLookup.get === "function") {
      const mapped = this.data.rowIndexLookup.get(index);
      if (Number.isInteger(mapped)) pointIndex = mapped;
    }
    if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= pointCount) {
      pointIndex = null;
    }

    const defaults = this._highlightConfig || {};
    const fadeFactor = Number.isFinite(defaults.fadeWindowFactor) ? defaults.fadeWindowFactor : 0.08;
    const minFade = Number.isFinite(defaults.minFadeWindow) ? defaults.minFadeWindow : 6;
    const maxFade = Number.isFinite(defaults.maxFadeWindow) ? defaults.maxFadeWindow : 48;

    let fadeWindow = Math.round(timesteps * fadeFactor);
    if (!Number.isFinite(fadeWindow) || fadeWindow <= 0) {
      fadeWindow = HIGHLIGHT_STYLE.fadeWindowDefault;
    }
    if (fadeWindow < minFade) fadeWindow = minFade;
    if (fadeWindow > maxFade) fadeWindow = maxFade;
    if (!Number.isFinite(fadeWindow) || fadeWindow <= 0) {
      fadeWindow = Math.max(1, HIGHLIGHT_STYLE.fadeWindowDefault);
    }

    // Disable traces/afterglow for multi-subject scatterplots
    if (this.data.multiSubject) {
      fadeWindow = 0;
    }

    // Get the color palette for subjects (for consistency with legend colors)
    const colorPalette = Array.isArray(d3.schemeTableau10)
      ? d3.schemeTableau10
      : ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];

    return {
      currentIndex: index,
      pointIndex,
      rowIndices,
      indexLookup: this.data.rowIndexLookup,
      fadeWindow,
      styleOverride: defaults.styleOverride || null,
      // Sheet-wide active time range (row-index space). Used by 2D/3D renderers to:
      // - grey out out-of-range points/segments
      // - suppress pre-/afterglow outside the active range
      activeRange: this._activeTimeRange
        ? { startIndex: this._activeTimeRange.startIndex, endIndex: this._activeTimeRange.endIndex }
        : null,
      // Committed point selection (point-index space). Used by 3D renderer to:
      // - color selected points normally
      // - grey out non-selected points
      pointSelection: this._activePointSelection ? new Set(this._activePointSelection) : null,
      // Unified visibility mode for filtered data (applies to both time range and point selection): 'grey' | 'hide'
      filteredVisibility: this.getFilteredVisibilityMode(),
      // Multi-subject information for per-subject highlights
      multiSubject: this.data.multiSubject || false,
      subjectMapping: this.data.subjectMapping || null,
      totalTimesteps: timesteps,
      colorPalette: colorPalette
    };
  }

  // ---- keyboard presets ----
  _bindKeyboard() {
    if (this._keyHandler) return;
    this._keyHandler = (e) => {
      if (this.dimension !== 3) return;
      const key = e.key?.toLowerCase();
      let changed = false;

      if (key === "r") {
        this.rotation = { ...DEFAULT_ROTATION };
        this._pendingAutoFit3D = true;
        changed = true;
      } else if (key === "1") {
        this.rotation.yaw = 0; this.rotation.pitch = 0;
        this._pendingAutoFit3D = true;
        changed = true;
      } else if (key === "2") {
        this.rotation.yaw = Math.PI / 2; this.rotation.pitch = 0;
        this._pendingAutoFit3D = true;
        changed = true;
      } else if (key === "3") {
        this.rotation.yaw = 0; this.rotation.pitch = Math.PI / 2 - 0.001;
        this._pendingAutoFit3D = true;
        changed = true;
      }

      if (changed) {
        this._stopSpin();
        this._stopAutoSpin(); // sofort HQ-Render (Pose bleibt erhalten)
        this._onInteract();
      }
    };
    this.container.addEventListener("keydown", this._keyHandler);
  }

  _unbindKeyboard() {
    if (!this._keyHandler) return;
    this.container.removeEventListener("keydown", this._keyHandler);
    this._keyHandler = null;
  }
  // ---- Selection toolbox visibility API (in-chart toolbar) ----
  _applySelectionToolbarVisibility() {
    try {
      if (!this._selectionToolbar) return;
      this._selectionToolbar.style.display = this._selectionToolbarVisible ? 'inline-flex' : 'none';
    } catch (_) {}
  }

  setSelectionToolbarVisible(visible) {
    const next = !!visible;
    if (this._selectionToolbarVisible === next) return this._selectionToolbarVisible;
    this._selectionToolbarVisible = next;
    
    // When hiding the toolbar, deactivate any active selection tool and clear the gray overlay
    if (!next && this._selectionMgr) {
      this._selectionMgr.deactivate();
    }
    
    this._applySelectionToolbarVisibility();
    return this._selectionToolbarVisible;
  }

  getSelectionToolbarVisible() {
    return !!this._selectionToolbarVisible;
  }

  toggleSelectionToolbarVisibility() {
    return this.setSelectionToolbarVisible(!this._selectionToolbarVisible);
  }
}
 
export default ScatterChart;
