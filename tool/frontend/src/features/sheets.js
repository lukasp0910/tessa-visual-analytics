import {
  createSheet,
  deleteSheet,
  listSheets,
  setActiveSheetPreference,
  updateSheet,
} from '../api/sheets.js';
import { getSnapshot, setActiveSheet, subscribe } from '../state/store.js';
import { byId, clearChildren, safeText, setStatusMessage } from '../ui/dom.js';
import { closeModal, openModal } from '../ui/modal.js';
import { showConfirmationDialog } from '../ui/confirm.js';

const FEATURE_NAME = 'sheets';

const PLACEHOLDER_CLASSES = 'flex-shrink-0 rounded-lg border border-dashed border-gray-300 px-4 py-1.5 text-sm font-medium';
const TAB_BASE_CLASSES = 'flex-shrink-0 w-32 truncate text-center';
const INACTIVE_CLASSES = `${TAB_BASE_CLASSES} rounded-lg border border-transparent px-4 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`;
const ACTIVE_CLASSES = `${TAB_BASE_CLASSES} rounded-lg border border-blue-500 bg-blue-50 px-4 py-1.5 text-sm font-medium text-blue-600 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`;
const DEFAULT_ROW_COUNT = 12;
const DEFAULT_COLUMN_COUNT = 12;

function clamp(value, min, max) {
  const lower = Number.isFinite(min) ? min : 0;
  const upper = Number.isFinite(max) ? max : lower;
  if (upper < lower) return lower;
  return Math.min(Math.max(value, lower), upper);
}

function normalizeCardCoordinate(value, limit) {
  const maxIndex = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
  let candidate = 0;

  if (typeof value === 'number' && Number.isFinite(value)) {
    candidate = Math.trunc(value);
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (text) {
      const parsed = Number.parseInt(text, 10);
      if (Number.isInteger(parsed)) {
        candidate = parsed;
      }
    }
  } else if (value != null) {
    const text = String(value).trim();
    if (text) {
      const parsed = Number.parseInt(text, 10);
      if (Number.isInteger(parsed)) {
        candidate = parsed;
      }
    }
  }

  if (!Number.isInteger(candidate)) {
    candidate = 0;
  }

  return clamp(candidate, 0, maxIndex);
}

function cloneConfigValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const text = safeText(value).trim();
    return text ? text : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const result = [];
    value.forEach(item => {
      const cloned = cloneConfigValue(item);
      if (cloned !== null) {
        result.push(cloned);
      }
    });
    return result;
  }
  if (typeof value === 'object') {
    const result = {};
    Object.entries(value).forEach(([key, raw]) => {
      const textKey = safeText(key).trim();
      if (!textKey) return;
      const cloned = cloneConfigValue(raw);
      if (cloned === null) return;
      if (Array.isArray(cloned) && cloned.length === 0) return;
      if (typeof cloned === 'object' && !Array.isArray(cloned) && Object.keys(cloned).length === 0) return;
      result[textKey] = cloned;
    });
    return result;
  }
  return null;
}

function normalizeLineMeasure(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const identifier = safeText(entry.id).trim();
  const source = safeText(entry.source ?? entry.sourceId ?? entry.source_id).trim();
  const column = safeText(entry.column ?? entry.columnId ?? entry.column_id).trim();
  const sourceLabel = safeText(entry.sourceLabel ?? entry.source_label).trim();
  const columnLabel = safeText(entry.columnLabel ?? entry.column_label).trim();
  // Preserve subject selection when loading sheet configs
  const subject = safeText(entry.subject ?? entry.subjectId ?? entry.subject_id).trim();

  const measure = {};
  if (identifier) measure.id = identifier;
  if (source) measure.source = source;
  if (column) measure.column = column;
  if (subject) measure.subject = subject;
  if (sourceLabel) measure.sourceLabel = sourceLabel;
  if (columnLabel) measure.columnLabel = columnLabel;
  return Object.keys(measure).length ? measure : null;
}

function normalizeFieldValues(value, chartType) {
  if (!value || typeof value !== 'object') return null;
  if (chartType === 'line') {
    const result = {};
    const rawMeasures = Array.isArray(value.measures)
      ? value.measures
      : (Array.isArray(value.measurements) ? value.measurements : null);
    if (rawMeasures) {
      const measures = rawMeasures.map(normalizeLineMeasure).filter(Boolean);
      if (measures.length) {
        result.measures = measures;
      }
    }
    const axisValue = safeText(value.x ?? value.axis ?? value.dimension).trim();
    if (axisValue) {
      result.x = axisValue;
    }
    Object.entries(value).forEach(([key, raw]) => {
      if (key === 'measures' || key === 'measurements' || key === 'x' || key === 'axis' || key === 'dimension') {
        return;
      }
      const textKey = safeText(key).trim();
      if (!textKey) return;
      const cloned = cloneConfigValue(raw);
      if (cloned === null) return;
      if (Array.isArray(cloned) && cloned.length === 0) return;
      if (typeof cloned === 'object' && !Array.isArray(cloned) && Object.keys(cloned).length === 0) return;
      result[textKey] = cloned;
    });
    return Object.keys(result).length ? result : null;
  }
  const cloned = cloneConfigValue(value);
  if (!cloned || (typeof cloned === 'object' && !Array.isArray(cloned) && Object.keys(cloned).length === 0)) {
    return null;
  }
  return cloned;
}

function normalizeCardConfiguration(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const chartType = safeText(entry.chartType ?? entry.chart_type).trim();
  const chartTypeLabel = safeText(entry.chartTypeLabel ?? entry.chart_type_label).trim();
  const dataSourceId = safeText(entry.dataSourceId ?? entry.data_source_id).trim();
  const dataSourceLabel = safeText(entry.dataSourceLabel ?? entry.data_source_label).trim();
  const fieldValues = normalizeFieldValues(entry.fieldValues ?? entry.field_values, chartType);
  const configuration = {};
  if (chartType) configuration.chartType = chartType;
  if (chartTypeLabel) configuration.chartTypeLabel = chartTypeLabel;
  if (dataSourceId) configuration.dataSourceId = dataSourceId;
  if (dataSourceLabel) configuration.dataSourceLabel = dataSourceLabel;
  if (fieldValues) configuration.fieldValues = fieldValues;
  return Object.keys(configuration).length ? configuration : null;
}

function cloneCardConfiguration(config) {
  const normalized = normalizeCardConfiguration(config);
  if (!normalized) return null;
  const clone = { ...normalized };
  if (normalized.fieldValues) {
    const valuesClone = cloneConfigValue(normalized.fieldValues);
    if (valuesClone) {
      clone.fieldValues = valuesClone;
    }
  }
  return clone;
}

function normalizeCardEntry(entry, rowCount, columnCount) {
  if (!entry || typeof entry !== 'object') return null;
  const id = safeText(entry.id).trim();
  if (!id) return null;

  const maxRow = Math.max(0, Math.trunc(rowCount) - 1);
  const maxColumn = Math.max(0, Math.trunc(columnCount) - 1);

  const topLeftSource = entry.topLeft || entry.top_left || {};
  const bottomRightSource = entry.bottomRight || entry.bottom_right || {};

  const topRow = normalizeCardCoordinate(topLeftSource.row, maxRow);
  const leftColumn = normalizeCardCoordinate(topLeftSource.column, maxColumn);
  let bottomRow = normalizeCardCoordinate(bottomRightSource.row, maxRow);
  let rightColumn = normalizeCardCoordinate(bottomRightSource.column, maxColumn);

  if (bottomRow < topRow) bottomRow = topRow;
  if (rightColumn < leftColumn) rightColumn = leftColumn;

  const configuration = normalizeCardConfiguration(entry.configuration || entry.config);

  const card = {
    id,
    topLeft: { row: topRow, column: leftColumn },
    bottomRight: { row: bottomRow, column: rightColumn },
  };
  if (configuration) {
    card.configuration = configuration;
  }
  return card;
}

function normalizeCardList(cards, rowCount, columnCount) {
  if (!Array.isArray(cards)) return [];
  const seen = new Set();
  const result = [];
  cards.forEach(entry => {
    const normalized = normalizeCardEntry(entry, rowCount, columnCount);
    if (!normalized) return;
    if (seen.has(normalized.id)) return;
    seen.add(normalized.id);
    result.push(normalized);
  });
  return result;
}

function cloneCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.map(card => ({
    id: card.id,
    topLeft: {
      row: Number.isInteger(card?.topLeft?.row) ? card.topLeft.row : 0,
      column: Number.isInteger(card?.topLeft?.column) ? card.topLeft.column : 0,
    },
    bottomRight: {
      row: Number.isInteger(card?.bottomRight?.row) ? card.bottomRight.row : 0,
      column: Number.isInteger(card?.bottomRight?.column) ? card.bottomRight.column : 0,
    },
    ...(card.configuration ? { configuration: cloneCardConfiguration(card.configuration) } : {}),
  }));
}

function coerceDimension(value, fallback) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  const parsed = Number.parseInt(text, 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

const state = {
  initialized: false,
  projectName: null,
  sheets: [],
  activeSheetId: null,
  mode: 'explore',
  loading: false,
  lastError: '',
  unsubscribe: null,
  lastActiveByProject: new Map(),
  currentRequestToken: null,
  activeSheetSyncToken: null,
  createPending: false,
  managePending: false,
  defaultRowCount: DEFAULT_ROW_COUNT,
  defaultColumnCount: DEFAULT_COLUMN_COUNT,
};

const elements = {
  tabs: null,
  actions: null,
  createBtn: null,
  manageBtn: null,
  createModal: null,
  createForm: null,
  createName: null,
  createStatus: null,
  createSubmit: null,
  createCancel: null,
  createClose: null,
  createRowCount: null,
  createColumnCount: null,
  manageModal: null,
  manageForm: null,
  manageName: null,
  manageStatus: null,
  manageSubmit: null,
  manageCancel: null,
  manageClose: null,
  deleteBtn: null,
};

function normalizeProjectKey(value) {
  return safeText(value).trim();
}

function getStoredActiveSheetId(projectName) {
  const projectKey = normalizeProjectKey(projectName);
  if (!projectKey) return null;
  const snapshot = getSnapshot();
  const map = snapshot?.ui?.activeSheets;
  if (!map || typeof map !== 'object') return null;
  const stored = map[projectKey];
  const sheetId = safeText(stored).trim();
  return sheetId || null;
}

function rememberActiveSheet(projectName, sheetId) {
  const projectKey = normalizeProjectKey(projectName);
  if (!projectKey) return;
  const normalizedSheetId = safeText(sheetId).trim();
  if (normalizedSheetId) {
    state.lastActiveByProject.set(projectKey, normalizedSheetId);
    setActiveSheet(projectKey, normalizedSheetId);
  } else {
    state.lastActiveByProject.delete(projectKey);
    setActiveSheet(projectKey, null);
  }
}

function hydrateActiveSheetCache() {
  state.lastActiveByProject.clear();
  const snapshot = getSnapshot();
  const map = snapshot?.ui?.activeSheets;
  if (!map || typeof map !== 'object') return;
  Object.entries(map).forEach(([projectName, sheetId]) => {
    const projectKey = normalizeProjectKey(projectName);
    const normalizedSheetId = safeText(sheetId).trim();
    if (!projectKey || !normalizedSheetId) return;
    state.lastActiveByProject.set(projectKey, normalizedSheetId);
  });
}

function persistActiveSheetSelection(sheetId) {
  if (!state.projectName) return;
  const projectName = state.projectName;
  const normalizedSheetId = safeText(sheetId).trim();
  const payloadId = normalizedSheetId || null;
  const requestToken = Symbol('sheets-active-sync');
  state.activeSheetSyncToken = requestToken;
  setActiveSheetPreference(projectName, payloadId)
    .catch(error => {
      console.error('[Feature:sheets] Failed to persist active sheet preference', error);
    })
    .finally(() => {
      if (state.activeSheetSyncToken === requestToken) {
        state.activeSheetSyncToken = null;
      }
    });
}

function cacheElements() {
  elements.tabs = byId('sheetTabs');
  elements.actions = byId('sheetActions');
  elements.createBtn = byId('sheetCreateBtn');
  elements.manageBtn = byId('sheetManageBtn');
  elements.createModal = byId('sheetCreateModal');
  elements.createForm = byId('sheetCreateForm');
  elements.createName = byId('sheetCreateName');
  elements.createRowCount = byId('sheetCreateRowCount');
  elements.createColumnCount = byId('sheetCreateColumnCount');
  elements.createStatus = byId('sheetCreateStatus');
  elements.createSubmit = byId('sheetCreateSubmitBtn');
  elements.createCancel = byId('sheetCreateCancelBtn');
  elements.createClose = byId('sheetCreateModalClose');
  elements.manageModal = byId('sheetManageModal');
  elements.manageForm = byId('sheetManageForm');
  elements.manageName = byId('sheetManageName');
  elements.manageStatus = byId('sheetManageStatus');
  elements.manageSubmit = byId('sheetManageSaveBtn');
  elements.manageCancel = byId('sheetManageCancelBtn');
  elements.manageClose = byId('sheetManageModalClose');
  elements.deleteBtn = byId('sheetDeleteBtn');

  if (elements.tabs) {
    elements.tabs.setAttribute('role', 'tablist');
    elements.tabs.setAttribute('aria-live', 'polite');
  }
}

function setStatus(element, message, tone = 'muted') {
  if (!element) return;
  const text = safeText(message);
  let options = { tone: 'muted' };
  if (tone === 'error') {
    options = { tone: 'error', isError: true };
  } else if (tone === 'success') {
    options = { tone: 'success' };
  } else if (tone === 'info') {
    options = { tone: 'info' };
  }
  setStatusMessage(element, text, options);
}

function updateDefaultGridFromSheet(sheet) {
  const rowCount = sheet?.rowCount;
  const columnCount = sheet?.columnCount;
  state.defaultRowCount = Number.isInteger(rowCount) && rowCount > 0 ? rowCount : DEFAULT_ROW_COUNT;
  state.defaultColumnCount = Number.isInteger(columnCount) && columnCount > 0 ? columnCount : DEFAULT_COLUMN_COUNT;
}

function dispatchSheetSelected(sheet, reason = 'update') {
  updateDefaultGridFromSheet(sheet);
  const normalizedSheet = sheet ? { ...sheet, cards: cloneCards(sheet.cards) } : null;
  const detail = {
    projectName: state.projectName,
    sheetId: sheet ? sheet.id : null,
    sheet: normalizedSheet,
    reason,
  };
  document.dispatchEvent(new CustomEvent('sheet:selected', { detail }));
}

function dispatchSheetEvent(type, detail = {}) {
  const payload = {
    projectName: state.projectName,
    ...detail,
  };
  document.dispatchEvent(new CustomEvent(`sheet:${type}`, { detail: payload }));
}

function normalizeSheetEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = safeText(entry.id).trim();
  if (!id) return null;
  let name = safeText(entry.name).trim();
  if (!name) name = id;
  const createdAt = safeText(entry.createdAt || entry.created_at).trim();
  const updatedAt = safeText(entry.updatedAt || entry.updated_at).trim();
  const rowCount = coerceDimension(entry.rowCount ?? entry.row_count, DEFAULT_ROW_COUNT);
  const columnCount = coerceDimension(entry.columnCount ?? entry.column_count, DEFAULT_COLUMN_COUNT);
  const cards = normalizeCardList(entry.cards, rowCount, columnCount);
  const rawActiveCardId = entry.lastActiveCardId ?? entry.last_active_card_id;
  const activeCardId = safeText(rawActiveCardId).trim();
  const lastActiveCardId = cards.some(card => card.id === activeCardId)
    ? activeCardId
    : null;

  return {
    id,
    name,
    createdAt,
    updatedAt,
    rowCount,
    columnCount,
    cards,
    lastActiveCardId,
  };
}

function normalizeSheets(rawSheets) {
  if (!Array.isArray(rawSheets)) return [];
  return rawSheets.map(normalizeSheetEntry).filter(Boolean);
}

function findSheetById(sheetId) {
  if (!sheetId) return null;
  return state.sheets.find(sheet => sheet.id === sheetId) || null;
}

function computeDefaultSheetName() {
  const existingNames = new Set(state.sheets.map(sheet => sheet.name.toLowerCase()));
  let maxIndex = 0;
  state.sheets.forEach(sheet => {
    const match = sheet.name.match(/Sheet\s*(\d+)/i);
    if (!match) return;
    const index = Number.parseInt(match[1], 10);
    if (Number.isInteger(index) && index > maxIndex) {
      maxIndex = index;
    }
  });
  let candidateIndex = Math.max(maxIndex + 1, state.sheets.length + 1);
  let candidate = `Sheet ${candidateIndex}`;
  while (existingNames.has(candidate.toLowerCase())) {
    candidateIndex += 1;
    candidate = `Sheet ${candidateIndex}`;
  }
  return candidate;
}

function createPlaceholder(message, tone = 'muted') {
  const span = document.createElement('span');
  span.textContent = message;
  span.className = PLACEHOLDER_CLASSES;
  span.classList.add('text-gray-400');
  if (tone === 'error') {
    span.classList.remove('text-gray-400');
    span.classList.add('border-red-200', 'text-red-500');
  } else if (tone === 'info') {
    span.classList.add('text-gray-500');
  }
  span.setAttribute('aria-disabled', 'true');
  return span;
}

function renderTabs() {
  const container = elements.tabs;
  if (!container) return;
  clearChildren(container);

  if (!state.projectName) {
    container.append(createPlaceholder('Select a project to view sheets.', 'info'));
    updateActionsState();
    return;
  }

  if (state.loading) {
    container.append(createPlaceholder('Loading sheets…', 'info'));
    updateActionsState();
    return;
  }

  if (state.lastError) {
    container.append(createPlaceholder(state.lastError, 'error'));
    updateActionsState();
    return;
  }

  if (!state.sheets.length) {
    container.append(createPlaceholder('No sheets available.', 'info'));
    updateActionsState();
    return;
  }

  state.sheets.forEach(sheet => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = sheet.name;
    button.title = sheet.name;
    button.dataset.sheetId = sheet.id;
    const isActive = sheet.id === state.activeSheetId;
    button.className = isActive ? ACTIVE_CLASSES : INACTIVE_CLASSES;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    button.setAttribute('tabindex', isActive ? '0' : '-1');
    button.setAttribute('aria-controls', `sheet-panel-${sheet.id}`);
    container.append(button);
  });

  updateActionsState();
}

function updateActionsState() {
  const hasProject = Boolean(state.projectName);
  const hasSheets = state.sheets.length > 0;
  const isEditable = state.mode === 'edit';

  if (elements.actions) {
    const shouldShow = hasProject && isEditable;
    elements.actions.classList.toggle('hidden', !shouldShow);
  }

  if (elements.createBtn) {
    elements.createBtn.disabled = !(hasProject && isEditable) || state.loading;
  }

  if (elements.manageBtn) {
    const disableManage = !hasProject || !hasSheets || !isEditable || state.loading;
    elements.manageBtn.disabled = disableManage;
  }
}

function applySheetList(rawSheets, { preferredId, preferredName, storedId, reason } = {}) {
  const previousId = state.activeSheetId;
  const normalized = normalizeSheets(rawSheets);
  state.sheets = normalized;

  const findById = id => normalized.find(sheet => sheet.id === id) || null;
  const findByName = name => normalized.find(sheet => sheet.name === name) || null;
  const projectKey = normalizeProjectKey(state.projectName);
  const normalizedStoredId = safeText(storedId).trim();

  let nextId = null;
  if (preferredId && findById(preferredId)) {
    nextId = preferredId;
  } else if (preferredName && findByName(preferredName)) {
    nextId = findByName(preferredName).id;
  } else if (previousId && findById(previousId)) {
    nextId = previousId;
  } else if (normalizedStoredId && findById(normalizedStoredId)) {
    nextId = normalizedStoredId;
  } else {
    if (projectKey) {
      const storedId = getStoredActiveSheetId(projectKey);
      if (storedId && findById(storedId)) {
        nextId = storedId;
      } else if (state.lastActiveByProject.has(projectKey)) {
        const saved = state.lastActiveByProject.get(projectKey);
        if (saved && findById(saved)) {
          nextId = saved;
        }
      }
    }
  }
  if (!nextId && normalized.length) {
    nextId = normalized[0].id;
  }

  state.activeSheetId = nextId || null;
  if (projectKey && state.activeSheetId) {
    rememberActiveSheet(projectKey, state.activeSheetId);
  } else if (projectKey && !state.activeSheetId) {
    rememberActiveSheet(projectKey, null);
  }

  renderTabs();

  const activeSheet = state.activeSheetId ? findById(state.activeSheetId) : null;
  updateDefaultGridFromSheet(activeSheet);
  if (previousId !== state.activeSheetId || (!activeSheet && previousId)) {
    dispatchSheetSelected(activeSheet, reason || 'update');
  }
  return activeSheet;
}

async function loadSheets(projectName, { reason } = {}) {
  hydrateActiveSheetCache();
  const safeName = typeof projectName === 'string' ? projectName.trim() : '';
  state.projectName = safeName || null;
  state.sheets = [];
  state.lastError = '';
  state.activeSheetId = null;
  state.defaultRowCount = DEFAULT_ROW_COUNT;
  state.defaultColumnCount = DEFAULT_COLUMN_COUNT;

  if (!safeName) {
    state.loading = false;
    renderTabs();
    dispatchSheetSelected(null, reason || 'project-cleared');
    return;
  }

  if (state.managePending) {
    closeManageModal({ force: true });
  }
  if (state.createPending) {
    closeCreateModal({ force: true });
  }

  state.loading = true;
  state.lastError = '';
  renderTabs();

  const requestToken = Symbol('sheets-request');
  state.currentRequestToken = requestToken;

  try {
    const response = await listSheets(safeName);
    if (state.currentRequestToken !== requestToken) return;
    state.loading = false;
    state.lastError = '';
    applySheetList(response?.sheets ?? [], {
      reason: reason || 'project-load',
      storedId: response?.lastActiveSheetId,
    });
  } catch (error) {
    if (state.currentRequestToken !== requestToken) return;
    console.error('[Feature:sheets] Failed to load sheets', error);
    state.loading = false;
    state.sheets = [];
    state.activeSheetId = null;
    const message = error?.message ? `Failed to load sheets: ${error.message}` : 'Failed to load sheets.';
    state.lastError = message;
    renderTabs();
    dispatchSheetSelected(null, 'load-error');
  }
}
function handleTabsClick(event) {
  const target = event.target.closest('[data-sheet-id]');
  if (!target || target.getAttribute('aria-disabled') === 'true') return;
  const sheetId = target.dataset.sheetId;
  const sheet = findSheetById(sheetId);
  if (!sheet) return;
  if (state.activeSheetId === sheet.id) return;
  state.activeSheetId = sheet.id;
  rememberActiveSheet(state.projectName, sheet.id);
  renderTabs();
  dispatchSheetSelected(sheet, 'user-select');
  persistActiveSheetSelection(sheet.id);
}

function handleTabsKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  if (!state.sheets.length) return;
  event.preventDefault();
  const currentIndex = state.sheets.findIndex(sheet => sheet.id === state.activeSheetId);
  let targetIndex = currentIndex;
  if (event.key === 'ArrowLeft') {
    targetIndex = currentIndex <= 0 ? state.sheets.length - 1 : currentIndex - 1;
  } else if (event.key === 'ArrowRight') {
    targetIndex = currentIndex >= state.sheets.length - 1 ? 0 : currentIndex + 1;
  } else if (event.key === 'Home') {
    targetIndex = 0;
  } else if (event.key === 'End') {
    targetIndex = state.sheets.length - 1;
  }
  const sheet = state.sheets[targetIndex] || null;
  if (!sheet || sheet.id === state.activeSheetId) return;
  state.activeSheetId = sheet.id;
  rememberActiveSheet(state.projectName, sheet.id);
  renderTabs();
  dispatchSheetSelected(sheet, 'keyboard');
  persistActiveSheetSelection(sheet.id);
}

function resetCreateModal() {
  state.createPending = false;
  if (elements.createForm?.dataset) {
    delete elements.createForm.dataset.pending;
  }
  if (elements.createForm?.reset) {
    elements.createForm.reset();
  }
  if (elements.createRowCount) {
    elements.createRowCount.disabled = false;
    elements.createRowCount.value = String(state.defaultRowCount);
  }
  if (elements.createColumnCount) {
    elements.createColumnCount.disabled = false;
    elements.createColumnCount.value = String(state.defaultColumnCount);
  }
  setStatus(elements.createStatus, '', 'muted');
}

function openCreateModal() {
  if (!state.projectName || !elements.createModal || state.mode !== 'edit') return;
  if (state.loading) return;
  resetCreateModal();
  if (elements.createName) {
    elements.createName.disabled = false;
    elements.createName.value = computeDefaultSheetName();
  }
  if (elements.createSubmit) {
    elements.createSubmit.disabled = false;
    elements.createSubmit.textContent = 'Create';
  }
  if (elements.createCancel) {
    elements.createCancel.disabled = false;
  }
  setStatus(elements.createStatus, 'Enter a name and grid size for the new sheet.', 'info');
  openModal(elements.createModal, { focusTarget: elements.createName });
  try {
    elements.createName?.focus({ preventScroll: true });
    elements.createName?.select?.();
  } catch {
    elements.createName?.focus();
  }
}

function closeCreateModal({ reset = false, force = false } = {}) {
  if (!elements.createModal) return;
  if (state.createPending && !force) return;
  closeModal(elements.createModal);
  if (reset) {
    resetCreateModal();
  }
}

function setCreatePending(isPending) {
  state.createPending = Boolean(isPending);
  if (elements.createForm?.dataset) {
    elements.createForm.dataset.pending = isPending ? 'true' : 'false';
  }
  if (elements.createSubmit) {
    elements.createSubmit.disabled = isPending;
    elements.createSubmit.textContent = isPending ? 'Creating…' : 'Create';
  }
  if (elements.createCancel) {
    elements.createCancel.disabled = isPending;
  }
  if (elements.createName) {
    elements.createName.disabled = isPending;
  }
  if (elements.createRowCount) {
    elements.createRowCount.disabled = isPending;
  }
  if (elements.createColumnCount) {
    elements.createColumnCount.disabled = isPending;
  }
}

async function handleCreateSubmit(event) {
  event.preventDefault();
  if (!state.projectName || state.createPending) return;
  const name = safeText(elements.createName?.value).trim();
  if (!name) {
    setStatus(elements.createStatus, 'Enter a name to create a sheet.', 'error');
    elements.createName?.focus();
    return;
  }

  const rowText = String(elements.createRowCount?.value ?? '').trim();
  const rowCountValue = Number.parseInt(rowText, 10);
  if (!rowText || !/^[0-9]+$/.test(rowText) || !Number.isInteger(rowCountValue) || rowCountValue <= 0) {
    setStatus(elements.createStatus, 'Row count must be a positive integer.', 'error');
    elements.createRowCount?.focus();
    return;
  }

  const columnText = String(elements.createColumnCount?.value ?? '').trim();
  const columnCountValue = Number.parseInt(columnText, 10);
  if (!columnText || !/^[0-9]+$/.test(columnText) || !Number.isInteger(columnCountValue) || columnCountValue <= 0) {
    setStatus(elements.createStatus, 'Column count must be a positive integer.', 'error');
    elements.createColumnCount?.focus();
    return;
  }

  const existingIds = new Set(state.sheets.map(sheet => sheet.id));
  setCreatePending(true);
  setStatus(elements.createStatus, `Creating "${name}"…`, 'info');

  try {
    const payload = { name, rowCount: rowCountValue, columnCount: columnCountValue };
    const response = await createSheet(state.projectName, payload);
    const sheets = response?.sheets ?? [];
    const result = applySheetList(sheets, {
      preferredName: name,
      reason: 'create',
      storedId: response?.lastActiveSheetId,
    });
    const createdSheet = (result && result.name === name) ? result : state.sheets.find(sheet => !existingIds.has(sheet.id)) || result;
    closeCreateModal({ reset: true, force: true });
    persistActiveSheetSelection(state.activeSheetId);
    if (createdSheet) {
      state.defaultRowCount = rowCountValue;
      state.defaultColumnCount = columnCountValue;
      dispatchSheetEvent('created', { sheet: { ...createdSheet } });
    }
  } catch (error) {
    console.error('[Feature:sheets] Failed to create sheet', error);
    const message = error?.message ? `Create failed: ${error.message}` : 'Failed to create sheet.';
    setStatus(elements.createStatus, message, 'error');
  } finally {
    setCreatePending(false);
  }
}

function resetManageModal() {
  state.managePending = false;
  if (elements.manageForm?.dataset) {
    delete elements.manageForm.dataset.pending;
  }
  if (elements.manageForm?.reset) {
    elements.manageForm.reset();
  }
  setStatus(elements.manageStatus, '', 'muted');
}

function openManageModal() {
  if (!state.projectName || state.mode !== 'edit') return;
  const sheet = findSheetById(state.activeSheetId);
  if (!sheet || !elements.manageModal) return;
  resetManageModal();
  if (elements.manageName) {
    elements.manageName.disabled = false;
    elements.manageName.value = sheet.name;
  }
  if (elements.manageSubmit) {
    elements.manageSubmit.disabled = false;
    elements.manageSubmit.textContent = 'Save changes';
  }
  if (elements.manageCancel) {
    elements.manageCancel.disabled = false;
  }
  if (elements.deleteBtn) {
    elements.deleteBtn.disabled = false;
  }
  setStatus(elements.manageStatus, 'Update the name or delete the sheet.', 'info');
  openModal(elements.manageModal, { focusTarget: elements.manageName });
  try {
    elements.manageName?.focus({ preventScroll: true });
    elements.manageName?.select?.();
  } catch {
    elements.manageName?.focus();
  }
}

function closeManageModal({ reset = false, force = false } = {}) {
  if (!elements.manageModal) return;
  if (state.managePending && !force) return;
  closeModal(elements.manageModal);
  if (reset) {
    resetManageModal();
  }
}

function setManagePending(isPending) {
  state.managePending = Boolean(isPending);
  if (elements.manageForm?.dataset) {
    elements.manageForm.dataset.pending = isPending ? 'true' : 'false';
  }
  if (elements.manageSubmit) {
    elements.manageSubmit.disabled = isPending;
    elements.manageSubmit.textContent = isPending ? 'Saving…' : 'Save changes';
  }
  if (elements.manageCancel) {
    elements.manageCancel.disabled = isPending;
  }
  if (elements.manageName) {
    elements.manageName.disabled = isPending;
  }
  if (elements.deleteBtn) {
    elements.deleteBtn.disabled = isPending;
  }
}

async function handleManageSubmit(event) {
  event.preventDefault();
  if (!state.projectName || state.managePending) return;
  const sheet = findSheetById(state.activeSheetId);
  if (!sheet) return;
  const nextName = safeText(elements.manageName?.value).trim();
  if (!nextName) {
    setStatus(elements.manageStatus, 'Sheet name cannot be empty.', 'error');
    elements.manageName?.focus();
    return;
  }
  if (nextName === sheet.name) {
    setStatus(elements.manageStatus, 'Enter a different name to update the sheet.', 'info');
    elements.manageName?.focus();
    elements.manageName?.select?.();
    return;
  }

  setManagePending(true);
  setStatus(elements.manageStatus, `Renaming "${sheet.name}"…`, 'info');

  try {
    const response = await updateSheet(state.projectName, sheet.id, { name: nextName });
    applySheetList(response?.sheets ?? [], {
      preferredId: sheet.id,
      reason: 'rename',
      storedId: response?.lastActiveSheetId,
    });
    closeManageModal({ reset: true, force: true });
    persistActiveSheetSelection(state.activeSheetId);
    dispatchSheetEvent('renamed', { sheetId: sheet.id, previousName: sheet.name, nextName });
  } catch (error) {
    console.error('[Feature:sheets] Failed to rename sheet', error);
    const message = error?.message ? `Rename failed: ${error.message}` : 'Failed to rename sheet.';
    setStatus(elements.manageStatus, message, 'error');
  } finally {
    setManagePending(false);
  }
}

async function handleDeleteClick() {
  if (!state.projectName || state.managePending) return;
  const sheet = findSheetById(state.activeSheetId);
  if (!sheet) return;
  const confirmed = await showConfirmationDialog({
    title: 'Delete sheet',
    message: `Are you sure you want to delete "${sheet.name}"?`,
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;

  setManagePending(true);
  setStatus(elements.manageStatus, `Deleting "${sheet.name}"…`, 'info');

  try {
    const response = await deleteSheet(state.projectName, sheet.id);
    applySheetList(response?.sheets ?? [], {
      reason: 'delete',
      storedId: response?.lastActiveSheetId,
    });
    closeManageModal({ reset: true, force: true });
    persistActiveSheetSelection(state.activeSheetId);
    dispatchSheetEvent('deleted', { sheetId: sheet.id, sheetName: sheet.name });
  } catch (error) {
    console.error('[Feature:sheets] Failed to delete sheet', error);
    const message = error?.message ? `Delete failed: ${error.message}` : 'Failed to delete sheet.';
    setStatus(elements.manageStatus, message, 'error');
  } finally {
    setManagePending(false);
  }
}

function handleProjectSelected(event) {
  const detail = event.detail || {};
  const project = detail.project || {};
  const projectName = safeText(project.name || detail.projectName).trim();
  loadSheets(projectName, { reason: detail.reason || 'project-change' });
}

function handleProjectDeleted(event) {
  const detail = event.detail || {};
  const deletedName = safeText(detail.projectName).trim();
  if (!deletedName) return;
  if (state.projectName && state.projectName === deletedName) {
    loadSheets('', { reason: 'project-deleted' });
  }
}

function handleSheetCardsUpdated(event) {
  const detail = event.detail || {};
  const sheetId = safeText(detail.sheetId).trim();
  if (!sheetId) return;

  const projectName = safeText(detail.projectName).trim();
  if (state.projectName && projectName && projectName !== state.projectName) {
    return;
  }

  const index = state.sheets.findIndex(sheet => sheet.id === sheetId);
  if (index < 0) return;

  const current = state.sheets[index];
  const cards = normalizeCardList(detail.cards, current.rowCount, current.columnCount);
  const activeCardId = safeText(detail.activeCardId).trim();
  const lastActiveCardId = cards.some(card => card.id === activeCardId)
    ? activeCardId
    : null;
  const nextSheet = { ...current, cards, lastActiveCardId };
  state.sheets[index] = nextSheet;

  if (sheetId === state.activeSheetId) {
    const reason = detail.reason || 'cards-update';
    dispatchSheetSelected(nextSheet, reason);
  }
}

function handleSnapshot(snapshot) {
  const mode = snapshot?.ui?.interactionMode || 'explore';
  if (mode !== state.mode) {
    state.mode = mode;
    if (mode !== 'edit') {
      closeCreateModal({ force: true });
      closeManageModal({ force: true });
    }
    updateActionsState();
  }
}

function attachEventListeners() {
  elements.tabs?.addEventListener('click', handleTabsClick);
  elements.tabs?.addEventListener('keydown', handleTabsKeydown);
  elements.createBtn?.addEventListener('click', openCreateModal);
  elements.manageBtn?.addEventListener('click', openManageModal);
  elements.createCancel?.addEventListener('click', () => closeCreateModal({ reset: true }));
  elements.createClose?.addEventListener('click', () => closeCreateModal({ reset: true }));
  elements.createForm?.addEventListener('submit', handleCreateSubmit);
  elements.manageCancel?.addEventListener('click', () => closeManageModal({ reset: true }));
  elements.manageClose?.addEventListener('click', () => closeManageModal({ reset: true }));
  elements.manageForm?.addEventListener('submit', handleManageSubmit);
  elements.deleteBtn?.addEventListener('click', handleDeleteClick);
  document.addEventListener('project:selected', handleProjectSelected);
  document.addEventListener('project:deleted', handleProjectDeleted);
  document.addEventListener('sheet:cards-updated', handleSheetCardsUpdated);
}

export function init() {
  if (state.initialized) return;
  cacheElements();
  if (!elements.tabs) {
    console.warn(`[Feature:${FEATURE_NAME}] Sheet tabs container not found.`);
    return;
  }
  state.initialized = true;
  hydrateActiveSheetCache();
  attachEventListeners();
  state.unsubscribe = subscribe(handleSnapshot);
  handleSnapshot(getSnapshot());
  renderTabs();
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };
