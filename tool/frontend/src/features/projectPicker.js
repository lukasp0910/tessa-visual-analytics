import { listProjects } from '../api/projects.js';
import { fetchActiveProject, updateActiveProject } from '../api/uiState.js';
import { byId } from '../ui/dom.js';
import { setProjects as setStoreProjects } from '../state/store.js';

const FEATURE_NAME = 'projectPicker';

const MAX_PROJECT_RETRIES = 5;
const PROJECT_RETRY_DELAY = 1500;

const state = {
  projects: [],
  preferredSelection: null,
  retryTimer: null,
  loading: false,
  initialized: false,
  lastPersistedProject: null,
};

const elements = {};

function cacheElements() {
  elements.projectSelect = byId('projectSelect');
  elements.uploadStatus = byId('uploadStatus');
  elements.projectDetailsBtn = byId('projectDetailsBtn');
  elements.deleteProjectBtn = byId('deleteProjectBtn');
  elements.addDataBtn = byId('addDataBtn');
  elements.editVisibilityBtn = byId('editVisibilityBtn');
}

function projectDisplayName(project, fallback = '') {
  if (project && typeof project === 'object') {
    if (typeof project.title === 'string' && project.title.trim()) {
      return project.title.trim();
    }
    const candidates = [
      project.display_name,
      project.displayName,
      project.name,
      project.filename,
      project.file_name,
      project.fileName,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback.trim();
  }
  return '';
}

function normalizeDisabledColumns(columns) {
  if (!Array.isArray(columns)) return [];
  const normalized = new Set();
  columns.forEach(value => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      normalized.add(parsed);
    }
  });
  return Array.from(normalized).sort((a, b) => a - b);
}

function normalizeColumnNameMap(value) {
  if (value == null) return {};
  const entries = [];
  if (value instanceof Map) {
    value.forEach((name, key) => {
      entries.push([key, name]);
    });
  } else if (Array.isArray(value)) {
    value.forEach((name, index) => {
      entries.push([index + 1, name]);
    });
  } else if (typeof value === 'object') {
    for (const [rawIndex, name] of Object.entries(value)) {
      entries.push([rawIndex, name]);
    }
  }
  const normalized = [];
  entries.forEach(([rawIndex, rawName]) => {
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isInteger(index) || index < 1) return;
    const text = String(rawName ?? '').trim();
    if (!text) return;
    normalized.push([index, text]);
  });
  normalized.sort((a, b) => a[0] - b[0]);
  const result = {};
  normalized.forEach(([index, name]) => {
    result[String(index)] = name;
  });
  return result;
}

function normalizeSubjectMode(value) {
  if (typeof value === 'string') {
    const cleaned = value.trim().toLowerCase();
    if (!cleaned) {
      return 'single';
    }
    if (cleaned === 'multi' || cleaned === 'multi-subject') {
      return 'multi';
    }
    if (cleaned === 'single' || cleaned === 'single-subject') {
      return 'single';
    }
    const normalized = cleaned.replace(/[_\s-]+/g, ' ');
    if (normalized === 'multi subject' || normalized === 'multiple subjects') {
      return 'multi';
    }
    if (normalized === 'single subject') {
      return 'single';
    }
  } else if (typeof value === 'boolean') {
    return value ? 'multi' : 'single';
  }
  return 'single';
}

function normalizeSubjectArrays(value) {
  if (value == null) {
    return [];
  }
  const items = value instanceof Set ? Array.from(value) : Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];
  items.forEach(item => {
    const text = typeof item === 'string' ? item.trim() : String(item ?? '').trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    normalized.push(text);
  });
  return normalized;
}

function normalizeSubjectNameOverrides(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const entries = value instanceof Map ? Array.from(value.entries()) : Object.entries(value);
  const normalized = {};
  for (const [rawKey, rawValue] of entries) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : String(rawKey ?? '').trim();
    if (!key) {
      continue;
    }
    const text = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '').trim();
    if (!text) {
      continue;
    }
    normalized[key] = text;
    if (Object.keys(normalized).length >= 1024) {
      break;
    }
  }
  return normalized;
}

function parseNonNegativeInteger(value) {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function parseNonNegativeNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function parsePositiveNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function parseBooleanFlag(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 0) return false;
    if (value === 1) return true;
    return value > 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return null;
    if (['true', '1', 'yes', 'on'].includes(trimmed)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(trimmed)) {
      return false;
    }
  }
  return null;
}

function normalizeTimeAxis(selection) {
  if (!selection || typeof selection !== 'object') return null;

  const normalized = {};

  if (typeof selection.array_id === 'string' && selection.array_id.trim()) {
    normalized.array_id = selection.array_id.trim();
  }
  if (typeof selection.array_name === 'string' && selection.array_name.trim()) {
    normalized.array_name = selection.array_name.trim();
  }

  if (typeof selection.source === 'string' && selection.source.trim()) {
    normalized.source = selection.source.trim().toLowerCase();
  }

  return Object.keys(normalized).length ? normalized : null;
}

function normalizeTimeAxisConflict(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const normalized = {};

  if (typeof entry.array_id === 'string' && entry.array_id.trim()) {
    normalized.array_id = entry.array_id.trim();
  }
  if (typeof entry.array_name === 'string' && entry.array_name.trim()) {
    normalized.array_name = entry.array_name.trim();
  }

  const rowCount = parseNonNegativeInteger(entry.row_count);
  if (rowCount !== null) {
    normalized.row_count = rowCount;
  }

  const expectedCount = parseNonNegativeInteger(entry.expected_row_count);
  if (expectedCount !== null) {
    normalized.expected_row_count = expectedCount;
  }

  return Object.keys(normalized).length ? normalized : null;
}

function normalizeTimeAxisConflicts(conflicts) {
  if (!Array.isArray(conflicts)) return [];
  return conflicts.map(normalizeTimeAxisConflict).filter(Boolean);
}

function normalizeTimeControls(config) {
  if (!config || typeof config !== 'object') return null;
  const normalized = {};

  const timesteps = parseNonNegativeInteger(config.timesteps);
  if (timesteps != null && timesteps > 0) {
    normalized.timesteps = timesteps;
  }

  if (typeof config.analysis_scope === 'string') {
    const scope = config.analysis_scope.trim().toLowerCase();
    if (scope === 'all' || scope === 'matching') {
      normalized.analysis_scope = scope;
    }
  }

  const recordingDuration = parseNonNegativeNumber(config.recording_duration);
  if (recordingDuration != null) {
    normalized.recording_duration = recordingDuration;
  }

  const playbackSpeed = parsePositiveNumber(config.playback_speed);
  if (playbackSpeed != null) {
    normalized.playback_speed = playbackSpeed;
  }

  const playbackOriginal = parseBooleanFlag(config.playback_original_speed);
  if (playbackOriginal != null) {
    normalized.playback_original_speed = playbackOriginal;
  }

  return Object.keys(normalized).length ? normalized : null;
}

function normalizeArrayMetadataEntry(array) {
  if (!array || typeof array !== 'object') return null;
  const id = typeof array.id === 'string' && array.id.trim() ? array.id.trim() : null;
  const name = typeof array.name === 'string' && array.name.trim()
    ? array.name.trim()
    : String(array.name ?? '').trim();
  const normalized = { ...array, id, name };
  normalized.enabled = array.enabled !== false;
  normalized.disabled_columns = normalizeDisabledColumns(array.disabled_columns);
  normalized.column_names = normalizeColumnNameMap(array.column_names);
  return normalized;
}

function normalizeVisibilityRecord(record) {
  const normalized = { arrays: {} };
  if (!record || typeof record !== 'object') {
    return normalized;
  }
  const arrays = record.arrays;
  if (!arrays || typeof arrays !== 'object') {
    return normalized;
  }
  for (const [key, entry] of Object.entries(arrays)) {
    const id = typeof key === 'string' ? key.trim() : String(key ?? '').trim();
    if (!id || !entry || typeof entry !== 'object') continue;
    normalized.arrays[id] = {
      enabled: entry.enabled !== false,
      disabled_columns: normalizeDisabledColumns(entry.disabled_columns),
    };
    const columnNames = normalizeColumnNameMap(entry.column_names);
    if (Object.keys(columnNames).length > 0) {
      normalized.arrays[id].column_names = columnNames;
    }
  }
  return normalized;
}

function normalizeProjectEntry(project) {
  if (!project || typeof project !== 'object') return null;
  const normalized = { ...project };
  const name = project.name ?? project.filename ?? project.file_name ?? project.fileName ?? '';
  normalized.name = String(name);

  if (typeof project.filename === 'string' && project.filename.trim()) {
    normalized.filename = project.filename.trim();
  } else if (typeof project.file_name === 'string' && project.file_name.trim()) {
    normalized.filename = project.file_name.trim();
  } else {
    normalized.filename = normalized.name;
  }

  const displayName = projectDisplayName(normalized, normalized.name);
  if (displayName) {
    normalized.display_name = displayName;
  } else {
    delete normalized.display_name;
  }

  if (typeof project.title === 'string' && project.title.trim()) {
    normalized.title = project.title.trim();
  } else {
    delete normalized.title;
  }

  if (typeof project.project_id === 'string' && project.project_id.trim()) {
    normalized.project_id = project.project_id.trim();
  } else if (project.project_id != null) {
    normalized.project_id = String(project.project_id).trim();
  }

  if (typeof project.created_at === 'string' && project.created_at.trim()) {
    normalized.created_at = project.created_at.trim();
  } else if (project.created_at != null) {
    normalized.created_at = String(project.created_at).trim();
  }

  if (project.visibility) {
    normalized.visibility = normalizeVisibilityRecord(project.visibility);
  }

  if (Array.isArray(project.arrays)) {
    normalized.arrays = project.arrays.map(normalizeArrayMetadataEntry).filter(Boolean);
  }

  if (!Number.isFinite(normalized.array_count) && Array.isArray(normalized.arrays)) {
    normalized.array_count = normalized.arrays.length;
  }

  const timeAxis = normalizeTimeAxis(project.time_axis);
  if (timeAxis) {
    normalized.time_axis = timeAxis;
  } else {
    normalized.time_axis = null;
  }

  normalized.time_axis_auto_detected = Boolean(timeAxis && timeAxis.source === 'auto');

  const conflicts = normalizeTimeAxisConflicts(project.time_axis_conflicts);
  normalized.time_axis_conflicts = conflicts;

  const timeControls = normalizeTimeControls(project.time_controls);
  normalized.time_controls = timeControls ?? null;

  normalized.subject_mode = normalizeSubjectMode(project.subject_mode);
  normalized.subject_arrays = normalizeSubjectArrays(project.subject_arrays ?? project.subjectArrays);
  normalized.subject_names = normalizeSubjectNameOverrides(
    project.subject_names ?? project.subjectNames,
  );

  return normalized;
}

function setUploadStatus(message, { isError = false } = {}) {
  const el = elements.uploadStatus;
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('text-red-600', isError);
  el.classList.toggle('text-gray-600', !isError);
}

function setPreferredSelection(name) {
  if (typeof name === 'string' && name.trim()) {
    state.preferredSelection = name.trim();
  } else {
    state.preferredSelection = null;
  }
}

function normalizeProjectName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed ? trimmed : null;
}

function setLastPersistedProject(name) {
  state.lastPersistedProject = normalizeProjectName(name);
}

async function persistProjectSelection(projectName) {
  const normalized = normalizeProjectName(projectName);
  const previous = normalizeProjectName(state.lastPersistedProject);
  if (normalized === previous) {
    return;
  }
  try {
    const response = await updateActiveProject(normalized ?? null);
    setLastPersistedProject(response?.project_name ?? null);
  } catch (error) {
    console.warn('[Feature:projectPicker] Failed to persist active project selection', error);
  }
}

async function syncActiveProjectPreference() {
  try {
    const response = await fetchActiveProject();
    const preferred = normalizeProjectName(response?.project_name);
    setLastPersistedProject(preferred);
    if (preferred) {
      setPreferredSelection(preferred);
    }
  } catch (error) {
    console.warn('[Feature:projectPicker] Failed to load active project selection', error);
  }
}

function findProjectByName(name) {
  if (!name) return null;
  return state.projects.find(project => project?.name === name) || null;
}

function updateControlStates(project) {
  const hasProject = Boolean(project);
  if (elements.projectDetailsBtn) {
    elements.projectDetailsBtn.disabled = !hasProject;
  }
  if (elements.deleteProjectBtn) {
    elements.deleteProjectBtn.disabled = !hasProject;
  }
  if (elements.addDataBtn) {
    elements.addDataBtn.disabled = !hasProject;
  }
  if (elements.editVisibilityBtn) {
    elements.editVisibilityBtn.disabled = !hasProject;
  }
}

function dispatchProjectsUpdated(projects) {
  document.dispatchEvent(new CustomEvent('projects:updated', {
    detail: { projects: [...projects] },
  }));
}

function dispatchProjectSelected(project, { reason, keepAddDataOpen } = {}) {
  const detail = {
    project: project || null,
    projectName: project?.name ?? null,
    reason,
  };
  if (keepAddDataOpen) {
    detail.keepAddDataOpen = true;
  }
  document.dispatchEvent(new CustomEvent('project:selected', { detail }));
}

function renderEmptyState(message) {
  const select = elements.projectSelect;
  if (!select) return;
  select.innerHTML = '';
  const option = document.createElement('option');
  option.value = '';
  option.textContent = message;
  option.disabled = true;
  option.selected = true;
  select.append(option);
  select.disabled = true;
  updateControlStates(null);
}

function applyProjectOptions(projects, selection) {
  const select = elements.projectSelect;
  if (!select) return;
  select.innerHTML = '';
  projects.forEach(project => {
    if (!project?.name) return;
    const option = document.createElement('option');
    option.value = project.name;
    option.textContent = projectDisplayName(project, project.name) || project.name;
    option.selected = project.name === selection;
    select.append(option);
  });
  select.disabled = projects.length === 0;
  select.value = selection || '';
}

function selectProjectByName(projectName, { reason } = {}) {
  const select = elements.projectSelect;
  if (!select) return;
  const project = findProjectByName(projectName) || null;
  if (project) {
    select.value = project.name;
  } else if (state.projects.length) {
    select.value = state.projects[0].name;
  } else {
    select.value = '';
  }
  const resolved = findProjectByName(select.value) || null;
  updateControlStates(resolved);
  dispatchProjectSelected(resolved, { reason });
  persistProjectSelection(resolved?.name ?? null).catch(() => {});
}

async function loadProjects({ preferredProject, reason, retryCount = 0 } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (preferredProject) {
    setPreferredSelection(preferredProject);
  }
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  const select = elements.projectSelect;
  if (select) {
    select.disabled = true;
  }

  try {
    const response = await listProjects();
    const projects = Array.isArray(response)
      ? response.map(normalizeProjectEntry).filter(Boolean)
      : [];
    state.projects = projects;
    setStoreProjects(projects);
    dispatchProjectsUpdated(projects);

    if (!projects.length) {
      renderEmptyState('No projects available');
      dispatchProjectSelected(null, { reason: reason || 'empty' });
      persistProjectSelection(null).catch(() => {});
      return;
    }

    const previousValue = select?.value || '';
    let desiredSelection = state.preferredSelection || preferredProject || previousValue;
    if (!desiredSelection || !projects.some(project => project.name === desiredSelection)) {
      desiredSelection = projects[0].name;
    }
    applyProjectOptions(projects, desiredSelection);
    selectProjectByName(desiredSelection, { reason: reason || 'refresh' });
    state.preferredSelection = null;
  } catch (error) {
    console.error('[Feature:projectPicker] Failed to load projects', error);
    setUploadStatus(`Failed to load projects: ${error?.message ?? 'Unexpected error.'}`, { isError: true });
    renderEmptyState('Failed to load projects');
    dispatchProjectSelected(null, { reason: 'load-error' });

    if (retryCount < MAX_PROJECT_RETRIES) {
      const nextRetry = retryCount + 1;
      state.retryTimer = window.setTimeout(() => {
        state.retryTimer = null;
        loadProjects({ preferredProject, reason, retryCount: nextRetry }).catch(() => {});
      }, PROJECT_RETRY_DELAY);
    }
  } finally {
    state.loading = false;
  }
}

function handleSelectChange(event) {
  const value = event.target?.value || '';
  selectProjectByName(value, { reason: 'user' });
}

function handleProjectsRefresh(event) {
  const detail = event.detail || {};
  const preferredProject = detail.preferredProject || detail.projectName || null;
  if (preferredProject) {
    setPreferredSelection(preferredProject);
  }
  loadProjects({ preferredProject, reason: detail.reason || 'refresh-requested' }).catch(() => {});
}

function handleProjectDeleted(event) {
  const { projectName } = event.detail || {};
  if (projectName && state.projects.some(project => project.name === projectName)) {
    loadProjects({ reason: 'project-deleted' }).catch(() => {});
  }
}

function handleProjectCreated(event) {
  const { projectName } = event.detail || {};
  if (projectName) {
    setPreferredSelection(projectName);
  }
}

function attachEventListeners() {
  elements.projectSelect?.addEventListener('change', handleSelectChange);
  document.addEventListener('projects:refresh-requested', handleProjectsRefresh);
  document.addEventListener('project:deleted', handleProjectDeleted);
  document.addEventListener('project:created', handleProjectCreated);
}

export function init() {
  if (state.initialized) return;
  cacheElements();
  if (!elements.projectSelect) {
    console.warn('[Feature:projectPicker] Project select element not found.');
    return;
  }
  state.initialized = true;
  attachEventListeners();
  syncActiveProjectPreference()
    .catch(() => {})
    .finally(() => {
      loadProjects({ reason: 'bootstrap' }).catch(() => {});
    });
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };
