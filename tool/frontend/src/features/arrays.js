import { requestJson } from '../api/client.js';
import { fetchColumnStatistics, formatStatistic } from '../api/stats.js';
import { listArrays, removeArray } from '../api/projects.js';
import {
  byId,
  clearChildren,
  safeText,
  setStatusMessage,
  toggleHidden,
} from '../ui/dom.js';
import { showConfirmationDialog } from '../ui/confirm.js';

const FEATURE_NAME = 'arrays';

const DEFAULT_PREVIEW_LIMIT = 10;
const PREVIEW_LIMIT_OPTIONS = [10, 25, 50];

let initialized = false;
let previewLimit = DEFAULT_PREVIEW_LIMIT;
let currentPreview = null;
let arraysByProject = new Map();
let isEditingVisibility = false;

const elements = {};
const tooltips = new Set();

function cacheElements() {
  elements.projectSelect = byId('projectSelect');
  elements.arraySelect = byId('arraySelect');
  elements.arrayTableHead = byId('arrayTableHead');
  elements.arrayTableBody = byId('arrayTableBody');
  elements.arrayTableWrapper = byId('arrayTableWrapper');
  elements.arrayPaginationInfo = byId('arrayPaginationInfo');
  elements.prevRowsBtn = byId('prevRowsBtn');
  elements.nextRowsBtn = byId('nextRowsBtn');
  elements.arrayLimitSelect = byId('arrayLimitSelect');
  elements.arrayActions = byId('arrayActions');
  elements.arrayRenameBtn = byId('arrayRenameBtn');
  elements.arrayColumnsBtn = byId('arrayColumnsBtn');
  elements.arrayDeleteBtn = byId('arrayDeleteBtn');
  elements.arrayVisibilityToggle = byId('arrayVisibilityToggle');
  elements.arrayVisibilityLabel = byId('arrayVisibilityLabel');
  elements.arrayVisibilityStatus = byId('arrayVisibilityStatus');
}

function formatTone(tone) {
  if (tone === 'error') {
    return { tone: 'error', isError: true };
  }
  if (tone === 'success') {
    return { tone: 'success' };
  }
  return { tone: tone || 'info' };
}

function getSelectedProjectName() {
  const value = elements.projectSelect?.value ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

function arrayKey(array) {
  if (!array || typeof array !== 'object') return '';
  if (typeof array.id === 'string' && array.id.trim()) return array.id.trim();
  if (typeof array.name === 'string' && array.name.trim()) return array.name.trim();
  return '';
}

function describeArray(array) {
  if (!array || typeof array !== 'object') return '';
  const name = array.name ?? 'unnamed';
  const shapeValues = Array.isArray(array.shape) ? array.shape : [];
  const meta = [];
  if (shapeValues.length) {
    meta.push(shapeValues.join('×'));
  } else if (Array.isArray(array.shape)) {
    meta.push('scalar');
  }
  if (array.dtype) meta.push(String(array.dtype));
  const suffix = array.enabled === false ? ' (hidden)' : '';
  return meta.length ? `${name} (${meta.join(', ')})${suffix}` : `${name}${suffix}`;
}

function makePreviewKey(projectName, arrayId) {
  return `${projectName ?? ''}::${arrayId ?? ''}`;
}

function setArrayVisibilityStatus(message, tone = 'muted') {
  if (!elements.arrayVisibilityStatus) return;
  setStatusMessage(elements.arrayVisibilityStatus, message, formatTone(tone));
}

function updateVisibilityControls(array) {
  const toggle = elements.arrayVisibilityToggle;
  const label = elements.arrayVisibilityLabel;
  if (!toggle || !label) return;
  const enabled = array ? array.enabled !== false : false;
  toggle.checked = enabled;
  toggle.disabled = true;
  label.textContent = enabled ? 'Array available in app' : 'Array hidden from app';
  setArrayVisibilityStatus(enabled ? 'Visibility editing available in the dedicated editor.' : 'Array is currently hidden.', enabled ? 'muted' : 'info');
}

function clearTooltips() {
  tooltips.forEach(tooltip => {
    tooltip.classList.add('hidden');
    tooltip.dataset.visible = 'false';
  });
}

function clearArrayPreview(message = 'Select a project to load a preview.') {
  const { arrayTableHead, arrayTableBody, arrayPaginationInfo } = elements;
  clearTooltips();
  tooltips.clear();
  if (arrayTableHead) clearChildren(arrayTableHead);
  if (arrayTableBody) {
    clearChildren(arrayTableBody);
    if (message) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 1;
      cell.className = 'px-4 py-6 text-center text-sm text-gray-500';
      cell.textContent = message;
      row.append(cell);
      arrayTableBody.append(row);
    }
  }
  if (arrayPaginationInfo) {
    arrayPaginationInfo.textContent = message;
  }
  if (elements.arrayTableWrapper) {
    elements.arrayTableWrapper.classList.remove('opacity-60');
  }
  currentPreview = null;
}

function setPaginationControls({ canPrev, canNext, label }) {
  if (elements.prevRowsBtn) {
    elements.prevRowsBtn.disabled = !canPrev;
  }
  if (elements.nextRowsBtn) {
    elements.nextRowsBtn.disabled = !canNext;
  }
  if (elements.arrayPaginationInfo) {
    elements.arrayPaginationInfo.textContent = label;
  }
}

function renderStatsTooltipContent(container, stats) {
  container.innerHTML = '';
  const statsList = document.createElement('div');
  statsList.className = 'space-y-1';
  const addStat = (statLabel, value) => {
    const row = document.createElement('p');
    row.className = 'flex items-baseline justify-between text-[11px] text-gray-700';

    const labelEl = document.createElement('span');
    labelEl.className = 'font-semibold text-gray-900';
    labelEl.textContent = `${statLabel}:`;

    const valueEl = document.createElement('span');
    valueEl.className = 'ml-3 font-mono text-gray-900';
    valueEl.textContent = formatStatistic(value);

    row.append(labelEl, valueEl);
    statsList.append(row);
  };

  addStat('Min', stats?.min);
  addStat('Max', stats?.max);
  addStat('Average', stats?.average);
  addStat('Mean', stats?.mean);
  addStat('Median', stats?.median);

  container.append(statsList);
}

function renderStatsMessage(container, message, { isError = false } = {}) {
  container.innerHTML = '';
  const paragraph = document.createElement('p');
  paragraph.className = `text-[11px] ${isError ? 'text-red-600' : 'text-gray-500'}`;
  paragraph.textContent = message;
  container.append(paragraph);
}

function ensureColumnStats(preview, columnIndex, container) {
  if (!preview) return;
  preview.columnStatsCache ??= {};
  const cache = preview.columnStatsCache[columnIndex];
  if (cache?.status === 'ready') {
    renderStatsTooltipContent(container, cache.stats);
    return;
  }
  if (cache?.status === 'loading') {
    renderStatsMessage(container, 'Loading statistics…');
    cache.promise?.catch(() => {});
    return;
  }

  renderStatsMessage(container, 'Loading statistics…');
  const requestKey = preview.key;
  const promise = fetchColumnStatistics(preview.project, preview.arrayId, columnIndex)
    .then(stats => {
      if (!currentPreview || currentPreview.key !== requestKey) {
        return null;
      }
      preview.columnStatsCache[columnIndex] = { status: 'ready', stats };
      renderStatsTooltipContent(container, stats || {});
      return stats;
    })
    .catch(error => {
      console.error('[Feature:arrays] Failed to load column statistics', error);
      if (!currentPreview || currentPreview.key !== requestKey) {
        return null;
      }
      preview.columnStatsCache[columnIndex] = { status: 'error', error };
      renderStatsMessage(container, 'Failed to load statistics.', { isError: true });
      return null;
    });

  preview.columnStatsCache[columnIndex] = { status: 'loading', promise };
}

function renderTable(columns, rows, { preview, arrayEnabled }) {
  const head = elements.arrayTableHead;
  const body = elements.arrayTableBody;
  if (!head || !body) return;

  clearTooltips();
  tooltips.clear();
  clearChildren(head);
  clearChildren(body);

  const safeColumns = Array.isArray(columns) && columns.length
    ? columns.map(col => String(col))
    : Array.isArray(rows) && rows.length && Array.isArray(rows[0])
      ? rows[0].map((_, idx) => `Column ${idx + 1}`)
      : ['Value'];

  const headerRow = document.createElement('tr');
  safeColumns.forEach((label, index) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.className = 'relative px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500';

    const headerContent = document.createElement('div');
    headerContent.className = 'flex items-center gap-2';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    headerContent.append(labelSpan);
    th.append(headerContent);

    if (preview) {
      const infoBtn = document.createElement('button');
      infoBtn.type = 'button';
      infoBtn.className = 'ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold text-gray-400 transition hover:border-blue-400 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1';
      infoBtn.setAttribute('aria-label', `Show statistics for ${label}`);
      infoBtn.setAttribute('data-column-info', 'true');
      infoBtn.setAttribute('aria-expanded', 'false');
      infoBtn.innerHTML = `
        <svg aria-hidden="true" viewBox="0 0 16 16" class="h-3.5 w-3.5">
          <path
            fill="currentColor"
            d="M8 1.333A6.667 6.667 0 1 0 14.667 8 6.675 6.675 0 0 0 8 1.333Zm0 10.667a1 1 0 1 1 1-1 1.001 1.001 0 0 1-1 1Zm1-3.667a.667.667 0 0 1-.667.667h-.666a.667.667 0 0 0 0 1.334h.333v.333a.667.667 0 0 1-1.333 0V9a1.334 1.334 0 0 1 1.333-1.333.667.667 0 0 0 0-1.334 1.333 1.333 0 1 1 1.333-1.333.667.667 0 1 1-1.333 0 .667.667 0 0 0-1.333 0 .667.667 0 0 0 .667.667A1.333 1.333 0 0 1 9 8.333Z"
          />
        </svg>
      `.trim();

      const tooltip = document.createElement('div');
      tooltip.className = 'pointer-events-none absolute left-1/2 top-full z-20 hidden w-64 max-w-xs -translate-x-1/2 translate-y-2 transform rounded-lg bg-white p-3 text-xs text-gray-700 shadow-lg ring-1 ring-black/10';
      tooltip.dataset.columnTooltip = 'true';
      tooltip.dataset.visible = 'false';

      const title = document.createElement('p');
      title.className = 'text-xs font-semibold text-gray-900';
      title.textContent = `${label} statistics`;
      tooltip.append(title);

      const content = document.createElement('div');
      content.className = 'mt-2 min-h-[2.75rem]';
      tooltip.append(content);

      infoBtn.addEventListener('click', event => {
        event.preventDefault();
        const isVisible = tooltip.dataset.visible === 'true';
        clearTooltips();
        if (isVisible) {
          tooltip.classList.add('hidden');
          tooltip.dataset.visible = 'false';
          infoBtn.setAttribute('aria-expanded', 'false');
          return;
        }
        tooltip.classList.remove('hidden');
        tooltip.dataset.visible = 'true';
        infoBtn.setAttribute('aria-expanded', 'true');
        ensureColumnStats(preview, index, content);
      });

      tooltips.add(tooltip);
      th.append(tooltip);
      headerContent.append(infoBtn);
    }

    headerRow.append(th);
  });
  head.append(headerRow);

  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = safeColumns.length;
    cell.className = 'px-4 py-6 text-center text-sm text-gray-500';
    cell.textContent = preview?.emptyMessage || 'No rows to display.';
    row.append(cell);
    body.append(row);
    return;
  }

  rows.forEach(rowValues => {
    const tr = document.createElement('tr');
    rowValues.forEach(value => {
      const td = document.createElement('td');
      td.className = 'px-3 py-2 text-sm text-gray-700';
      td.textContent = safeText(value);
      tr.append(td);
    });
    body.append(tr);
  });

  if (elements.arrayTableWrapper) {
    elements.arrayTableWrapper.classList.toggle('opacity-60', !arrayEnabled);
  }
}

function updateArrayActionsState() {
  const selectedProject = getSelectedProjectName();
  const selectedKey = elements.arraySelect?.value || '';
  const arrays = arraysByProject.get(selectedProject) || [];
  const hasSelection = Boolean(selectedKey && arrays.some(array => arrayKey(array) === selectedKey));
  const canModify = hasSelection && isEditingVisibility;

  if (elements.arrayActions) {
    toggleHidden(elements.arrayActions, !canModify);
  }
  if (elements.arrayRenameBtn) {
    elements.arrayRenameBtn.disabled = !canModify;
  }
  if (elements.arrayColumnsBtn) {
    elements.arrayColumnsBtn.disabled = !canModify;
  }
  if (elements.arrayDeleteBtn) {
    elements.arrayDeleteBtn.disabled = !canModify;
  }
}

function populateArraySelect(projectName, arrays, { selectKey, reloadPreview = true } = {}) {
  const select = elements.arraySelect;
  if (!select) return;
  select.innerHTML = '';

  if (!arrays.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No arrays available';
    option.disabled = true;
    option.selected = true;
    select.append(option);
    select.disabled = true;
    clearArrayPreview('This project contains no arrays.');
    updateVisibilityControls(null);
    updateArrayActionsState();
    return;
  }

  select.disabled = false;
  let toSelect = selectKey;
  if (!toSelect || !arrays.some(array => arrayKey(array) === toSelect)) {
    toSelect = arrayKey(arrays[0]);
  }

  arrays.forEach(array => {
    const key = arrayKey(array);
    if (!key) return;
    const option = document.createElement('option');
    option.value = key;
    option.textContent = describeArray(array) || key;
    option.selected = key === toSelect;
    select.append(option);
  });

  select.value = toSelect;
  updateArrayActionsState();

  if (reloadPreview && toSelect) {
    loadArrayPreview(projectName, toSelect, 0).catch(error => {
      console.error('[Feature:arrays] Failed to load array preview', error);
    });
  }
}

async function loadArraysForProject(projectName, { selectArray, reloadPreview = true } = {}) {
  if (!projectName) {
    arraysByProject.delete(projectName);
    populateArraySelect(projectName, [], { reloadPreview: false });
    return;
  }

  try {
    const response = await listArrays(projectName);
    const arrays = Array.isArray(response) ? response : [];
    arraysByProject.set(projectName, arrays);
    populateArraySelect(projectName, arrays, { selectKey: selectArray, reloadPreview });
  } catch (error) {
    console.error('[Feature:arrays] Failed to load arrays', error);
    arraysByProject.set(projectName, []);
    populateArraySelect(projectName, [], { reloadPreview: false });
    setArrayVisibilityStatus('Failed to load arrays for this project.', 'error');
  }
}

function computePaginationLabel(preview) {
  if (!preview) {
    return 'Select an array to preview.';
  }
  const begin = preview.offset + 1;
  const end = preview.offset + preview.rows.length;
  const total = Number.isFinite(preview.totalRows) ? preview.totalRows : preview.rows.length;
  if (!preview.rows.length) {
    return 'This array contains no rows.';
  }
  return `Showing rows ${begin}-${end} of ${total}`;
}

async function loadArrayPreview(projectName, arrayId, offset = 0) {
  if (!projectName || !arrayId) {
    clearArrayPreview('Select an array to preview.');
    return;
  }

  setPaginationControls({ canPrev: false, canNext: false, label: 'Loading preview…' });

  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(previewLimit),
  });

  try {
    const data = await requestJson(`/api/v1/projects/${encodeURIComponent(projectName)}/arrays/${encodeURIComponent(arrayId)}?${params.toString()}`);
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const columns = Array.isArray(data?.columns) ? data.columns.map(col => String(col)) : [];
    const resolvedId = typeof data?.id === 'string' && data.id.trim() ? data.id.trim() : arrayId;
    const resolvedName = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : resolvedId;
    const columnStats = Array.isArray(data?.column_stats) ? data.column_stats : [];
    const emptyMessage = rows.length ? '' : 'Array contains no rows.';

    const previewKey = makePreviewKey(projectName, resolvedId);
    const columnStatsCache = {};
    columnStats.forEach((stats, idx) => {
      if (stats && typeof stats === 'object') {
        columnStatsCache[idx] = { status: 'ready', stats };
      }
    });

    currentPreview = {
      project: projectName,
      arrayId: resolvedId,
      arrayName: resolvedName,
      key: previewKey,
      offset: Number.isFinite(data?.offset) ? data.offset : offset,
      limit: Number.isFinite(data?.limit) ? data.limit : previewLimit,
      totalRows: Number.isFinite(data?.total_rows) ? data.total_rows : rows.length,
      rowCount: rows.length,
      columns,
      columnStatsCache,
      rows,
      emptyMessage,
    };

    const projectArrays = arraysByProject.get(projectName) || [];
    const arrayMeta = projectArrays.find(array => arrayKey(array) === resolvedId) || null;

    renderTable(columns, rows, { preview: currentPreview, arrayEnabled: arrayMeta ? arrayMeta.enabled !== false : true });
    setPaginationControls({
      canPrev: currentPreview.offset > 0,
      canNext: currentPreview.offset + currentPreview.rowCount < currentPreview.totalRows,
      label: computePaginationLabel(currentPreview),
    });
    updateVisibilityControls(arrayMeta);
  } catch (error) {
    console.error('[Feature:arrays] Failed to load array preview', error);
    clearArrayPreview('Failed to load array preview.');
    setArrayVisibilityStatus('Failed to load array preview.', 'error');
  }
}

function handleRenameRequest() {
  const projectName = getSelectedProjectName();
  const arrayId = elements.arraySelect?.value;
  if (!isEditingVisibility) {
    setArrayVisibilityStatus('Enter edit mode to rename arrays.', 'error');
    return;
  }
  if (!projectName || !arrayId) return;
  const arrays = arraysByProject.get(projectName) || [];
  const arrayMeta = arrays.find(array => arrayKey(array) === arrayId);
  if (!arrayMeta) return;
  const existingNames = new Set(arrays.map(array => (array.name || array.id || '').toLowerCase()).filter(Boolean));
  document.dispatchEvent(new CustomEvent('array:rename-request', {
    detail: {
      projectName,
      arrayId,
      currentName: arrayMeta.name || arrayId,
      displayName: describeArray(arrayMeta),
      existingNames,
    },
  }));
}

function handleRenameSuccess(detail) {
  const { projectName, arrayId, nextName, response } = detail || {};
  if (!projectName || !arrayId) return;
  const arrays = arraysByProject.get(projectName);
  if (!Array.isArray(arrays)) return;
  const entry = arrays.find(array => arrayKey(array) === arrayId);
  if (!entry) return;
  if (typeof nextName === 'string') {
    entry.name = nextName;
  }
  if (response?.array?.enabled != null) {
    entry.enabled = response.array.enabled !== false;
  }
  arraysByProject.set(projectName, arrays);
  populateArraySelect(projectName, arrays, { selectKey: arrayId, reloadPreview: false });
  loadArrayPreview(projectName, arrayId, 0).catch(() => {});
}

async function handleDeleteRequest() {
  const projectName = getSelectedProjectName();
  const arrayId = elements.arraySelect?.value;
  if (!projectName || !arrayId) return;
  if (!isEditingVisibility) {
    setArrayVisibilityStatus('Enter edit mode to delete arrays.', 'error');
    return;
  }

  const arrays = arraysByProject.get(projectName) || [];
  const arrayMeta = arrays.find(array => arrayKey(array) === arrayId);
  if (!arrayMeta) {
    setArrayVisibilityStatus('Array metadata unavailable. Refresh and try again.', 'error');
    return;
  }

  const label = describeArray(arrayMeta) || arrayMeta.name || arrayMeta.id || arrayId;
  const confirmed = await showConfirmationDialog({
    title: 'Delete array?',
    message: `Delete array "${label}" from this project? This action cannot be undone.`,
    confirmLabel: 'Delete array',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) {
    return;
  }

  if (elements.arrayDeleteBtn) {
    elements.arrayDeleteBtn.disabled = true;
  }
  setArrayVisibilityStatus(`Deleting "${label}"…`, 'info');

  try {
    const response = await removeArray(projectName, arrayId);
    const updatedArrays = Array.isArray(response?.arrays) ? response.arrays : arrays.filter(array => arrayKey(array) !== arrayId);
    arraysByProject.set(projectName, updatedArrays);
    const nextSelection = updatedArrays.find(array => arrayKey(array) !== '' && arrayKey(array) !== arrayId);
    const nextKey = nextSelection ? arrayKey(nextSelection) : '';
    currentPreview = null;
    populateArraySelect(projectName, updatedArrays, { selectKey: nextKey, reloadPreview: Boolean(nextKey) });

    document.dispatchEvent(new CustomEvent('array:deleted', {
      detail: { projectName, arrayId, response },
    }));

    document.dispatchEvent(new CustomEvent('projects:refresh-requested', {
      detail: { preferredProject: projectName, reason: 'array-deleted' },
    }));

    setArrayVisibilityStatus('Array deleted.', 'success');
  } catch (error) {
    console.error('[Feature:arrays] Failed to delete array', error);
    setArrayVisibilityStatus('Failed to delete array. Try again.', 'error');
  } finally {
    if (elements.arrayDeleteBtn) {
      elements.arrayDeleteBtn.disabled = false;
    }
    updateArrayActionsState();
  }
}

function handleVisibilityEditModeChanged(event) {
  isEditingVisibility = Boolean(event.detail?.editing);
  updateArrayActionsState();
}

function handleColumnNamesUpdateComplete(event) {
  const { success, projectName, arrayId, response } = event.detail || {};
  if (!success || !projectName) return;

  if (!Array.isArray(response?.arrays)) {
    if (projectName === getSelectedProjectName()) {
      loadArraysForProject(projectName, { selectArray: arrayId, reloadPreview: true }).catch(() => {});
    }
    return;
  }

  arraysByProject.set(projectName, response.arrays);

  if (projectName !== getSelectedProjectName()) {
    return;
  }

  const stored = response.arrays || [];
  const hasArray = stored.some(array => arrayKey(array) === arrayId);
  const selectKey = hasArray
    ? arrayId
    : stored.length
      ? arrayKey(stored[0])
      : '';
  populateArraySelect(projectName, stored, { selectKey, reloadPreview: Boolean(selectKey) });
}

function handleArraySelectChange() {
  const projectName = getSelectedProjectName();
  const arrayId = elements.arraySelect?.value;
  if (!arrayId) {
    clearArrayPreview('Select an array to preview.');
    updateArrayActionsState();
    updateVisibilityControls(null);
    return;
  }
  updateArrayActionsState();
  loadArrayPreview(projectName, arrayId, 0).catch(error => {
    console.error('[Feature:arrays] Failed to load array preview', error);
  });
}

function handlePrevRows() {
  if (!currentPreview) return;
  const nextOffset = Math.max(0, currentPreview.offset - currentPreview.limit);
  loadArrayPreview(currentPreview.project, currentPreview.arrayId, nextOffset).catch(() => {});
}

function handleNextRows() {
  if (!currentPreview) return;
  const nextOffset = currentPreview.offset + currentPreview.limit;
  if (nextOffset >= currentPreview.totalRows) return;
  loadArrayPreview(currentPreview.project, currentPreview.arrayId, nextOffset).catch(() => {});
}

function handleLimitChange() {
  if (!elements.arrayLimitSelect) return;
  const value = Number(elements.arrayLimitSelect.value);
  if (!PREVIEW_LIMIT_OPTIONS.includes(value)) {
    elements.arrayLimitSelect.value = String(previewLimit);
    return;
  }
  previewLimit = value;
  if (currentPreview) {
    loadArrayPreview(currentPreview.project, currentPreview.arrayId, 0).catch(() => {});
  }
}

function registerEventListeners() {
  elements.projectSelect?.addEventListener('change', () => {
    const projectName = getSelectedProjectName();
    clearArrayPreview('Loading arrays…');
    loadArraysForProject(projectName).catch(() => {});
  });

  elements.arraySelect?.addEventListener('change', handleArraySelectChange);
  elements.prevRowsBtn?.addEventListener('click', handlePrevRows);
  elements.nextRowsBtn?.addEventListener('click', handleNextRows);
  elements.arrayLimitSelect?.addEventListener('change', handleLimitChange);
  elements.arrayRenameBtn?.addEventListener('click', handleRenameRequest);
  elements.arrayDeleteBtn?.addEventListener('click', handleDeleteRequest);

  document.addEventListener('click', event => {
    if (!event.target.closest('[data-column-info]')) {
      clearTooltips();
    }
  });

  document.addEventListener('array:renamed', event => {
    handleRenameSuccess(event.detail);
  });

  document.addEventListener('project:selected', event => {
    const { detail } = event || {};
    const projectName = detail?.project?.name || detail?.projectName || detail?.name || getSelectedProjectName();
    if (!projectName) return;
    loadArraysForProject(projectName, { selectArray: detail?.arrayId, reloadPreview: true }).catch(() => {});
  });

  document.addEventListener('project:data-uploaded', event => {
    const { projectName } = event.detail || {};
    if (!projectName || projectName !== getSelectedProjectName()) return;
    loadArraysForProject(projectName, { reloadPreview: false }).catch(() => {});
  });

  document.addEventListener('visibility:edit-mode-changed', handleVisibilityEditModeChanged);
  document.addEventListener('column-names:update-complete', handleColumnNamesUpdateComplete);
}

function initializeLimitSelect() {
  if (!elements.arrayLimitSelect) return;
  if (!PREVIEW_LIMIT_OPTIONS.includes(previewLimit)) {
    previewLimit = DEFAULT_PREVIEW_LIMIT;
  }
  elements.arrayLimitSelect.value = String(previewLimit);
}

export function init() {
  if (initialized) return;
  initialized = true;

  cacheElements();
  initializeLimitSelect();
  updateArrayActionsState();
  clearArrayPreview('Select a project to load a preview.');
  registerEventListeners();

  const projectName = getSelectedProjectName();
  if (projectName) {
    loadArraysForProject(projectName).catch(() => {});
  }

  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export const __test__ = {
  arrayKey,
  describeArray,
  makePreviewKey,
};
