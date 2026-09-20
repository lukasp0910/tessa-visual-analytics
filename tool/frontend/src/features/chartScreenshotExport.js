import { byId } from '../ui/dom.js';
import { getCards, getSheetId, getProjectName, getCardConfiguration } from './cards/cardsState.js';
import { getCardChart } from './cards/cardsVisualization.js';
import { summarizeConfiguration } from './cards/cardsSanitizers.js';

const FEATURE_NAME = 'chartScreenshotExport';

const elements = {
  button: null,
};

function logWarn(message, ...args) {
  console.warn(`[Feature:${FEATURE_NAME}] ${message}`, ...args);
}

function setButtonBusy(isBusy) {
  if (!elements.button) return;
  elements.button.disabled = isBusy;
  elements.button.setAttribute('aria-busy', isBusy ? 'true' : 'false');
}

function sanitizeFileSegment(value, fallback = 'chart') {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return fallback;
  const slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

function resolveSvgNode(candidate) {
  if (!candidate) return null;
  if (typeof candidate.node === 'function') {
    return candidate.node();
  }
  return candidate instanceof SVGElement ? candidate : null;
}

async function drawSvgOntoCanvas(svgNode, ctx, width, height) {
  if (!svgNode || !ctx || !width || !height) return false;
  const clone = svgNode.cloneNode(true);
  if (!clone.getAttribute('width')) clone.setAttribute('width', width);
  if (!clone.getAttribute('height')) clone.setAttribute('height', height);
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const serialized = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const loadPromise = new Promise((resolve, reject) => {
      image.onload = () => resolve(true);
      image.onerror = (error) => reject(error);
    });
    image.src = url;
    await loadPromise;
    ctx.drawImage(image, 0, 0, width, height);
    return true;
  } catch (error) {
    logWarn('Failed to draw SVG onto canvas', error);
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function getChartDimensions(chart) {
  const canvasWidth = chart?.canvas?.width;
  const canvasHeight = chart?.canvas?.height;
  const svgNode = resolveSvgNode(chart?.svg);
  const svgWidth = Number(svgNode?.getAttribute('width')) || null;
  const svgHeight = Number(svgNode?.getAttribute('height')) || null;
  const currentWidth = Number(chart?.currentSize?.width) || null;
  const currentHeight = Number(chart?.currentSize?.height) || null;

  const width = Math.max(
    0,
    canvasWidth || 0,
    svgWidth || 0,
    currentWidth || 0,
  );
  const height = Math.max(
    0,
    canvasHeight || 0,
    svgHeight || 0,
    currentHeight || 0,
  );
  return { width, height, svgNode };
}

async function createScatterCanvas(chart) {
  if (!chart) return null;
  const { width, height, svgNode } = getChartDimensions(chart);
  const sourceCanvas = chart.canvas;

  if (!width || !height || (!sourceCanvas && !svgNode)) return null;

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = width;
  exportCanvas.height = height;
  const ctx = exportCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  if (sourceCanvas) {
    try {
      ctx.drawImage(sourceCanvas, 0, 0, width, height);
    } catch (error) {
      logWarn('Failed to draw scatter canvas', error);
    }
  }

  if (svgNode) {
    await drawSvgOntoCanvas(svgNode, ctx, width, height);
  }

  return exportCanvas;
}

async function createSvgCanvas(svgNode, width, height) {
  if (!svgNode || !width || !height) return null;
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = width;
  exportCanvas.height = height;
  const ctx = exportCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  await drawSvgOntoCanvas(svgNode, ctx, width, height);
  return exportCanvas;
}

async function createChartCanvas(chartType, chart) {
  if (!chart) return null;
  const normalizedType = typeof chartType === 'string' ? chartType.trim().toLowerCase() : '';
  if (normalizedType === 'scatter') {
    return createScatterCanvas(chart);
  }
  if (normalizedType === 'line') {
    const { width, height, svgNode } = getChartDimensions(chart);
    if (!svgNode || !width || !height) return null;
    return createSvgCanvas(svgNode, width, height);
  }
  return null;
}

function buildFileName({ projectName, sheetId, cardId, chartType, title }) {
  const parts = [
    sanitizeFileSegment(projectName || ''),
    sanitizeFileSegment(sheetId || 'sheet'),
    sanitizeFileSegment(title || chartType || 'chart'),
    sanitizeFileSegment(cardId || ''),
  ].filter(Boolean);
  return `${parts.join('_')}.png`;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to create PNG blob'));
    }, 'image/png');
  });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function exportCardChart(card) {
  const cardId = card?.id;
  if (!cardId) return null;
  const configuration = getCardConfiguration(cardId);
  const chartType = (configuration?.chartType || '').toString().trim().toLowerCase();
  const chart = getCardChart(cardId);
  if (!chart || !chartType) return null;

  const canvas = await createChartCanvas(chartType, chart);
  if (!canvas) return null;

  const blob = await canvasToBlob(canvas);
  const summary = summarizeConfiguration(configuration);
  const filename = buildFileName({
    projectName: getProjectName(),
    sheetId: getSheetId(),
    cardId,
    chartType,
    title: summary?.title,
  });
  return { blob, filename };
}

async function handleExportClick(event) {
  event?.preventDefault?.();
  const cards = getCards();
  const sheetId = getSheetId();
  if (!Array.isArray(cards) || !cards.length || !sheetId) {
    logWarn('No charts available to export for the current sheet.');
    return;
  }

  setButtonBusy(true);
  try {
    for (const card of cards) {
      try {
        const result = await exportCardChart(card);
        if (result?.blob) {
          triggerDownload(result.blob, result.filename);
        }
      } catch (error) {
        logWarn('Failed to export chart for card', card?.id, error);
      }
    }
  } finally {
    setButtonBusy(false);
  }
}

export function init() {
  if (elements.button) return;
  elements.button = byId('exportChartsBtn');
  if (!elements.button) {
    logWarn('Screenshot export button not found.');
    return;
  }
  elements.button.addEventListener('click', handleExportClick);
}

export default { init };
