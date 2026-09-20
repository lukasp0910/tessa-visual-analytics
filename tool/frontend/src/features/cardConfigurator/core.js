import { fetchChartTypes } from '../../api/chartTypes.js';
import { requestJson } from '../../api/client.js';
import { listArrays } from '../../api/projects.js';
import { getSnapshot } from '../../state/store.js';
import { byId, clearChildren, setStatusMessage } from '../../ui/dom.js';
import { closeModal, openModal } from '../../ui/modal.js';
import { registerLineChart } from './charts/lineChart.js';
import { registerScatterChart } from './charts/scatterChart.js';
import { fetchSubjectGroups } from '../../api/subjects.js';

const FEATURE_NAME = 'cardConfigurator';

const DEFAULT_STATUS = 'Select a chart type and data source to configure this card.';

let nextMeasureId = 1;


function generateMeasureId() {
  return `measure-${nextMeasureId++}`;
}

const state = {
  initialized: false,
  chartTypes: [],
  chartTypeMap: new Map(),
  chartTypesPromise: null,
  dataSourceCache: new Map(), // projectName -> array of sources
  columnCache: new Map(), // `${project}::${sourceId}` -> ColumnEntry[]
  context: null,
  currentConfig: null,
  formValues: {},
  loadingColumnsFor: null,
  projectMetadata: {
    arrays: [],
  },
  lineChart: {
    measures: [],
  },
  scatterChart: {
    values: {
      columns: [],
      dimension: 2,
      reduction: '',
      subject: 'all',
    },
    lastDataSourceId: '',
    availableColumns: [],
    multiSubject: false,
    subjectOptions: [],
    renderToken: 0,
  },
  controlsDisabled: false,
  activeModuleId: '',
  activeModule: null,
};

const chartModules = new Map();

const elements = {
  modal: null,
  modalBackdrop: null,
  modalClose: null,
  form: null,
  status: null,
  titleGroup: null,
  titleInput: null,
  chartTypeSelect: null,
  dataSourceGroup: null,
  dataSourceSelect: null,
  fieldContainer: null,
  standardSection: null,
  lineSection: null,
  lineDimensionSelect: null,
  lineInfo: null,
  measureList: null,
  addMeasureBtn: null,
  cancelBtn: null,
  saveBtn: null,
};

function normalizeChartTypeId(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function resolveChartModuleId(chartType) {
  if (!chartType) {
    return '';
  }
  if (typeof chartType === 'string') {
    return normalizeChartTypeId(chartType);
  }
  if (typeof chartType.name === 'string') {
    return normalizeChartTypeId(chartType.name);
  }
  return '';
}

function getChartModule(chartType) {
  const identifier = resolveChartModuleId(chartType);
  if (!identifier) {
    return null;
  }
  return chartModules.get(identifier) || null;
}

function buildModuleContext(additional = {}) {
  return {
    state,
    elements,
    setModalStatus,
    clearChildren,
    cloneColumnEntries,
    getColumnsCacheKey,
    loadColumns,
    fetchSubjectGroups,
    describeDataSource,
    generateMeasureId,
    getDataSourceEntry,
    getSelectedChartType,
    getSelectedChartTypeName,
    getSelectedDataSourceId,
    captureFieldValues,
    renderDefaultFields: renderFieldControls,
    ...additional,
  };
}

function detachActiveModule(reason = 'change') {
  if (!state.activeModule) {
    return;
  }
  try {
    if (typeof state.activeModule.detach === 'function') {
      state.activeModule.detach(buildModuleContext({ reason }));
    }
  } catch (error) {
    console.warn(`[Feature:${FEATURE_NAME}] Failed to detach chart module`, error);
  }
  state.activeModule = null;
  state.activeModuleId = '';
}

function activateChartModule(chartType, options = {}) {
  const module = getChartModule(chartType);
  const identifier = module ? resolveChartModuleId(module.id || chartType) : '';
  if (state.activeModule && state.activeModule === module) {
    return module;
  }

  if (state.activeModule) {
    detachActiveModule('switch');
  }

  if (!module) {
    return null;
  }

  try {
    if (typeof module.attach === 'function') {
      module.attach(buildModuleContext({ chartType, ...options }));
    }
    state.activeModule = module;
    state.activeModuleId = identifier;
  } catch (error) {
    state.activeModule = null;
    state.activeModuleId = '';
    console.error(`[Feature:${FEATURE_NAME}] Failed to attach chart module`, error);
  }

  return state.activeModule;
}

function logDebug(message, ...args) {
  console.debug(`[Feature:${FEATURE_NAME}] ${message}`, ...args);
}

function clonePlainValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => clonePlainValue(item));
  }
  if (typeof value === 'object') {
    const result = {};
    Object.entries(value).forEach(([key, raw]) => {
      result[key] = clonePlainValue(raw);
    });
    return result;
  }
  return value;
}

function cloneConfigurationInput(configuration) {
  if (!configuration || typeof configuration !== 'object') {
    return null;
  }
  const cloned = { ...configuration };
  if (configuration.fieldValues && typeof configuration.fieldValues === 'object') {
    cloned.fieldValues = clonePlainValue(configuration.fieldValues) || {};
  } else if ('fieldValues' in cloned) {
    cloned.fieldValues = {};
  }
  return cloned;
}

function clearProjectCaches(projectName) {
  const name = typeof projectName === 'string' ? projectName.trim() : '';
  if (!name) {
    state.dataSourceCache.clear();
    state.columnCache.clear();
    return;
  }
  state.dataSourceCache.delete(name);
  const prefix = `${name}::`;
  Array.from(state.columnCache.keys()).forEach(key => {
    if (key.startsWith(prefix)) {
      state.columnCache.delete(key);
    }
  });
}

function cacheElements() {
  elements.modal = byId('cardChartModal');
  elements.modalBackdrop = document.querySelector('[data-modal="card-chart-backdrop"]');
  elements.modalClose = byId('cardChartModalClose');
  elements.form = byId('cardChartForm');
  elements.status = byId('cardChartStatus');
  elements.chartTypeSelect = byId('cardChartType');
  elements.dataSourceGroup = byId('cardChartDataSourceGroup');
  elements.dataSourceSelect = byId('cardChartDataSource');
  elements.fieldContainer = byId('cardChartFieldContainer');
  elements.standardSection = byId('cardChartStandardSection');
  elements.lineSection = byId('cardChartLineSection');
  elements.lineDimensionSelect = byId('cardChartLineDimension');
  elements.lineInfo = byId('cardChartLineInfo');
  elements.measureList = byId('cardChartMeasureList');
  elements.addMeasureBtn = byId('cardChartAddMeasure');
  elements.cancelBtn = byId('cardChartCancelBtn');
  elements.saveBtn = byId('cardChartSaveBtn');

  // Ensure Title field at top of the form
  if (elements.form && !elements.titleGroup) {
    createTitleControl();
  }
}

function createTitleControl() {
  if (!elements.form) return;
  // Avoid duplicate control
  const existing = document.getElementById('cardChartTitleGroup');
  if (existing) {
    elements.titleGroup = existing;
    elements.titleInput = existing.querySelector('#cardChartTitleInput');
    return;
  }
  const group = document.createElement('div');
  group.id = 'cardChartTitleGroup';
  group.className = 'space-y-2';

  const label = document.createElement('label');
  label.className = 'block text-sm font-medium text-gray-800';
  label.setAttribute('for', 'cardChartTitleInput');
  label.textContent = 'Title';

  const input = document.createElement('input');
  input.id = 'cardChartTitleInput';
  input.name = 'title';
  input.type = 'text';
  input.className = 'mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500';
  input.placeholder = 'Title';
  input.addEventListener('input', () => { try { input.setCustomValidity(''); } catch (_) {} });
  // Auto-fill default title when the field is left empty
  input.addEventListener('blur', () => {
    const current = String(input.value || '').trim();
    if (!current) {
      setDefaultTitleIfEmptyForSelection();
    }
  });

  group.append(label);
  group.append(input);

  try {
    elements.form.insertBefore(group, elements.form.firstChild);
  } catch (_) {
    elements.form.appendChild(group);
  }

  elements.titleGroup = group;
  elements.titleInput = input;
}

function setModalStatus(message, tone = 'muted') {
  if (!elements.status) return;
  const normalizedTone = tone === 'error' ? 'error' : tone;
  const isError = tone === 'error';
  setStatusMessage(elements.status, message, { tone: normalizedTone, isError });
}

function resetFormState() {
  if (elements.form) {
    elements.form.reset();
  }
  if (elements.fieldContainer) {
    clearChildren(elements.fieldContainer);
  }
  if (elements.chartTypeSelect) {
    elements.chartTypeSelect.innerHTML = '';
  }
  if (elements.dataSourceSelect) {
    elements.dataSourceSelect.innerHTML = '';
  }
  if (elements.dataSourceGroup) {
    elements.dataSourceGroup.classList.remove('hidden');
  }
  if (elements.standardSection) {
    elements.standardSection.classList.remove('hidden');
  }
  if (elements.lineSection) {
    elements.lineSection.classList.add('hidden');
  }
  state.controlsDisabled = false;
  detachActiveModule('reset');
  chartModules.forEach(module => {
    if (module && typeof module.reset === 'function') {
      try {
        module.reset(buildModuleContext({ reason: 'reset' }));
      } catch (error) {
        console.warn(`[Feature:${FEATURE_NAME}] Failed to reset chart module`, error);
      }
    }
  });
  state.formValues = {};
  state.loadingColumnsFor = null;
  state.projectMetadata = { arrays: [] };
  state.lineChart = { measures: [] };
  state.scatterChart = {
    values: {
      columns: [],
      dimension: 2,
      reduction: '',
      subject: 'all',
    },
    lastDataSourceId: '',
    availableColumns: [],
    multiSubject: false,
    subjectOptions: [],
    renderToken: 0,
  };
  if (elements.titleInput) { elements.titleInput.value = ''; }
  setModalStatus(DEFAULT_STATUS, 'muted');
}

function setControlsDisabled(disabled) {
  if (elements.chartTypeSelect) {
    elements.chartTypeSelect.disabled = disabled;
  }
  if (elements.dataSourceSelect) {
    elements.dataSourceSelect.disabled = disabled;
  }
  if (elements.saveBtn) {
    elements.saveBtn.disabled = disabled;
  }
  if (elements.addMeasureBtn) {
    elements.addMeasureBtn.disabled = disabled;
  }
  state.controlsDisabled = disabled;
  const module = state.activeModule;
  if (module && typeof module.onControlsDisabledChange === 'function') {
    module.onControlsDisabledChange(buildModuleContext({ disabled }));
  }
}

function resolveProjectMetadata(projectName) {
  if (!projectName) {
    return { arrays: [], subjectMode: 'single', subjectArrays: [], subjectNames: {} };
  }
  const snapshot = getSnapshot();
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  const project = projects.find(entry => entry?.name === projectName) || null;

  // Local normalizers (avoid importing feature modules)
  function normalizeSubjectModeLocal(value) {
    if (typeof value === 'string') {
      const cleaned = value.trim().toLowerCase();
      if (cleaned === 'multi' || cleaned === 'single') return cleaned;
      const collapsed = cleaned.replace(/[_\s-]+/g, ' ');
      if (collapsed === 'multi subject' || collapsed === 'multiple subjects') return 'multi';
    }
    return 'single';
  }
  function normalizeSubjectArraysLocal(value) {
    if (!Array.isArray(value)) return [];
    return value.map(v => (v == null ? '' : String(v))).map(s => s.trim()).filter(Boolean);
  }
  function normalizeSubjectNamesLocal(value) {
    const result = {};
    if (!value || typeof value !== 'object') return result;
    Object.entries(value).forEach(([k, v]) => {
      const key = String(k ?? '').trim();
      const label = String(v ?? '').trim();
      if (key && label) result[key] = label;
    });
    return result;
  }

  const arrays = Array.isArray(project?.arrays) ? project.arrays : [];
  const rawMode = project?.subject_mode ?? project?.subjectMode;
  const subjectMode = normalizeSubjectModeLocal(rawMode);
  const rawArrays = project?.subject_arrays ?? project?.subjectArrays;
  const rawNames = project?.subject_names ?? project?.subjectNames;

  return {
    arrays,
    subjectMode,
    subjectArrays: normalizeSubjectArraysLocal(rawArrays),
    subjectNames: normalizeSubjectNamesLocal(rawNames),
  };
}

async function ensureChartTypes() {
  if (state.chartTypes.length) {
    return state.chartTypes;
  }
  if (state.chartTypesPromise) {
    return state.chartTypesPromise;
  }
  state.chartTypesPromise = fetchChartTypes()
    .then(registry => {
      const types = Array.isArray(registry?.types) ? registry.types : [];
      state.chartTypes = types;
      state.chartTypeMap = new Map(types.map(entry => [entry.name, entry]));
      state.chartTypesPromise = null;
      return state.chartTypes;
    })
    .catch(error => {
      state.chartTypesPromise = null;
      throw error;
    });
  return state.chartTypesPromise;
}

function describeDataSource(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const label = typeof entry.label === 'string' ? entry.label.trim() : '';
  const shape = Array.isArray(entry.shape) ? entry.shape.filter(Number.isFinite) : [];
  const shapeLabel = shape.length ? `(${shape.join('×')})` : '';
  const suffix = entry.enabled === false ? ' (hidden)' : '';
  return [label || name || entry.id || 'Array', shapeLabel, suffix].filter(Boolean).join(' ');
}

async function loadDataSources(projectName) {
  if (!projectName) {
    state.dataSourceCache.set('', []);
    return [];
  }
  if (state.dataSourceCache.has(projectName)) {
    return state.dataSourceCache.get(projectName) || [];
  }
  try {
    const response = await listArrays(projectName);
    const arrays = Array.isArray(response) ? response : [];
    const normalized = arrays
      .map(entry => {
        if (!entry || typeof entry !== 'object') return null;
        const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
        const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
        if (!id && !name) return null;
        return {
          ...entry,
          id: id || name,
          name: name || id,
        };
      })
      .filter(Boolean);
    state.dataSourceCache.set(projectName, normalized);
    return normalized;
  } catch (error) {
    console.error(`[Feature:${FEATURE_NAME}] Failed to load data sources`, error);
    state.dataSourceCache.set(projectName, []);
    throw error;
  }
}

function getColumnsCacheKey(projectName, dataSourceId) {
  return `${projectName || ''}::${dataSourceId || ''}`;
}

function findArrayMetadata(projectName, dataSourceId) {
  if (!dataSourceId) {
    return null;
  }

  const arrays = Array.isArray(state.projectMetadata?.arrays)
    ? state.projectMetadata.arrays
    : [];
  const normalizedId = String(dataSourceId);

  let entry = arrays.find(candidate => candidate?.id === normalizedId);
  if (!entry) {
    entry = arrays.find(candidate => candidate?.name === normalizedId);
  }

  if (entry) {
    return entry;
  }

  const cachedSources = state.dataSourceCache.get(projectName || '') || [];
  entry = cachedSources.find(candidate => candidate?.id === normalizedId)
    || cachedSources.find(candidate => candidate?.name === normalizedId);
  return entry || null;
}

function parseColumnNameOverrides(rawOverrides) {
  if (!rawOverrides) {
    return [];
  }

  const entries = [];

  if (Array.isArray(rawOverrides)) {
    rawOverrides.forEach((value, index) => {
      const label = String(value ?? '').trim();
      if (!label) return;
      entries.push({ index: index + 1, label });
    });
  } else if (typeof rawOverrides === 'object') {
    Object.entries(rawOverrides).forEach(([key, value]) => {
      const index = Number.parseInt(key, 10);
      if (!Number.isInteger(index) || index < 1) return;
      const label = String(value ?? '').trim();
      if (!label) return;
      entries.push({ index, label });
    });
  } else if (typeof rawOverrides === 'string') {
    rawOverrides.split(',').forEach((value, index) => {
      const label = value.trim();
      if (!label) return;
      entries.push({ index: index + 1, label });
    });
  }

  if (!entries.length) {
    return entries;
  }

  entries.sort((a, b) => a.index - b.index);
  const deduped = [];
  const seen = new Set();
  entries.forEach(entry => {
    if (seen.has(entry.index)) return;
    seen.add(entry.index);
    deduped.push(entry);
  });
  return deduped;
}

function createColumnEntryFromIndex(index, label) {
  const numericIndex = Number.parseInt(index, 10);
  const safeIndex = Number.isInteger(numericIndex) && numericIndex >= 1 ? numericIndex : 1;
  const normalizedLabel = typeof label === 'string' && label.trim()
    ? label.trim()
    : `Column ${safeIndex}`;
  return {
    id: String(safeIndex),
    index: safeIndex,
    label: normalizedLabel,
  };
}

function cloneColumnEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  const result = [];
  entries.forEach((entry, position) => {
    if (!entry) {
      return;
    }
    if (typeof entry === 'string') {
      result.push(createColumnEntryFromIndex(position + 1, entry));
      return;
    }
    if (typeof entry !== 'object') {
      return;
    }
    const rawId = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : '';
    const rawLabel = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : '';
    const indexCandidates = [];
    if (Number.isInteger(entry.index) && entry.index >= 1) {
      indexCandidates.push(entry.index);
    }
    const numericId = Number.parseInt(rawId, 10);
    if (Number.isInteger(numericId) && numericId >= 1) {
      indexCandidates.push(numericId);
    }
    indexCandidates.push(position + 1);
    const resolvedIndex = indexCandidates.find(value => Number.isInteger(value) && value >= 1) || position + 1;
    const identifier = rawId || String(resolvedIndex);
    const label = rawLabel || `Column ${resolvedIndex}`;
    result.push({ id: identifier, index: resolvedIndex, label });
  });
  return result;
}

function inferColumnCountFromMetadata(metadataEntry, overrides) {
  if (!metadataEntry || typeof metadataEntry !== 'object') {
    return null;
  }

  const explicitText = metadataEntry.column_count ?? metadataEntry.columnCount;
  const explicit = Number.parseInt(explicitText, 10);
  if (Number.isInteger(explicit) && explicit >= 0) {
    return explicit;
  }

  const shape = Array.isArray(metadataEntry.shape) ? metadataEntry.shape : [];
  if (!shape.length) {
    return overrides && overrides.length
      ? Math.max(...overrides.map(entry => entry.index))
      : 1;
  }

  const normalized = shape.map(value => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, parsed);
  }).filter(value => value !== null);

  if (!normalized.length) {
    return overrides && overrides.length
      ? Math.max(...overrides.map(entry => entry.index))
      : 1;
  }

  if (normalized.length === 1) {
    return Math.max(1, normalized[0]);
  }

  let product = 1;
  for (let index = 1; index < normalized.length; index += 1) {
    product *= normalized[index];
  }

  if (!Number.isFinite(product) || product <= 0) {
    return overrides && overrides.length
      ? Math.max(...overrides.map(entry => entry.index))
      : 0;
  }

  return product;
}

function resolveColumnsFromMetadata(projectName, dataSourceId) {
  const metadataEntry = findArrayMetadata(projectName, dataSourceId);
  if (!metadataEntry) {
    return [];
  }

  const overrides = parseColumnNameOverrides(metadataEntry.column_names ?? metadataEntry.columnNames);
  let columnCount = inferColumnCountFromMetadata(metadataEntry, overrides);
  if (!Number.isFinite(columnCount) || columnCount < 0) {
    columnCount = overrides.length ? Math.max(...overrides.map(entry => entry.index)) : 0;
  }
  if (overrides.length) {
    const maxOverride = Math.max(...overrides.map(entry => entry.index));
    if (!Number.isFinite(columnCount) || columnCount < maxOverride) {
      columnCount = maxOverride;
    }
  }

  const finalCount = Number.isFinite(columnCount) && columnCount > 0 ? columnCount : 0;
  if (!finalCount) {
    if (!overrides.length) {
      return [];
    }
    const maxIndex = Math.max(...overrides.map(entry => entry.index));
    return Array.from({ length: maxIndex }, (_, position) => {
      const override = overrides.find(entry => entry.index === position + 1);
      return createColumnEntryFromIndex(position + 1, override ? override.label : `Column ${position + 1}`);
    });
  }

  const columns = Array.from({ length: finalCount }, (_, index) => createColumnEntryFromIndex(index + 1, `Column ${index + 1}`));
  overrides.forEach(({ index, label }) => {
    if (!Number.isInteger(index) || index < 1 || index > columns.length) return;
    columns[index - 1] = createColumnEntryFromIndex(index, label);
  });
  return columns;
}

async function loadColumns(projectName, dataSourceId) {
  if (!projectName || !dataSourceId) {
    return [];
  }
  const cacheKey = getColumnsCacheKey(projectName, dataSourceId);
  if (state.columnCache.has(cacheKey)) {
    return state.columnCache.get(cacheKey) || [];
  }
  const metadataColumns = resolveColumnsFromMetadata(projectName, dataSourceId);
  if (metadataColumns.length) {
    state.columnCache.set(cacheKey, metadataColumns);
    return metadataColumns;
  }
  const params = new URLSearchParams({ limit: '0' });
  const url = `/api/v1/projects/${encodeURIComponent(projectName)}/arrays/${encodeURIComponent(dataSourceId)}?${params.toString()}`;
  try {
    state.loadingColumnsFor = dataSourceId;
    const payload = await requestJson(url, { method: 'GET' });
    const columns = Array.isArray(payload?.columns)
      ? payload.columns.map((column, index) => createColumnEntryFromIndex(index + 1, String(column ?? '')))
      : [];
    state.columnCache.set(cacheKey, columns);
    return columns;
  } catch (error) {
    console.error(`[Feature:${FEATURE_NAME}] Failed to load column metadata`, error);
    throw error;
  } finally {
    state.loadingColumnsFor = null;
  }
}

function populateChartTypeOptions(selectedName = '') {
  if (!elements.chartTypeSelect) return;
  clearChildren(elements.chartTypeSelect);

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = state.chartTypes.length
    ? 'Select a chart type'
    : 'No chart types available';
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.dataset.disabled = 'true';
  elements.chartTypeSelect.append(placeholder);

  state.chartTypes.forEach(entry => {
    // Filter out bar chart
    if (entry.name === 'bar') return;
    
    const option = document.createElement('option');
    option.value = entry.name;
    option.textContent = entry.label || entry.name;
    option.selected = entry.name === selectedName;
    elements.chartTypeSelect.append(option);
  });

  if (selectedName && state.chartTypeMap.has(selectedName)) {
    elements.chartTypeSelect.value = selectedName;
    placeholder.selected = false;
  }
}

function populateDataSourceOptions(projectName, selectedId = '') {
  if (!elements.dataSourceSelect) return;
  clearChildren(elements.dataSourceSelect);

  const sources = state.dataSourceCache.get(projectName || '') || [];
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = sources.length
    ? 'Select a data source'
    : projectName
      ? 'No data sources available'
      : 'Select a project to load data sources';
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.dataset.disabled = 'true';
  elements.dataSourceSelect.append(placeholder);

  sources.forEach(entry => {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = describeDataSource(entry);
    option.selected = entry.id === selectedId;
    elements.dataSourceSelect.append(option);
  });

  if (selectedId && sources.some(entry => entry.id === selectedId)) {
    elements.dataSourceSelect.value = selectedId;
    placeholder.selected = false;
  }
}

function captureFieldValues() {
  if (!elements.fieldContainer) return {};
  const values = {};
  const inputs = elements.fieldContainer.querySelectorAll('[data-field-input]');
  inputs.forEach(input => {
    const name = input.dataset.fieldInput;
    if (!name) return;
    if (input instanceof HTMLSelectElement && input.multiple) {
      values[name] = Array.from(input.selectedOptions).map(option => option.value);
    } else if (input instanceof HTMLInputElement && input.type === 'number') {
      const text = input.value.trim();
      if (text === '') {
        values[name] = '';
      } else {
        const parsed = Number(input.value);
        values[name] = Number.isFinite(parsed) ? parsed : input.value;
      }
    } else if (input instanceof HTMLInputElement && input.type === 'checkbox') {
      values[name] = input.checked;
    } else {
      values[name] = input.value;
    }
  });
  return values;
}

function createFieldWrapper(field) {
  const wrapper = document.createElement('div');
  wrapper.className = 'space-y-2';

  const label = document.createElement('label');
  label.className = 'block text-sm font-medium text-gray-800';
  label.setAttribute('for', `cardChartField-${field.name}`);
  label.textContent = field.label || field.name;
  if (field.required) {
    const required = document.createElement('span');
    required.className = 'ml-1 text-red-500';
    required.textContent = '*';
    label.append(required);
  }
  wrapper.append(label);

  return { wrapper, label };
}

function applyFieldDescription(wrapper, field) {
  if (!field.description) return;
  const description = document.createElement('p');
  description.className = 'text-xs text-gray-500';
  description.textContent = field.description;
  wrapper.append(description);
}

function createSelectControl({ field, options, multiple = false, placeholder = 'Select an option', value }) {
  const select = document.createElement('select');
  select.id = `cardChartField-${field.name}`;
  select.name = field.name;
  select.dataset.fieldInput = field.name;
  select.className = 'mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500';
  if (multiple) {
    select.multiple = true;
    select.size = Math.min(6, Math.max(options.length, 3));
  }
  select.required = Boolean(field.required);

  if (!multiple) {
    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = placeholder;
    placeholderOption.disabled = true;
    placeholderOption.selected = true;
    placeholderOption.dataset.disabled = 'true';
    select.append(placeholderOption);
  }

  options.forEach(optionValue => {
    const option = document.createElement('option');
    const label = typeof optionValue === 'object' && optionValue !== null
      ? optionValue.label ?? optionValue.value
      : optionValue;
    const rawValue = typeof optionValue === 'object' && optionValue !== null
      ? optionValue.value ?? optionValue.label
      : optionValue;
    option.value = String(rawValue ?? '');
    option.textContent = String(label ?? rawValue ?? 'Option');
    if (multiple && Array.isArray(value)) {
      option.selected = value.includes(option.value);
    } else if (!multiple) {
      option.selected = value != null && String(value) === option.value;
    }
    select.append(option);
  });

  if (!multiple && value != null && value !== '') {
    select.value = String(value);
  }

  return select;
}

function createTextInput(field, { value = '', type = 'text' } = {}) {
  const input = document.createElement('input');
  input.id = `cardChartField-${field.name}`;
  input.name = field.name;
  input.dataset.fieldInput = field.name;
  input.type = type;
  input.className = 'mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500';
  input.required = Boolean(field.required);
  if (type === 'number' && typeof value === 'number') {
    input.value = String(value);
  } else if (type === 'color') {
    input.value = typeof value === 'string' && value ? value : '#1f77b4';
  } else {
    input.value = value != null ? String(value) : '';
  }
  return input;
}

function createBooleanControl(field, value) {
  const select = document.createElement('select');
  select.id = `cardChartField-${field.name}`;
  select.name = field.name;
  select.dataset.fieldInput = field.name;
  select.className = 'mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500';
  select.required = Boolean(field.required);

  const options = [
    { label: 'Yes', value: 'true' },
    { label: 'No', value: 'false' },
  ];

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select yes or no';
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.dataset.disabled = 'true';
  select.append(placeholder);

  options.forEach(optionDef => {
    const option = document.createElement('option');
    option.value = optionDef.value;
    option.textContent = optionDef.label;
    if (typeof value === 'boolean') {
      option.selected = String(value) === optionDef.value;
    } else if (typeof value === 'string') {
      option.selected = value === optionDef.value;
    }
    select.append(option);
  });

  if (typeof value === 'boolean') {
    select.value = String(value);
  }

  return select;
}

function determineFieldValue(field) {
  if (field.name in state.formValues) {
    return state.formValues[field.name];
  }
  if (state.currentConfig?.fieldValues && field.name in state.currentConfig.fieldValues) {
    return state.currentConfig.fieldValues[field.name];
  }
  if (field.default !== undefined) {
    return field.default;
  }
  return '';
}

function renderFieldControls(chartType, columns = []) {
  if (!elements.fieldContainer) return;
  const preserved = captureFieldValues();
  if (Object.keys(preserved).length) {
    state.formValues = { ...state.formValues, ...preserved };
  }

  clearChildren(elements.fieldContainer);

  if (elements.dataSourceGroup) {
    elements.dataSourceGroup.classList.remove('hidden');
  }
  if (elements.standardSection) {
    elements.standardSection.classList.remove('hidden');
  }
  if (elements.lineSection) {
    elements.lineSection.classList.add('hidden');
  }

  if (!chartType) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-gray-500';
    empty.textContent = 'Select a chart type to configure available fields.';
    elements.fieldContainer.append(empty);
    return;
  }

  if (!Array.isArray(chartType.fields) || chartType.fields.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-gray-500';
    empty.textContent = 'This chart type does not expose configurable fields.';
    elements.fieldContainer.append(empty);
    return;
  }

  chartType.fields.forEach(field => {
    const { wrapper } = createFieldWrapper(field);
    const value = determineFieldValue(field);
    let control = null;

    if (Array.isArray(field.choices) && field.choices.length) {
      control = createSelectControl({
        field,
        options: field.choices,
        multiple: Boolean(field.allowMultiple),
        placeholder: 'Select an option',
        value,
      });
    } else if (field.field_type === 'color') {
      control = createTextInput(field, { value, type: 'color' });
    } else if (field.field_type === 'number') {
      control = createTextInput(field, { value, type: 'number' });
    } else if (field.field_type === 'boolean') {
      control = createBooleanControl(field, value);
    } else if ((field.field_type === 'dimension' || field.field_type === 'metric') && columns.length) {
      const options = columns.map(column => ({ label: column, value: column }));
      control = createSelectControl({
        field,
        options,
        multiple: Boolean(field.allowMultiple),
        placeholder: columns.length ? 'Select a column' : 'No columns available',
        value,
      });
    } else {
      control = createTextInput(field, { value });
    }

    applyFieldDescription(wrapper, field);
    if (control) {
      wrapper.append(control);
    }
    elements.fieldContainer.append(wrapper);
  });
}

function getSelectedChartType() {
  const name = elements.chartTypeSelect?.value || '';
  if (!name) return null;
  return state.chartTypeMap.get(name) || null;
}

function getSelectedChartTypeName() {
  return elements.chartTypeSelect?.value || '';
}

function getDefaultTitleForChartType(name) {
  const idRaw = typeof name === 'string' ? name : resolveChartModuleId(name);
  const id = String(idRaw || '').trim();
  if (!id) return '';
  // Prefer registry label if available
  const entry = state.chartTypes.find(t => String(t?.name || '').trim().toLowerCase() === id.toLowerCase()) || null;
  const label = entry?.label || entry?.name || '';
  if (label) return label;
  // Fallback: humanize the identifier
  const human = id
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return human ? human[0].toUpperCase() + human.slice(1) : '';
}

function setDefaultTitleIfEmptyForSelection() {
  if (!elements.titleInput) return;
  const current = String(elements.titleInput.value || '').trim();
  if (current) return;
  const typeName = getSelectedChartTypeName();
  const def = getDefaultTitleForChartType(typeName);
  if (def) {
    elements.titleInput.value = def;
    // ensure any prior custom error is cleared
    try { elements.titleInput.setCustomValidity(''); } catch (_) {}
  }
}

function getSelectedDataSourceId() {
  return elements.dataSourceSelect?.value || '';
}

function getDataSourceEntry(projectName, dataSourceId) {
  const sources = state.dataSourceCache.get(projectName || '') || [];
  return sources.find(entry => entry.id === dataSourceId) || null;
}

async function refreshFieldControls({ preserveValues = true } = {}) {
  const chartType = getSelectedChartType();
  if (!chartType) {
    detachActiveModule('switch');
    renderFieldControls(null);
    return;
  }
  const module = activateChartModule(chartType, { preserveValues });
  const projectName = state.context?.projectName || '';
  const dataSourceId = getSelectedDataSourceId();

  if (module && typeof module.populateFields === 'function') {
    const handled = await module.populateFields(
      buildModuleContext({ chartType, preserveValues, projectName, dataSourceId }),
    );
    if (handled) {
      return;
    }
  }
  let columns = [];
  if (dataSourceId) {
    try {
      if (preserveValues) {
        const preserved = captureFieldValues();
        if (Object.keys(preserved).length) {
          state.formValues = { ...state.formValues, ...preserved };
        }
      }
      const entries = await loadColumns(projectName, dataSourceId);
      columns = entries.map(column => column.label);
    } catch (error) {
      setModalStatus('Failed to load column information for this data source.', 'error');
    }
  }
  renderFieldControls(chartType, columns);
  // Prefill title when empty based on selected chart type
  setDefaultTitleIfEmptyForSelection();
}

function applyInitialSelections(projectName) {
  const initialChartType = state.currentConfig?.chartType || '';
  populateChartTypeOptions(initialChartType);

  const initialDataSource = state.currentConfig?.dataSourceId || '';
  populateDataSourceOptions(projectName, initialDataSource);

  if (initialChartType && state.chartTypeMap.has(initialChartType)) {
    elements.chartTypeSelect.value = initialChartType;
  }
  if (initialDataSource) {
    elements.dataSourceSelect.value = initialDataSource;
  }
}

function handleCloseRequest() {
  closeCardConfigurator();
}

function attachListeners() {
  elements.modalClose?.addEventListener('click', handleCloseRequest);
  elements.modalBackdrop?.addEventListener('click', handleCloseRequest);
  elements.cancelBtn?.addEventListener('click', event => {
    event.preventDefault();
    handleCloseRequest();
  });

  elements.chartTypeSelect?.addEventListener('change', () => {
    state.formValues = captureFieldValues();
    setDefaultTitleIfEmptyForSelection();
    refreshFieldControls({ preserveValues: true });
  });

  elements.dataSourceSelect?.addEventListener('change', async () => {
    state.formValues = captureFieldValues();
    const projectName = state.context?.projectName || '';
    const dataSourceId = getSelectedDataSourceId();
    const module = state.activeModule;
    if (module && typeof module.handleDataSourceChange === 'function') {
      const handled = await module.handleDataSourceChange(
        buildModuleContext({ projectName, dataSourceId }),
      );
      if (handled) {
        return;
      }
    }
    if (!projectName || !dataSourceId) {
      refreshFieldControls({ preserveValues: true });
      return;
    }
    setModalStatus('Loading column metadata…', 'info');
    try {
      await loadColumns(projectName, dataSourceId);
      setModalStatus(DEFAULT_STATUS, 'muted');
    } catch (error) {
      setModalStatus('Unable to load column metadata for this data source.', 'error');
    }
    refreshFieldControls({ preserveValues: true });
  });

  elements.addMeasureBtn?.addEventListener('click', () => {
    if (elements.addMeasureBtn.disabled) return;
    const module = state.activeModule;
    if (module && typeof module.handleAddMeasure === 'function') {
      module.handleAddMeasure(buildModuleContext());
    }
  });

  elements.form?.addEventListener('submit', handleFormSubmit);
}

function init() {
  if (state.initialized) return;
  cacheElements();
  if (!elements.modal || !elements.form) {
    console.warn(`[Feature:${FEATURE_NAME}] Modal elements not found. Card configuration disabled.`);
    state.initialized = true;
    return;
  }
  attachListeners();
  state.initialized = true;
  logDebug('initialized');
}

function ensureInitialized() {
  if (!state.initialized) {
    init();
  }
  return state.initialized;
}

function validateRequiredField(field, value) {
  if (!field.required) return null;
  if (field.allowMultiple) {
    return Array.isArray(value) && value.length ? null : `${field.label || field.name} is required.`;
  }
  if (field.field_type === 'boolean') {
    if (value === true || value === false || value === 'true' || value === 'false') {
      return null;
    }
    return `${field.label || field.name} is required.`;
  }
  if (value === null || value === undefined) return `${field.label || field.name} is required.`;
  const text = String(value).trim();
  return text ? null : `${field.label || field.name} is required.`;
}

async function collectFieldValues(chartType) {
  const module = getChartModule(chartType);
  if (module && typeof module.collectConfig === 'function') {
    const result = await module.collectConfig(
      buildModuleContext({
        chartType,
        projectName: state.context?.projectName || '',
        dataSourceId: getSelectedDataSourceId(),
      }),
    );
    const values = result && typeof result === 'object' && result.values ? result.values : {};
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    const dataSourceId = result?.dataSourceId;
    const dataSourceLabel = result?.dataSourceLabel;
    return { values, errors, dataSourceId, dataSourceLabel };
  }
  const values = {};
  const errors = [];
  if (!chartType || !Array.isArray(chartType.fields)) {
    return { values, errors, dataSourceId: undefined, dataSourceLabel: undefined };
  }

  chartType.fields.forEach(field => {
    const control = elements.fieldContainer?.querySelector(`[data-field-input="${field.name}"]`);
    if (!control) {
      return;
    }
    let value = '';
    if (control instanceof HTMLSelectElement && control.multiple) {
      value = Array.from(control.selectedOptions).map(option => option.value);
    } else if (control instanceof HTMLSelectElement) {
      value = control.value;
    } else if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      value = control.checked;
    } else if (control instanceof HTMLInputElement && control.type === 'number') {
      const parsed = control.value === '' ? null : Number(control.value);
      value = Number.isFinite(parsed) ? parsed : control.value;
    } else {
      value = control.value;
    }
    const validationError = validateRequiredField(field, value);
    if (validationError) {
      errors.push(validationError);
    }
    values[field.name] = value;
  });

  return { values, errors, dataSourceId: undefined, dataSourceLabel: undefined };
}

function closeCardConfigurator() {
  if (!elements.modal) return;
  closeModal(elements.modal);
  state.context = null;
  state.currentConfig = null;
  state.formValues = {};
  resetFormState();
}

async function openCardConfigurator({ cardId, projectName, sheetId, configuration } = {}) {
  if (!cardId) {
    console.warn(`[Feature:${FEATURE_NAME}] Cannot open configurator without a card identifier.`);
    return;
  }
  if (!ensureInitialized()) {
    return;
  }
  if (!elements.modal) {
    return;
  }

  const normalizedConfiguration = cloneConfigurationInput(configuration);
  state.context = {
    cardId,
    projectName: typeof projectName === 'string' ? projectName.trim() : '',
    sheetId: typeof sheetId === 'string' ? sheetId.trim() : '',
  };
  state.currentConfig = normalizedConfiguration;
  resetFormState();
  state.formValues = normalizedConfiguration?.fieldValues
    ? clonePlainValue(normalizedConfiguration.fieldValues)
    : {};
  // Initialize Title field from existing configuration if available
  const initialTitle = typeof state.formValues?.title === 'string' ? state.formValues.title : '';
  if (elements.titleInput) {
    elements.titleInput.value = initialTitle || '';
  }
  state.projectMetadata = resolveProjectMetadata(state.context.projectName);
  chartModules.forEach(module => {
    if (module && typeof module.initializeFromConfig === 'function') {
      try {
        module.initializeFromConfig(
          buildModuleContext({ configuration: normalizedConfiguration }),
        );
      } catch (error) {
        console.warn(`[Feature:${FEATURE_NAME}] Failed to initialize chart module`, error);
      }
    }
  });
  clearProjectCaches(state.context.projectName);
  setControlsDisabled(true);
  setModalStatus('Loading chart configuration…', 'info');

  openModal(elements.modal, { focusTarget: elements.chartTypeSelect });

  const activeProject = state.context.projectName;

  const tasks = [];
  tasks.push(
    ensureChartTypes().catch(error => {
      setModalStatus('Unable to load chart definitions.', 'error');
      console.error(`[Feature:${FEATURE_NAME}] Failed to load chart types`, error);
      throw error;
    }),
  );

  tasks.push(
    loadDataSources(activeProject)
      .then(sources => {
        state.dataSourceCache.set(activeProject || '', sources);
      })
      .catch(error => {
        console.error(`[Feature:${FEATURE_NAME}] Failed to load data sources`, error);
        setModalStatus('Unable to load data sources for this project.', 'error');
      }),
  );

  try {
    await Promise.all(tasks);
    applyInitialSelections(activeProject);
    setControlsDisabled(false);
    setModalStatus(DEFAULT_STATUS, 'muted');
    await refreshFieldControls({ preserveValues: false });
  } catch (error) {
    setControlsDisabled(false);
    // Modal stays open with error message already shown.
  }
}

async function handleFormSubmit(event) {
  event.preventDefault();
  if (!state.context || !elements.saveBtn) return;

  const chartType = getSelectedChartType();
  const chartTypeName = getSelectedChartTypeName();
  if (!chartType || !chartTypeName) {
    setModalStatus('Select a chart type before saving.', 'error');
    return;
  }
  const titleEl = elements.titleInput || null;
  if (titleEl) {
    try { titleEl.setCustomValidity(''); } catch (_) {}
  }
  let titleText = titleEl ? String(titleEl.value || '').trim() : '';
  if (!titleText) {
    const auto = getDefaultTitleForChartType(chartTypeName) || chartType.label || chartType.name || 'Chart';
    titleText = auto;
    if (titleEl) {
      titleEl.value = titleText;
      try { titleEl.setCustomValidity(''); } catch (_) {}
    }
  }
  const {
    values,
    errors,
    dataSourceId: moduleDataSourceId,
    dataSourceLabel: moduleDataSourceLabel,
  } = await collectFieldValues(chartType);
  if (errors.length) {
    setModalStatus(errors[0], 'error');
    return;
  }
  values.title = titleText;

  elements.saveBtn.disabled = true;

  try {
    const projectName = state.context.projectName;
    let dataSourceId = typeof moduleDataSourceId === 'string' ? moduleDataSourceId : '';
    let dataSourceLabel = typeof moduleDataSourceLabel === 'string' ? moduleDataSourceLabel : '';

    if (!dataSourceId) {
      dataSourceId = getSelectedDataSourceId();
      if (!dataSourceId) {
        setModalStatus('Select a data source before saving.', 'error');
        return;
      }
      const dataSourceEntry = getDataSourceEntry(projectName, dataSourceId);
      dataSourceLabel = dataSourceEntry ? describeDataSource(dataSourceEntry) : dataSourceId;
    }

    const detail = {
      cardId: state.context.cardId,
      projectName,
      sheetId: state.context.sheetId,
      chartType: chartTypeName,
      chartTypeLabel: chartType.label || chartType.name,
      dataSourceId,
      dataSourceLabel,
      fieldValues: values,
    };

    document.dispatchEvent(new CustomEvent('card:configurationSaved', { detail }));
    closeCardConfigurator();
  } finally {
    elements.saveBtn.disabled = false;
  }
}

function setContext(context) {
  if (!context || typeof context !== 'object') {
    state.context = null;
    return state.context;
  }

  const normalized = {
    cardId: typeof context.cardId === 'string' ? context.cardId.trim() : '',
    projectName: typeof context.projectName === 'string' ? context.projectName.trim() : '',
    sheetId: typeof context.sheetId === 'string' ? context.sheetId.trim() : '',
  };

  state.context = normalized;
  return state.context;
}

function initialize(context = null) {
  if (context) {
    setContext(context);
  }
  init();
  return state.initialized;
}

function getState() {
  return state;
}

function loadChartTypes() {
  return ensureChartTypes();
}

function registerChartModule(chartType, module) {
  const name = typeof chartType === 'string' ? chartType.trim() : '';
  if (!name) {
    throw new Error('chartType must be a non-empty string.');
  }
  if (!module || typeof module !== 'object') {
    throw new Error('module must be an object implementing chart hooks.');
  }
  const requiredHooks = ['attach', 'detach', 'populateFields', 'collectConfig'];
  requiredHooks.forEach(hook => {
    if (typeof module[hook] !== 'function') {
      throw new Error(`chart module for "${name}" must implement ${hook}().`);
    }
  });

  const identifier = normalizeChartTypeId(name);
  const record = module;
  if (!record.id) {
    record.id = name;
  }
  chartModules.set(identifier, record);

  return () => {
    const existing = chartModules.get(identifier);
    if (existing && existing === record) {
      if (state.activeModule === existing) {
        detachActiveModule('unregister');
      }
      chartModules.delete(identifier);
    }
  };
}

export {
  getState,
  initialize,
  loadChartTypes,
  openCardConfigurator,
  registerChartModule,
  setContext,
  init,
};

registerLineChart({
  state,
  elements,
  clearChildren,
  cloneColumnEntries,
  getColumnsCacheKey,
  loadColumns,
  fetchSubjectGroups,
  setModalStatus,
  describeDataSource,
  generateMeasureId,
  registerChartModule,
  getSelectedChartType,
  getDataSourceEntry,
});

registerScatterChart({
  state,
  elements,
  clearChildren,
  cloneColumnEntries,
  getColumnsCacheKey,
  loadColumns,
  fetchSubjectGroups,
  setModalStatus,
  describeDataSource,
  registerChartModule,
  getSelectedChartType,
  getSelectedDataSourceId,
  getDataSourceEntry,
});

export default {
  init,
  openCardConfigurator,
  initialize,
  getState,
  setContext,
  loadChartTypes,
  registerChartModule,
};
