const GRID_ROOT_ID = 'workspaceRoot';
const GRID_CONTAINER_ID = 'workspaceGrid';
const DEFAULT_ROW_COUNT = 12;
const DEFAULT_COLUMN_COUNT = 12;

let gridInstance = null;
let initialized = false;

function sanitizeDimension(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function createGridContainer() {
  const grid = document.createElement('div');
  grid.id = GRID_CONTAINER_ID;
  grid.className = [
    'grid',
    'w-full',
    'flex-1',
    'min-h-0',
    'bg-white',
    'workspace-grid',
  ].join(' ');
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', 'Workspace layout grid');
  grid.style.setProperty('--workspace-grid-rows', String(DEFAULT_ROW_COUNT));
  grid.style.setProperty('--workspace-grid-columns', String(DEFAULT_COLUMN_COUNT));
  grid.setAttribute('aria-rowcount', String(DEFAULT_ROW_COUNT));
  grid.setAttribute('aria-colcount', String(DEFAULT_COLUMN_COUNT));
  return grid;
}

function applyGridDimensions({ rowCount, columnCount } = {}) {
  if (!gridInstance) return;
  const rows = sanitizeDimension(rowCount, DEFAULT_ROW_COUNT);
  const columns = sanitizeDimension(columnCount, DEFAULT_COLUMN_COUNT);
  gridInstance.style.setProperty('--workspace-grid-rows', String(rows));
  gridInstance.style.setProperty('--workspace-grid-columns', String(columns));
  gridInstance.setAttribute('aria-rowcount', String(rows));
  gridInstance.setAttribute('aria-colcount', String(columns));
}

function handleSheetSelected(event) {
  const sheet = event?.detail?.sheet || null;
  const rowCount = sheet?.rowCount;
  const columnCount = sheet?.columnCount;
  applyGridDimensions({ rowCount, columnCount });
}

export function initWorkspaceGrid() {
  if (initialized && gridInstance) {
    applyGridDimensions();
    return;
  }

  const root = document.getElementById(GRID_ROOT_ID);
  if (!root) {
    console.warn('[ui:workspaceGrid] Workspace root element not found.');
    return;
  }

  gridInstance = document.getElementById(GRID_CONTAINER_ID);
  if (!gridInstance) {
    gridInstance = createGridContainer();
    root.appendChild(gridInstance);
  }

  applyGridDimensions();
  if (!initialized) {
    document.addEventListener('sheet:selected', handleSheetSelected);
    initialized = true;
  }
}

export default {
  initWorkspaceGrid,
};
