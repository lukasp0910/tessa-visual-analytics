// Visual selection tools (lasso, box, freehand) for scatter charts
// No persistence - just draws overlay and highlights points

export const SelectionTools = Object.freeze({
  NONE: null,
  LASSO: 'lasso',
  BOX: 'box',
  FREEHAND: 'freehand',
});

const NS = 'http://www.w3.org/2000/svg';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function pointInPolygon(poly, px, py) {
  if (!Array.isArray(poly) || poly.length < 3) return false;

  // Boundary-inclusive: treat points on the polygon edge as selected.
  // Device-PPI aware epsilon in screen-space pixels.
  const eps = Math.max(
    0.5,
    (typeof window !== "undefined" && window.devicePixelRatio)
      ? 0.35 * window.devicePixelRatio
      : 0.5
  );

  // Fast boundary check using distance to each edge.
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (distancePointToSegment(px, py, xi, yi, xj, yj) <= eps) {
      return true; // boundary-inclusive
    }
  }

  // Standard ray casting for interior test
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect =
      (yi > py) !== (yj > py) &&
      px <= ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}
function distancePointToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(px - ax, py - ay);
  const c2 = vx * vx + vy * vy;
  if (c2 <= 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(c1 / c2, 0, 1);
  const projx = ax + t * vx;
  const projy = ay + t * vy;
  return Math.hypot(px - projx, py - projy);
}
function distancePointToPolyline(px, py, polyline) {
  if (!Array.isArray(polyline) || polyline.length === 0) return Infinity;
  let best = Infinity;
  for (let i = 1; i < polyline.length; i++) {
    const [ax, ay] = polyline[i - 1];
    const [bx, by] = polyline[i];
    const d = distancePointToSegment(px, py, ax, ay, bx, by);
    if (d < best) best = d;
  }
  return best;
}

function createSvgElement(name, attrs = {}) {
  const el = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function defaultCursor(tool) {
  switch (tool) {
    case SelectionTools.LASSO:
      return 'crosshair'; // crosshair fallback
    case SelectionTools.BOX:
      return 'crosshair';
    case SelectionTools.FREEHAND:
      return 'crosshair'; // pen/brush cursor could be provided by the host if available
    default:
      return '';
  }
}

function computeDefaultBrushRadiusPx(innerW, innerH) {
  const base = Math.min(innerW, innerH) * 0.01;
  return clamp(base, 4, 16);
}

export function createSelectionManager({
  container,
  svg,
  getProjectedPoints,
  getPlotRect,
  onActivate = () => {},
  onDeactivate = () => {},
  onSelectionChange = () => {},
  cursorForTool = defaultCursor,
  is3D = false,  // Flag to distinguish 3D vs 2D rendering
} = {}) {
  if (!container || !svg || typeof getProjectedPoints !== 'function' || typeof getPlotRect !== 'function') {
    throw new Error('selectionTools: Missing required parameters');
  }

  let activeTool = SelectionTools.NONE;
  let isDrawing = false;
  let rafPending = false;

  let pointsCache = null; // [{x,y,index}]
  let selectedSet = new Set(); // indices - cumulative across all gestures
  let currentGestureSet = new Set(); // indices selected in current gesture only
  let startPt = null; // for box
  let boxRect = null; // {x,y,w,h}
  let lassoPath = []; // [[x,y], ...]
  let freehandPath = []; // [[x,y], ...]
  let brushRadius = 8;

  // Build overlay rooted in chart plot-space (margins transform)
  const overlayRoot = createSvgElement('g', { class: 'scatter-selection__root' });
  const overlayGrey = createSvgElement('rect', {
    class: 'scatter-selection__overlay',
    fill: 'rgba(107,114,128,0.15)', // gray-500 with alpha
    'pointer-events': 'none',
    x: 0, y: 0, width: 1, height: 1,
    visibility: 'hidden',
  });
  const clipId = `clip-${Math.random().toString(36).slice(2)}`;
  const defs = (svg.querySelector('defs') ?? svg.insertBefore(createSvgElement('defs'), svg.firstChild));
  const clipPath = createSvgElement('clipPath', { id: clipId });
  const clipRect = createSvgElement('rect', { x: 0, y: 0, width: 1, height: 1 });
  clipPath.appendChild(clipRect);
  defs.appendChild(clipPath);

  const geometryLayer = createSvgElement('g', {
    class: 'scatter-selection__geometry',
    'clip-path': `url(#${clipId})`,
  });
  const highlightsLayer = createSvgElement('g', {
    class: 'scatter-selection__highlights',
    'clip-path': `url(#${clipId})`,
  });

  // Geometry visuals
  const boxNode = createSvgElement('rect', {
    class: 'scatter-selection__box',
    fill: 'rgba(59,130,246,0.10)', // blue-500 with alpha
    stroke: 'rgba(59,130,246,0.9)',
    'stroke-width': 1.5,
    'stroke-dasharray': '5 4',
    visibility: 'hidden',
    rx: 1.5, ry: 1.5,
  });
  const lassoFill = createSvgElement('path', {
    class: 'scatter-selection__lasso-fill',
    fill: 'rgba(107,114,128,0.15)', // gray
    stroke: 'rgba(55,65,81,0.9)', // gray-700
    'stroke-width': 1,
    visibility: 'hidden',
  });
  const freehandStroke = createSvgElement('path', {
    class: 'scatter-selection__freehand',
    fill: 'none',
    stroke: 'rgba(79,70,229,0.9)', // indigo-600
    'stroke-width': 1.5,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    visibility: 'hidden',
  });
  const nib = createSvgElement('circle', {
    class: 'scatter-selection__nib',
    r: 6,
    fill: 'rgba(79,70,229,0.2)',
    stroke: 'rgba(79,70,229,0.8)',
    'stroke-width': 1,
    visibility: 'hidden',
  });

  geometryLayer.appendChild(boxNode);
  geometryLayer.appendChild(lassoFill);
  geometryLayer.appendChild(freehandStroke);
  geometryLayer.appendChild(nib);

  // Attach overlay (after axes so it sits on top)
  svg.appendChild(overlayRoot);
  overlayRoot.appendChild(overlayGrey);
  overlayRoot.appendChild(geometryLayer);
  overlayRoot.appendChild(highlightsLayer);

  function layout() {
    const { innerWidth, innerHeight, margins } = getPlotRect();
    
    if (is3D) {
      // In 3D mode, cover the entire canvas area (no margin offset)
      // because 3D points are rendered on the full canvas
      const fullWidth = innerWidth + margins.left + margins.right;
      const fullHeight = innerHeight + margins.top + margins.bottom;
      overlayRoot.setAttribute('transform', `translate(0,0)`);
      overlayGrey.setAttribute('x', 0);
      overlayGrey.setAttribute('y', 0);
      overlayGrey.setAttribute('width', fullWidth);
      overlayGrey.setAttribute('height', fullHeight);
      clipRect.setAttribute('x', 0);
      clipRect.setAttribute('y', 0);
      clipRect.setAttribute('width', fullWidth);
      clipRect.setAttribute('height', fullHeight);
    } else {
      // In 2D mode, position overlay into plot area with margins
      overlayRoot.setAttribute('transform', `translate(${margins.left},${margins.top})`);
      overlayGrey.setAttribute('x', 0);
      overlayGrey.setAttribute('y', 0);
      overlayGrey.setAttribute('width', innerWidth);
      overlayGrey.setAttribute('height', innerHeight);
      clipRect.setAttribute('x', 0);
      clipRect.setAttribute('y', 0);
      clipRect.setAttribute('width', innerWidth);
      clipRect.setAttribute('height', innerHeight);
    }
  }

  function clearHighlights() {
    while (highlightsLayer.firstChild) highlightsLayer.removeChild(highlightsLayer.firstChild);
  }

  function renderHighlights(indices) {
    clearHighlights();
    if (!indices || !indices.size) return;
    const frag = document.createDocumentFragment();
    // visual accent for selected points
    const OUTLINE = 'rgba(17,24,39,0.9)'; // slate-900
    const FILL = 'rgba(59,130,246,0.92)'; // blue-500
    const SIZE = 4.5;

    // Build a quick lookup by index -> position
    const map = new Map();
    if (!pointsCache) return;
    for (const p of pointsCache) map.set(p.index, p);

    for (const idx of indices) {
      const p = map.get(idx);
      if (!p) continue;
      const c = createSvgElement('circle', {
        cx: p.x,
        cy: p.y,
        r: SIZE + 1.5,
        fill: OUTLINE,
        'fill-opacity': 0.25,
      });
      const d = createSvgElement('circle', {
        cx: p.x,
        cy: p.y,
        r: SIZE,
        fill: FILL,
        stroke: 'white',
        'stroke-width': 1,
      });
      frag.appendChild(c);
      frag.appendChild(d);
    }
    highlightsLayer.appendChild(frag);
  }

  function showOverlay(show) {
    overlayGrey.setAttribute('visibility', show ? 'visible' : 'hidden');
  }

  function showNode(node, show) {
    node.setAttribute('visibility', show ? 'visible' : 'hidden');
  }

  function startGesture(px, py) {
    isDrawing = true;
    // Clear only the current gesture selection, preserve cumulative selection
    currentGestureSet.clear();
    pointsCache = getProjectedPoints() || [];
    const { innerWidth, innerHeight } = getPlotRect();
    brushRadius = computeDefaultBrushRadiusPx(innerWidth, innerHeight);

    // init per-tool geometry
    if (activeTool === SelectionTools.BOX) {
      startPt = { x: px, y: py };
      boxRect = { x: px, y: py, w: 0, h: 0 };
      showNode(boxNode, true);
      boxNode.setAttribute('x', px);
      boxNode.setAttribute('y', py);
      boxNode.setAttribute('width', 0);
      boxNode.setAttribute('height', 0);
      showNode(lassoFill, false);
      showNode(freehandStroke, false);
      showNode(nib, false);
    } else if (activeTool === SelectionTools.LASSO) {
      lassoPath = [[px, py]];
      showNode(lassoFill, true);
      showNode(boxNode, false);
      showNode(freehandStroke, false);
      showNode(nib, false);
      lassoFill.setAttribute('d', `M ${px},${py}`);
    } else if (activeTool === SelectionTools.FREEHAND) {
      freehandPath = [[px, py]];
      showNode(freehandStroke, true);
      showNode(nib, true);
      showNode(boxNode, false);
      showNode(lassoFill, false);
      nib.setAttribute('cx', px);
      nib.setAttribute('cy', py);
      nib.setAttribute('r', brushRadius);
      freehandStroke.setAttribute('d', `M ${px},${py}`);
    }
    // Don't clear highlights - we want to keep showing all selected points
  }

  function updateGesture(px, py) {
    if (!isDrawing) return;
    if (activeTool === SelectionTools.BOX) {
      const x0 = Math.min(startPt.x, px);
      const y0 = Math.min(startPt.y, py);
      const w = Math.abs(px - startPt.x);
      const h = Math.abs(py - startPt.y);
      boxRect = { x: x0, y: y0, w, h };
      boxNode.setAttribute('x', x0);
      boxNode.setAttribute('y', y0);
      boxNode.setAttribute('width', w);
      boxNode.setAttribute('height', h);
    } else if (activeTool === SelectionTools.LASSO) {
      const last = lassoPath[lassoPath.length - 1];
      // reduce duplicate points
      if (!last || dist2(last[0], last[1], px, py) > 1) {
        lassoPath.push([px, py]);
        const d = `M ${lassoPath[0][0]},${lassoPath[0][1]} ` + lassoPath.slice(1).map(p => `L ${p[0]},${p[1]}`).join(' ');
        lassoFill.setAttribute('d', d);
      }
    } else if (activeTool === SelectionTools.FREEHAND) {
      const last = freehandPath[freehandPath.length - 1];
      if (!last || dist2(last[0], last[1], px, py) > 1) {
        freehandPath.push([px, py]);
        const d = `M ${freehandPath[0][0]},${freehandPath[0][1]} ` + freehandPath.slice(1).map(p => `L ${p[0]},${p[1]}`).join(' ');
        freehandStroke.setAttribute('d', d);
        nib.setAttribute('cx', px);
        nib.setAttribute('cy', py);
      }
    }
    scheduleHitTest();
  }

  function endGesture(px, py) {
    if (!isDrawing) return;
    isDrawing = false;
    // Close lasso shape on mouseup
    if (activeTool === SelectionTools.LASSO) {
      if (lassoPath.length > 2) {
        const d = `M ${lassoPath[0][0]},${lassoPath[0][1]} ` + lassoPath.slice(1).map(p => `L ${p[0]},${p[1]}`).join(' ') + ' Z';
        lassoFill.setAttribute('d', d);
      }
    }
    scheduleHitTest(true);
    // Keep geometry visible until deactivation or ESC-clear
  }

  function cancelGesture(keepTool = true, clearSelected = true) {
    isDrawing = false;
    startPt = null;
    boxRect = null;
    lassoPath = [];
    freehandPath = [];
    pointsCache = null;
    currentGestureSet.clear();
    
    // Only clear selection if explicitly requested (e.g., by cancel button)
    if (clearSelected) {
      selectedSet.clear();
      clearHighlights();
    } else {
      // If preserving selection, re-render highlights to show cumulative selection
      renderHighlights(selectedSet);
    }
    
    // Hide gesture geometry, keep overlay if tool remains active
    showNode(boxNode, false);
    showNode(lassoFill, false);
    showNode(freehandStroke, false);
    showNode(nib, false);
    if (!keepTool) showOverlay(false);
    
    // Notify listeners about selection state (may be cleared or preserved)
    if (typeof onSelectionChange === 'function') {
      onSelectionChange(selectedSet);
    }
  }

  function scheduleHitTest(finalize = false) {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      hitTest();
      renderHighlights(selectedSet);
      // Notify listeners that selection changed
      if (typeof onSelectionChange === 'function') {
        onSelectionChange(selectedSet);
      }
      // In-progress visuals remain; finalized geometry just stays until cleared/deactivated
    });
  }

  function coarseInsidePlot(p) {
    const { innerWidth, innerHeight, margins } = getPlotRect();
    
    if (is3D) {
      // In 3D mode, check against full canvas dimensions
      const fullWidth = innerWidth + margins.left + margins.right;
      const fullHeight = innerHeight + margins.top + margins.bottom;
      return p.x >= -1 && p.x <= fullWidth + 1 && p.y >= -1 && p.y <= fullHeight + 1;
    } else {
      // In 2D mode, check against inner plot area
      return p.x >= -1 && p.x <= innerWidth + 1 && p.y >= -1 && p.y <= innerHeight + 1;
    }
  }

  function hitTest() {
    if (!pointsCache) return;
    // Clear only current gesture selection, not the cumulative selection
    currentGestureSet.clear();
    
    // Find points in current gesture region
    if (activeTool === SelectionTools.BOX && boxRect) {
      const x1 = boxRect.x, y1 = boxRect.y, x2 = x1 + boxRect.w, y2 = y1 + boxRect.h;
      for (let i = 0; i < pointsCache.length; i++) {
        const p = pointsCache[i];
        if (!coarseInsidePlot(p)) continue;
        if (p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) {
          currentGestureSet.add(p.index);
        }
      }
    } else if (activeTool === SelectionTools.LASSO && lassoPath && lassoPath.length >= 3) {
      for (let i = 0; i < pointsCache.length; i++) {
        const p = pointsCache[i];
        if (!coarseInsidePlot(p)) continue;
        if (pointInPolygon(lassoPath, p.x, p.y)) {
          currentGestureSet.add(p.index);
        }
      }
    } else if (activeTool === SelectionTools.FREEHAND && freehandPath && freehandPath.length >= 2) {
      const r = brushRadius;
      for (let i = 0; i < pointsCache.length; i++) {
        const p = pointsCache[i];
        if (!coarseInsidePlot(p)) continue;
        const d = distancePointToPolyline(p.x, p.y, freehandPath);
        if (d <= r) {
          currentGestureSet.add(p.index);
        }
      }
    }
    
    // Add current gesture selection to cumulative selection (additive)
    for (const idx of currentGestureSet) {
      selectedSet.add(idx);
    }
  }

  function toPlotCoordsFromClient(evt) {
    const { margins } = getPlotRect();
    const svgRect = svg.getBoundingClientRect();
    
    if (is3D) {
      // In 3D mode, coordinates are relative to full canvas (no margin offset)
      const x = evt.clientX - svgRect.left;
      const y = evt.clientY - svgRect.top;
      return { x, y };
    } else {
      // In 2D mode, coordinates are relative to plot area (with margin offset)
      const x = evt.clientX - svgRect.left - margins.left;
      const y = evt.clientY - svgRect.top - margins.top;
      return { x, y };
    }
  }

  // Pointer handlers
  let capturedPointerId = null;

  function onPointerDown(evt) {
    if (!activeTool) return;
    // Limit to primary button
    if (evt.button !== 0) return;
    evt.preventDefault();
    container.setPointerCapture?.(evt.pointerId);
    capturedPointerId = evt.pointerId;
    const { x, y } = toPlotCoordsFromClient(evt);
    startGesture(x, y);
  }
  function onPointerMove(evt) {
    if (!activeTool) return;
    if (capturedPointerId !== null && evt.pointerId !== capturedPointerId) return;
    const { x, y } = toPlotCoordsFromClient(evt);
    updateGesture(x, y);
  }
  function onPointerUp(evt) {
    if (!activeTool) return;
    if (capturedPointerId !== null && evt.pointerId !== capturedPointerId) return;
    const { x, y } = toPlotCoordsFromClient(evt);
    endGesture(x, y);
    if (container.hasPointerCapture?.(evt.pointerId)) {
      container.releasePointerCapture(evt.pointerId);
    }
    capturedPointerId = null;
  }
  function onPointerCancel(evt) {
    if (capturedPointerId !== null && container.hasPointerCapture?.(capturedPointerId)) {
      container.releasePointerCapture(capturedPointerId);
    }
    capturedPointerId = null;
    // Cancel gesture but preserve existing selection
    cancelGesture(true, false);
  }

  function onKeyDown(evt) {
    if (!activeTool) return;
    if (evt.key === 'Escape' || evt.key === 'Esc') {
      // Cancel in-progress geometry but preserve cumulative selection
      cancelGesture(true, false);
    }
  }

  function setCursorForTool(tool) {
    const cursor = (typeof cursorForTool === 'function') ? cursorForTool(tool) : defaultCursor(tool);
    container.style.cursor = cursor || '';
  }

  function enableOverlayInteractions(enable) {
    // Let the overlay intercept input when a tool is active to block underlying zoom/rotate
    geometryLayer.style.pointerEvents = enable ? 'auto' : 'none';
    highlightsLayer.style.pointerEvents = enable ? 'auto' : 'none';
    overlayGrey.style.pointerEvents = enable ? 'auto' : 'none';
  }

  function attachDom() {
    window.addEventListener('resize', onResize);
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerCancel);
    // Do not cancel on pointerleave: continue gesture until mouseup (clipped to chart)
    container.addEventListener('keydown', onKeyDown);
  }
  function detachDom() {
    window.removeEventListener('resize', onResize);
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerup', onPointerUp);
    container.removeEventListener('pointercancel', onPointerCancel);
    container.removeEventListener('keydown', onKeyDown);
  }

  function onResize() {
    // Cancel current gesture to avoid inconsistent hit-testing, but preserve selection
    if (isDrawing) cancelGesture(true, false);
    layout();
  }

  function activate(tool) {
    const next = tool === SelectionTools.LASSO || tool === SelectionTools.BOX || tool === SelectionTools.FREEHAND
      ? tool
      : SelectionTools.NONE;

    if (activeTool === next) {
      // Toggle off when clicking active tool again
      deactivate();
      return SelectionTools.NONE;
    }

    // Transition
    const prev = activeTool;
    activeTool = next;

    if (activeTool) {
      layout();
      showOverlay(true);
      setCursorForTool(activeTool);
      enableOverlayInteractions(true);
      // Re-render highlights when switching tools to show existing selection
      renderHighlights(selectedSet);
      onActivate?.(activeTool);
    } else {
      showOverlay(false);
      container.style.cursor = '';
      enableOverlayInteractions(false);
      onDeactivate?.(prev);
    }
    return activeTool;
  }

  function deactivate() {
    const prev = activeTool;
    // When deactivating, preserve selection but hide geometry
    cancelGesture(false, false);
    activeTool = SelectionTools.NONE;
    container.style.cursor = '';
    enableOverlayInteractions(false);
    // Clear highlights when deactivating
    clearHighlights();
    onDeactivate?.(prev);
    return SelectionTools.NONE;
  }

  function clearSelection() {
    // Clear everything (cancel button)
    cancelGesture(true, true);
  }

  function confirmSelection() {
    // Return selected indices (confirm button)
    const selection = new Set(selectedSet);
    
    // After confirming, we hide the overlay and clear the temporary selection state
    // The caller will store this in persistent state
    return selection;
  }

  // Initial layout
  layout();
  attachDom();

  return Object.freeze({
    getActiveTool: () => activeTool,
    isDrawing: () => !!isDrawing,
    getSelectedCount: () => selectedSet.size,
    hasSelection: () => selectedSet.size > 0,
    getSelectedIndices: () => new Set(selectedSet),
    activate,
    deactivate,
    clearSelection,
    confirmSelection,
    destroy() {
      deactivate();
      try {
        // remove overlay nodes
        overlayRoot.remove();
        const maybeClip = document.getElementById(clipId);
        if (maybeClip && maybeClip.parentNode === defs) defs.removeChild(maybeClip);
      } catch (_) {}
      detachDom();
    }
  });
}