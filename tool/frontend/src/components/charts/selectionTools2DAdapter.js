import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

// 2D adapter for selection tools - projects points to screen space

export function create2DSelectionAdapter(chart) {
  function getPlotRect() {
    const width = chart.currentSize?.width ?? 0;
    const height = chart.currentSize?.height ?? 0;
    const margins = chart._margins2D || { left: 0, top: 0, right: 0, bottom: 0 };
    const innerWidth = Math.max(8, width - margins.left - margins.right);
    const innerHeight = Math.max(8, height - margins.top - margins.bottom);
    return { innerWidth, innerHeight, margins };
  }

  function getProjectedPoints() {
    const { innerWidth, innerHeight } = getPlotRect();
    const pointsF32 = chart?.data?.pointsF32;
    if (!(pointsF32 instanceof Float32Array) || pointsF32.length === 0) return [];

    const [xExtent, yExtent] = chart.data.extents || [[0, 1], [0, 1]];
    const xScale = d3.scaleLinear().domain(xExtent).range([0, innerWidth]);
    const yScale = d3.scaleLinear().domain(yExtent).range([innerHeight, 0]);

    const t = chart.transform || d3.zoomIdentity;
    const zx = t.rescaleX(xScale);
    const zy = t.rescaleY(yScale);

    const n = pointsF32.length / 2;
    const out = new Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const x = zx(pointsF32[i * 2]);
      const y = zy(pointsF32[i * 2 + 1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        out[j++] = { x, y, index: i };
      }
    }
    if (j !== n) out.length = j;
    return out;
  }

  function onActivate() {
    // Disable 2D zoom interactions during selection to keep mutual exclusivity
    try {
      if (typeof chart._disable2DZoom === "function") chart._disable2DZoom();
    } catch (_) {}
    // Force a render if needed for cursor/overlay state sync
    chart.requestRender?.(false);
  }

  function onDeactivate() {
    // Restore zoom interactions
    try {
      if (typeof chart._enable2DZoom === "function") chart._enable2DZoom();
    } catch (_) {}
    chart.requestRender?.(false);
  }

  function cursorForTool(tool) {
    // crosshair for all tools in 2D
    return "crosshair";
  }

  return { 
    getProjectedPoints, 
    getPlotRect, 
    onActivate, 
    onDeactivate, 
    cursorForTool,
    is3D: false  // Flag to indicate 2D mode
  };
}

export default { create2DSelectionAdapter };