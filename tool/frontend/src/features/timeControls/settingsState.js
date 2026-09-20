import { listArrays, updateProject } from '../../api/projects.js';

const state = {
  projectName: null,
  projectLabel: '',
  options: [],
  selected: null,
  preferredTimesteps: null,
  analysisScope: null,
  recordingDuration: null,
  playbackSpeed: null,
  playbackOriginalSpeed: false,
  runtimeTimesteps: null,
  awaitingRuntimeTimesteps: false,
  loading: false,
  error: null,
  saving: false,
  saveError: null,
  arrays: [],
  unmatched: [],
  disabled: [],
  summary: {
    totalEnabled: 0,
    coveredCount: 0,
    uniqueLengths: 0,
    unmatchedCount: 0,
    disabledCount: 0,
  },
  lastUpdatedAt: 0,
  lastUpdatedSource: null,
};

const listeners = new Set();
let initialized = false;
let activeRequestId = 0;

function notify() {
  const snapshot = getState();
  listeners.forEach(listener => {
    try {
      listener(snapshot);
    } catch (error) {
      console.error('[timeControls:settingsState] Listener error', error);
    }
  });
}

function normalizeProjectName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function deriveProjectLabel(projectEntry, fallbackName) {
  if (projectEntry && typeof projectEntry === 'object') {
    const candidates = [
      projectEntry.display_name,
      projectEntry.title,
      projectEntry.name,
      projectEntry.file_name,
      projectEntry.filename,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }
  }
  if (typeof fallbackName === 'string' && fallbackName.trim()) {
    return fallbackName.trim();
  }
  return '';
}

function normalizeTimesteps(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const candidate = Math.trunc(value);
    return candidate > 0 ? candidate : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function normalizeAnalysisScope(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'matching') return 'matching';
  if (trimmed === 'all') return 'all';
  return null;
}

function normalizeRecordingDuration(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function normalizePlaybackSpeed(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function normalizePlaybackOriginalSpeed(value) {
  if (value == null) return false;
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
    if (!trimmed) return false;
    if (['true', '1', 'yes', 'on'].includes(trimmed)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(trimmed)) {
      return false;
    }
  }
  return false;
}

function numbersEqual(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(a, b);
  }
  return false;
}

function normalizeShape(value) {
  if (!Array.isArray(value)) return [];
  const numeric = [];
  value.forEach(entry => {
    if (Number.isInteger(entry) && entry >= 0) {
      numeric.push(entry);
      return;
    }
    const parsed = Number.parseInt(entry, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      numeric.push(parsed);
    }
  });
  return numeric;
}

function inferRowCount(shape) {
  if (!Array.isArray(shape) || !shape.length) return null;
  const primary = shape[0];
  if (Number.isInteger(primary) && primary > 0) {
    return primary;
  }
  const fallback = shape.find(value => Number.isInteger(value) && value > 0);
  return Number.isInteger(fallback) && fallback > 0 ? fallback : null;
}

function normalizeArrayEntry(array) {
  if (!array || typeof array !== 'object') return null;
  const id = typeof array.id === 'string' && array.id.trim() ? array.id.trim() : null;
  const name = typeof array.name === 'string' && array.name.trim() ? array.name.trim() : null;
  const displayName = name || id || 'Array';
  const shape = normalizeShape(array.shape);
  const rowCount = inferRowCount(shape);
  const shapeLabel = shape.length ? shape.join('×') : '';
  return {
    id: id || displayName,
    name,
    displayName,
    shape,
    shapeLabel,
    rowCount,
    enabled: array.enabled !== false,
  };
}

function sortByDisplayName(a, b) {
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base', numeric: true });
}

function buildOptions(arrays) {
  const groups = new Map();
  arrays.forEach(array => {
    const { rowCount } = array;
    if (!Number.isInteger(rowCount) || rowCount <= 0) {
      return;
    }
    if (!groups.has(rowCount)) {
      groups.set(rowCount, { timesteps: rowCount, arrays: [] });
    }
    groups.get(rowCount).arrays.push(array);
  });

  const options = Array.from(groups.values());
  options.forEach(option => {
    option.arrays.sort(sortByDisplayName);
  });
  options.sort((a, b) => a.timesteps - b.timesteps);
  return options;
}

function pickDefaultSelection(options) {
  if (!Array.isArray(options) || !options.length) {
    return null;
  }
  let largest = options[0];
  options.forEach(option => {
    if (option.timesteps > largest.timesteps) {
      largest = option;
    }
  });
  return largest.timesteps;
}

function resetCollections() {
  state.arrays = [];
  state.options = [];
  state.selected = null;
  state.unmatched = [];
  state.disabled = [];
  state.summary = {
    totalEnabled: 0,
    coveredCount: 0,
    uniqueLengths: 0,
    unmatchedCount: 0,
    disabledCount: 0,
  };
}

function applyArrays(rawArrays, { source = null, preferredTimesteps } = {}) {
  const normalized = Array.isArray(rawArrays)
    ? rawArrays.map(normalizeArrayEntry).filter(Boolean)
    : [];
  const enabled = normalized.filter(entry => entry.enabled);
  const groupedCandidates = enabled.filter(entry => Number.isInteger(entry.rowCount) && entry.rowCount > 0);
  const options = buildOptions(groupedCandidates);

  const runtimeTimesteps = normalizeTimesteps(state.runtimeTimesteps);
  const availableTimesteps = new Set(options.map(option => option.timesteps));
  if (runtimeTimesteps) {
    availableTimesteps.add(runtimeTimesteps);
  }

  const preferred = preferredTimesteps === undefined
    ? normalizeTimesteps(state.preferredTimesteps)
    : normalizeTimesteps(preferredTimesteps);
  if (preferredTimesteps !== undefined) {
    state.preferredTimesteps = preferred ?? null;
  }
  const currentSelection = normalizeTimesteps(state.selected);

  let nextSelection = null;
  if (!state.awaitingRuntimeTimesteps) {
    if (currentSelection && availableTimesteps.has(currentSelection)) {
      nextSelection = currentSelection;
    } else if (preferred && availableTimesteps.has(preferred)) {
      nextSelection = preferred;
    } else {
      nextSelection = pickDefaultSelection(options);
    }
  }

  let mergedOptions = options;
  if (runtimeTimesteps && !options.some(option => option.timesteps === runtimeTimesteps)) {
    mergedOptions = [...options, { timesteps: runtimeTimesteps, arrays: [], runtime: true }];
    mergedOptions.sort((a, b) => a.timesteps - b.timesteps);
  }

  state.arrays = normalized;
  state.options = mergedOptions;
  state.selected = nextSelection ?? null;
  state.unmatched = enabled.filter(entry => !Number.isInteger(entry.rowCount) || entry.rowCount <= 0);
  state.disabled = normalized.filter(entry => !entry.enabled);
  state.summary = {
    totalEnabled: enabled.length,
    coveredCount: groupedCandidates.length,
    uniqueLengths: options.length,
    unmatchedCount: state.unmatched.length,
    disabledCount: state.disabled.length,
  };
  state.loading = false;
  state.error = null;
  state.lastUpdatedAt = Date.now();
  state.lastUpdatedSource = source;

  notify();
}

async function fetchArraysForProject(projectName) {
  if (!projectName) return;
  const requestId = ++activeRequestId;
  state.loading = true;
  state.error = null;
  notify();
  try {
    const response = await listArrays(projectName);
    if (requestId !== activeRequestId) {
      return;
    }
    applyArrays(Array.isArray(response) ? response : [], {
      source: 'api',
      preferredTimesteps: state.preferredTimesteps,
    });
  } catch (error) {
    if (requestId !== activeRequestId) {
      return;
    }
    state.loading = false;
    state.error = error?.message ? `Unable to load array metadata: ${error.message}` : 'Unable to load array metadata.';
    state.lastUpdatedAt = Date.now();
    notify();
  }
}

export function initSettingsState() {
  if (initialized) return;
  initialized = true;
}

export function setActiveProject({ projectName, projectEntry } = {}) {
  if (!initialized) {
    initSettingsState();
  }

  const previousProject = state.projectName;
  const normalizedName = normalizeProjectName(projectName ?? projectEntry?.name ?? null);
  const hasTimeControls = projectEntry
    && typeof projectEntry === 'object'
    && Object.prototype.hasOwnProperty.call(projectEntry, 'time_controls');
  const subjectMode = typeof projectEntry?.subject_mode === 'string' 
    ? projectEntry.subject_mode.trim().toLowerCase() 
    : (typeof projectEntry?.subjectMode === 'string' ? projectEntry.subjectMode.trim().toLowerCase() : 'single');
  let preferred = state.preferredTimesteps;
  let scopePreference = state.analysisScope;
  let recordingPreference = state.recordingDuration;
  let playbackPreference = state.playbackSpeed;
  let playbackOriginalPreference = state.playbackOriginalSpeed;

  if (!normalizedName) {
    preferred = null;
    scopePreference = null;
    recordingPreference = null;
    playbackPreference = null;
    playbackOriginalPreference = false;
  } else if (hasTimeControls) {
    preferred = normalizeTimesteps(projectEntry?.time_controls?.timesteps);
    scopePreference = normalizeAnalysisScope(projectEntry?.time_controls?.analysis_scope);
    recordingPreference = normalizeRecordingDuration(projectEntry?.time_controls?.recording_duration);
    playbackPreference = normalizePlaybackSpeed(projectEntry?.time_controls?.playback_speed);
    playbackOriginalPreference = normalizePlaybackOriginalSpeed(
      projectEntry?.time_controls?.playback_original_speed,
    );
  } else if (normalizedName !== previousProject) {
    preferred = null;
    scopePreference = null;
    recordingPreference = null;
    playbackPreference = null;
    playbackOriginalPreference = false;
  }

  state.projectName = normalizedName;
  state.projectLabel = deriveProjectLabel(projectEntry, normalizedName);
  state.error = null;
  state.saving = false;
  state.saveError = null;
  state.preferredTimesteps = preferred ?? null;
  state.analysisScope = scopePreference ?? null;
  state.recordingDuration = recordingPreference;
  state.playbackSpeed = playbackPreference;
  state.playbackOriginalSpeed = playbackOriginalPreference;
  state.runtimeTimesteps = null;
  state.awaitingRuntimeTimesteps = (subjectMode === 'multi' || subjectMode === 'multi-subject');
  if (normalizedName !== previousProject) {
    state.selected = null;
  }

  if (!normalizedName) {
    state.loading = false;
    resetCollections();
    state.lastUpdatedAt = 0;
    state.lastUpdatedSource = null;
    notify();
    return;
  }

  if (projectEntry && Array.isArray(projectEntry.arrays)) {
    applyArrays(projectEntry.arrays, { source: 'project', preferredTimesteps: state.preferredTimesteps });
    return;
  }

  resetCollections();
  state.loading = true;
  state.lastUpdatedSource = null;
  notify();
  fetchArraysForProject(normalizedName).catch(() => {});
}

export function syncProjectEntries(projects) {
  if (!initialized) {
    initSettingsState();
  }
  if (!state.projectName || !Array.isArray(projects)) {
    return;
  }
  const entry = projects.find(project => project?.name === state.projectName);
  if (entry && Array.isArray(entry.arrays)) {
    if (Object.prototype.hasOwnProperty.call(entry, 'time_controls')) {
      state.preferredTimesteps = normalizeTimesteps(entry.time_controls?.timesteps) ?? null;
      state.analysisScope = normalizeAnalysisScope(entry.time_controls?.analysis_scope) ?? null;
      state.recordingDuration = normalizeRecordingDuration(entry.time_controls?.recording_duration);
      state.playbackSpeed = normalizePlaybackSpeed(entry.time_controls?.playback_speed);
      state.playbackOriginalSpeed = normalizePlaybackOriginalSpeed(
        entry.time_controls?.playback_original_speed,
      );
    }
    applyArrays(entry.arrays, { source: 'project', preferredTimesteps: state.preferredTimesteps });
  }
}

export function refreshActiveProject() {
  if (!initialized) {
    initSettingsState();
  }
  if (!state.projectName) return Promise.resolve();
  return fetchArraysForProject(state.projectName);
}

export function isActiveProject(projectName) {
  if (!initialized) {
    initSettingsState();
  }
  const normalized = normalizeProjectName(projectName);
  return Boolean(normalized && normalized === state.projectName);
}

export function setSelectedTimesteps(value) {
  if (!initialized) {
    initSettingsState();
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return false;
  }
  const exists = state.options.some(option => option.timesteps === parsed);
  if (!exists) {
    return false;
  }
  if (state.selected === parsed) {
    return true;
  }
  state.selected = parsed;
  state.preferredTimesteps = parsed;
  state.runtimeTimesteps = null;
  state.saveError = null;
  notify();
  return true;
}

export function setRuntimeTimesteps(value) {
  if (!initialized) {
    initSettingsState();
  }
  const parsed = normalizeTimesteps(value);
  const previousRuntime = state.runtimeTimesteps;
  const runtimeValue = parsed ?? null;

  if (runtimeValue) {
    if (!state.options.some(option => option.timesteps === runtimeValue)) {
      state.options = [...state.options, { timesteps: runtimeValue, arrays: [], runtime: true }]
        .sort((a, b) => a.timesteps - b.timesteps);
    }
    const changedSelection = state.selected !== runtimeValue;
    state.runtimeTimesteps = runtimeValue;
    state.selected = runtimeValue;
    state.lastUpdatedSource = 'runtime';
    if (changedSelection || previousRuntime !== runtimeValue) {
      notify();
      return true;
    }
    return false;
  }

  // Clearing runtime override
  state.runtimeTimesteps = null;
  let nextSelection = null;
  const available = new Set(state.options.map(option => option.timesteps));
  const preferred = normalizeTimesteps(state.preferredTimesteps);
  const current = normalizeTimesteps(state.selected);
  if (preferred && available.has(preferred)) {
    nextSelection = preferred;
  } else if (current && available.has(current)) {
    nextSelection = current;
  } else {
    nextSelection = pickDefaultSelection(state.options);
  }
  const changed = state.selected !== nextSelection || previousRuntime !== null;
  state.selected = nextSelection ?? null;
  if (changed) {
    notify();
  }
  return changed;
}

export function setTimeControlPreferences(preferences = {}) {
  if (!initialized) {
    initSettingsState();
  }

  const nextScope = normalizeAnalysisScope(preferences.analysisScope ?? preferences.analysis_scope);
  const nextDuration = normalizeRecordingDuration(preferences.recordingDuration ?? preferences.recording_duration);
  const nextSpeed = normalizePlaybackSpeed(preferences.playbackSpeed ?? preferences.playback_speed);
  const hasOriginalPreference = Object.prototype.hasOwnProperty.call(preferences, 'playbackOriginalSpeed')
    || Object.prototype.hasOwnProperty.call(preferences, 'playback_original_speed');
  const nextOriginal = hasOriginalPreference
    ? normalizePlaybackOriginalSpeed(
      preferences.playbackOriginalSpeed ?? preferences.playback_original_speed,
    )
    : state.playbackOriginalSpeed;

  let changed = false;
  if ((state.analysisScope ?? null) !== (nextScope ?? null)) {
    state.analysisScope = nextScope ?? null;
    changed = true;
  }
  if (!numbersEqual(state.recordingDuration, nextDuration)) {
    state.recordingDuration = nextDuration;
    changed = true;
  }
  if (!numbersEqual(state.playbackSpeed, nextSpeed)) {
    state.playbackSpeed = nextSpeed;
    changed = true;
  }
  if (hasOriginalPreference && state.playbackOriginalSpeed !== nextOriginal) {
    state.playbackOriginalSpeed = nextOriginal;
    changed = true;
  }

  if (changed) {
    state.saveError = null;
    notify();
  }

  return changed;
}

export async function persistTimeControlSettings(config = {}) {
  if (!initialized) {
    initSettingsState();
  }
  const projectName = state.projectName;
  if (!projectName) {
    const message = 'Select a project before saving time control settings.';
    state.saveError = message;
    notify();
    return Promise.reject(new Error(message));
  }

  const timesteps = normalizeTimesteps(config.timesteps ?? state.selected);
  const analysisScope = normalizeAnalysisScope(config.analysisScope ?? config.analysis_scope ?? state.analysisScope);
  const recordingDuration = normalizeRecordingDuration(
    config.recordingDuration ?? config.recording_duration ?? state.recordingDuration,
  );
  const playbackSpeed = normalizePlaybackSpeed(
    config.playbackSpeed ?? config.playback_speed ?? state.playbackSpeed,
  );
  const playbackOriginalSpeed = normalizePlaybackOriginalSpeed(
    config.playbackOriginalSpeed ?? config.playback_original_speed ?? state.playbackOriginalSpeed,
  );

  const timeControls = {};
  if (timesteps) {
    timeControls.timesteps = timesteps;
  }
  if (analysisScope) {
    timeControls.analysis_scope = analysisScope;
  }
  if (recordingDuration != null) {
    timeControls.recording_duration = recordingDuration;
  }
  if (playbackSpeed != null) {
    timeControls.playback_speed = playbackSpeed;
  }
  timeControls.playback_original_speed = playbackOriginalSpeed;

  const payload = Object.keys(timeControls).length ? { time_controls: timeControls } : { time_controls: null };

  state.saving = true;
  state.saveError = null;
  notify();

  try {
    const response = await updateProject(projectName, payload);
    const responseControls = response?.time_controls ?? null;
    const hasTimesteps = Object.prototype.hasOwnProperty.call(timeControls, 'timesteps');
    const hasScope = Object.prototype.hasOwnProperty.call(timeControls, 'analysis_scope');
    const hasDuration = Object.prototype.hasOwnProperty.call(timeControls, 'recording_duration');
    const hasSpeed = Object.prototype.hasOwnProperty.call(timeControls, 'playback_speed');
    const hasOriginal = Object.prototype.hasOwnProperty.call(timeControls, 'playback_original_speed');

    const savedTimesteps = responseControls
      ? normalizeTimesteps(
        Object.prototype.hasOwnProperty.call(responseControls, 'timesteps')
          ? responseControls.timesteps
          : hasTimesteps
            ? timesteps
            : null,
      )
      : null;

    const savedScope = responseControls
      ? normalizeAnalysisScope(
        Object.prototype.hasOwnProperty.call(responseControls, 'analysis_scope')
          ? responseControls.analysis_scope
          : hasScope
            ? analysisScope
            : null,
      )
      : null;

    const savedDuration = responseControls
      ? normalizeRecordingDuration(
        Object.prototype.hasOwnProperty.call(responseControls, 'recording_duration')
          ? responseControls.recording_duration
          : hasDuration
            ? recordingDuration
            : null,
      )
      : null;

    const savedSpeed = responseControls
      ? normalizePlaybackSpeed(
        Object.prototype.hasOwnProperty.call(responseControls, 'playback_speed')
          ? responseControls.playback_speed
          : hasSpeed
            ? playbackSpeed
            : null,
      )
      : null;
    const savedOriginal = responseControls
      ? normalizePlaybackOriginalSpeed(
        Object.prototype.hasOwnProperty.call(responseControls, 'playback_original_speed')
          ? responseControls.playback_original_speed
          : hasOriginal
            ? playbackOriginalSpeed
            : state.playbackOriginalSpeed,
      )
      : state.playbackOriginalSpeed;
    state.saving = false;
    state.saveError = null;
    state.preferredTimesteps = savedTimesteps ?? null;
    if (savedTimesteps) {
      state.selected = savedTimesteps;
    } else if (!timesteps) {
      state.selected = null;
    }
    state.analysisScope = savedScope ?? null;
    state.recordingDuration = savedDuration;
    state.playbackSpeed = savedSpeed;
    state.playbackOriginalSpeed = savedOriginal;
    notify();
    return {
      timesteps: savedTimesteps ?? null,
      analysisScope: savedScope ?? null,
      recordingDuration: savedDuration,
      playbackSpeed: savedSpeed,
      playbackOriginalSpeed: savedOriginal,
    };
  } catch (error) {
    state.saving = false;
    const message = error?.message
      ? `Unable to save time control settings: ${error.message}`
      : 'Unable to save time control settings.';
    state.saveError = message;
    notify();
    throw new Error(message);
  }
}

export function getState() {
  return {
    projectName: state.projectName,
    projectLabel: state.projectLabel,
    options: state.options.map(option => ({
      timesteps: option.timesteps,
      arrays: option.arrays.map(array => ({
        id: array.id,
        name: array.name,
        displayName: array.displayName,
        shape: [...array.shape],
        shapeLabel: array.shapeLabel,
        rowCount: array.rowCount,
      })),
    })),
    selected: state.selected,
    loading: state.loading,
    error: state.error,
    unmatched: state.unmatched.map(array => ({
      id: array.id,
      name: array.name,
      displayName: array.displayName,
      shape: [...array.shape],
      shapeLabel: array.shapeLabel,
      rowCount: array.rowCount,
    })),
    disabled: state.disabled.map(array => ({
      id: array.id,
      name: array.name,
      displayName: array.displayName,
      shape: [...array.shape],
      shapeLabel: array.shapeLabel,
      rowCount: array.rowCount,
    })),
    summary: { ...state.summary },
    lastUpdatedAt: state.lastUpdatedAt,
    lastUpdatedSource: state.lastUpdatedSource,
    preferredTimesteps: state.preferredTimesteps,
    runtimeTimesteps: state.runtimeTimesteps,
    analysisScope: state.analysisScope,
    recordingDuration: state.recordingDuration,
    playbackSpeed: state.playbackSpeed,
    playbackOriginalSpeed: state.playbackOriginalSpeed,
    saving: state.saving,
    saveError: state.saveError,
  };
}

export function subscribe(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('Listener must be a function');
  }
  listeners.add(listener);
  try {
    listener(getState());
  } catch (error) {
    console.error('[timeControls:settingsState] Initial listener error', error);
  }
  return () => {
    listeners.delete(listener);
  };
}

export default {
  initSettingsState,
  setActiveProject,
  syncProjectEntries,
  refreshActiveProject,
  isActiveProject,
  setSelectedTimesteps,
  setRuntimeTimesteps,
  setTimeControlPreferences,
  persistTimeControlSettings,
  getState,
  subscribe,
};
