import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { STYLE_3D } from "./ScatterChart3D.js";

// 3D adapter for selection tools - projects 3D points to screen space

export function create3DSelectionAdapter(chart) {
  let prevAuto = null;
  let rotationDisabled = false;

  function getPlotRect() {
    const width = chart.currentSize?.width ?? 0;
    const height = chart.currentSize?.height ?? 0;
    const margins = typeof chart.getCurrentMargins === "function"
      ? chart.getCurrentMargins()
      : { left: 14, top: 14, right: 14, bottom: 10 };
    const innerWidth = Math.max(40, width - margins.left - margins.right);
    const innerHeight = Math.max(40, height - margins.top - margins.bottom);
    return { innerWidth, innerHeight, margins };
  }

  function getProjectedPoints() {
    const pointsF32 = chart?.data?.pointsF32;
    if (!(pointsF32 instanceof Float32Array) || pointsF32.length === 0) return [];

    const { innerWidth, innerHeight, margins } = getPlotRect();
    
    // For 3D, we need to return points in full canvas coordinates
    // The rendering happens centered on the full canvas
    const fullWidth = innerWidth + margins.left + margins.right;
    const fullHeight = innerHeight + margins.top + margins.bottom;

    const [xExtent, yExtent, zExtent] = chart.data.extents || [[-0.5, 0.5], [-0.5, 0.5], [-0.5, 0.5]];
    const xScale = d3.scaleLinear().domain(xExtent).range([-0.5, 0.5]);
    const yScale = d3.scaleLinear().domain(yExtent).range([-0.5, 0.5]);
    const zScale = d3.scaleLinear().domain(zExtent).range([-0.5, 0.5]);

    const yaw = chart.rotation?.yaw ?? 0;
    const pitch = chart.rotation?.pitch ?? 0;
    const S = chart.rotation?.scale ?? 1;

    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);

    const usePerspective = !!STYLE_3D.perspective.enabled;
    const zEye = STYLE_3D.perspective.zEye;

    function project(x, y, z) {
      const nx = xScale(x);
      const ny = yScale(y);
      const nz = zScale(z);
      const yawX = nx * cosYaw + nz * sinYaw;
      const yawZ = -nx * sinYaw + nz * cosYaw;
      const pitchY = ny * cosPitch - yawZ * sinPitch;
      const pitchZ = ny * sinPitch + yawZ * cosPitch;

      let px, py, k = 1.0;
      if (usePerspective) {
        const zCam = (pitchZ + 1.0) * 0.5 * 2.0;
        k = 1.0 / Math.max(0.1, zEye + zCam);
        px = yawX * innerWidth * 0.65 * S * k;
        py = pitchY * innerHeight * 0.65 * S * k;
      } else {
        px = yawX * innerWidth * 0.65 * S;
        py = pitchY * innerHeight * 0.65 * S;
      }
      
      // Return coordinates relative to full canvas (center at fullWidth/2, fullHeight/2)
      // Add margins.left to center horizontally on the full canvas
      return {
        x: margins.left + innerWidth / 2 + px,
        y: margins.top + innerHeight / 2 + py,
      };
    }

    const n = pointsF32.length / 3;
    const out = new Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const x = pointsF32[i * 3];
      const y = pointsF32[i * 3 + 1];
      const z = pointsF32[i * 3 + 2];
      const p = project(x, y, z);
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        out[j++] = { x: p.x, y: p.y, index: i };
      }
    }
    if (j !== n) out.length = j;
    return out;
  }

  function onActivate() {
    try {
      prevAuto = typeof chart.getAutoRotationEnabled === "function" ? !!chart.getAutoRotationEnabled() : null;
    } catch (_) {
      prevAuto = null;
    }
    try { chart._stopSpin?.(); } catch (_) {}
    try { chart._stopAutoSpin?.(); } catch (_) {}
    try { chart.setAutoRotationEnabled?.(false); } catch (_) {}
    try { chart._unbind3D?.(); rotationDisabled = true; } catch (_) {}
    chart.requestRender?.(false);
  }

  function onDeactivate() {
    // Rebind rotate gestures
    try { chart._bind3D?.(); rotationDisabled = false; } catch (_) {}
    // Restore prior auto-rotation state
    if (prevAuto != null) {
      try { chart.setAutoRotationEnabled?.(!!prevAuto); } catch (_) {}
    }
    chart.requestRender?.(false);
  }

  function cursorForTool(tool) {
    // allow brush-like cursor, but crosshair fallback is fine
    return "crosshair";
  }

  return { 
    getProjectedPoints, 
    getPlotRect, 
    onActivate, 
    onDeactivate, 
    cursorForTool,
    is3D: true  // Flag to indicate 3D mode
  };
}

export default { create3DSelectionAdapter };