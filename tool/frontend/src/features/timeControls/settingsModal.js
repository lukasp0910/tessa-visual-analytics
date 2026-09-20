import { closeModal, openModal } from '../../ui/modal.js';
import { clearChildren } from '../../ui/dom.js';
import {
  getState as getSettingsState,
  subscribe as subscribeToSettings,
  setSelectedTimesteps,
  setTimeControlPreferences,
  persistTimeControlSettings,
} from './settingsState.js';

const elements = {
  modal: null,
  backdrop: null,
  closeBtn: null,
  optionsList: null,
  unmatchedContainer: null,
  applyBtn: null,
  cancelBtn: null,
  analysisScope: null,
  recordingDuration: null,
  playbackSpeed: null,
  playbackOriginalContainer: null,
  playbackOriginalToggle: null,
  playbackOriginalValue: null,
};

let initialized = false;
let unsubscribe = null;
let modalOpen = false;
let pendingSelection = null;
let pendingPreferences = null;
let pendingPreferenceValidity = {
  recordingDuration: true,
  playbackSpeed: true,
};
let pendingProjectName = null;
let applyButtonDefaultLabel = null;
let originalSpeedEnabled = false;

function ensureElements() {
  if (initialized) return true;
  elements.modal = document.getElementById('timeControlSettingsModal');
  elements.backdrop = document.querySelector('[data-modal="time-control-settings-backdrop"]');
  elements.closeBtn = document.getElementById('timeControlSettingsModalClose');
  elements.optionsList = document.getElementById('timeControlSettingsOptionsList');
  elements.unmatchedContainer = document.getElementById('timeControlSettingsUnmatched');
  elements.applyBtn = document.getElementById('timeControlSettingsApply');
  elements.cancelBtn = document.getElementById('timeControlSettingsCancel');
  elements.analysisScope = document.getElementById('timeControlAnalysisScope');
  elements.recordingDuration = document.getElementById('timeControlRecordingDuration');
  elements.playbackSpeed = document.getElementById('timeControlPlaybackSpeed');
  elements.playbackOriginalContainer = document.getElementById('timeControlPlaybackOriginal');
  elements.playbackOriginalToggle = document.getElementById('timeControlPlaybackOriginalToggle');
  elements.playbackOriginalValue = document.getElementById('timeControlPlaybackOriginalValue');

  if (elements.applyBtn && applyButtonDefaultLabel == null) {
    const label = elements.applyBtn.textContent;
    applyButtonDefaultLabel = label && label.trim() ? label.trim() : 'Use selection';
  }

  initialized = Boolean(
    elements.modal
    && elements.backdrop
    && elements.closeBtn
    && elements.optionsList
    && elements.unmatchedContainer
    && elements.applyBtn
    && elements.cancelBtn
    && elements.analysisScope
    && elements.recordingDuration
    && elements.playbackSpeed
    && elements.playbackOriginalContainer
    && elements.playbackOriginalToggle
    && elements.playbackOriginalValue,
  );

  if (!initialized) {
    console.warn('[timeControls:settingsModal] Modal elements missing.');
    return false;
  }

  return true;
}

const DEFAULT_SCOPE = 'all';

function normalizeScope(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'matching') return 'matching';
  if (normalized === 'all') return 'all';
  return null;
}

function parseRecordingDuration(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function parsePlaybackSpeed(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function numericEquals(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(a, b);
  }
  return false;
}

function parseOriginalSpeedFlag(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 0) return false;
    if (value === 1) return true;
    return value > 0;
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (!text) return null;
    if (['true', '1', 'yes', 'on'].includes(text)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(text)) {
      return false;
    }
  }
  return null;
}

function buildPreferencesFromState(state) {
  const originalFlag = parseOriginalSpeedFlag(state.playbackOriginalSpeed);
  return {
    analysisScope: normalizeScope(state.analysisScope) ?? DEFAULT_SCOPE,
    recordingDuration: parseRecordingDuration(state.recordingDuration),
    playbackSpeed: parsePlaybackSpeed(state.playbackSpeed),
    playbackOriginalSpeed: originalFlag == null ? false : originalFlag,
  };
}

function ensurePendingPreferences(state) {
  const activeProject = state.projectName ?? null;
  if (!modalOpen) {
    pendingPreferences = buildPreferencesFromState(state);
    pendingPreferenceValidity = { recordingDuration: true, playbackSpeed: true };
    pendingProjectName = activeProject;
    originalSpeedEnabled = Boolean(pendingPreferences?.playbackOriginalSpeed);
    return;
  }

  if (!pendingPreferences || pendingProjectName !== activeProject) {
    pendingPreferences = buildPreferencesFromState(state);
    pendingPreferenceValidity = { recordingDuration: true, playbackSpeed: true };
    pendingProjectName = activeProject;
    originalSpeedEnabled = Boolean(pendingPreferences?.playbackOriginalSpeed);
  }
}

function getPendingPreferencesSnapshot(state) {
  ensurePendingPreferences(state);
  const currentScope = normalizeScope(state.analysisScope) ?? DEFAULT_SCOPE;
  const pendingScope = pendingPreferences ? normalizeScope(pendingPreferences.analysisScope) ?? DEFAULT_SCOPE : currentScope;
  const currentDuration = parseRecordingDuration(state.recordingDuration);
  const pendingDuration = pendingPreferences ? pendingPreferences.recordingDuration : currentDuration;
  const currentSpeed = parsePlaybackSpeed(state.playbackSpeed);
  const pendingSpeed = pendingPreferences ? pendingPreferences.playbackSpeed : currentSpeed;
  const currentOriginal = parseOriginalSpeedFlag(state.playbackOriginalSpeed);
  const normalizedCurrentOriginal = currentOriginal == null ? false : currentOriginal;
  const pendingOriginalFlag = pendingPreferences
    ? parseOriginalSpeedFlag(pendingPreferences.playbackOriginalSpeed)
    : currentOriginal;
  const normalizedPendingOriginal = pendingOriginalFlag == null ? false : pendingOriginalFlag;

  return {
    scope: pendingScope,
    currentScope,
    recordingDuration: pendingDuration,
    currentDuration,
    playbackSpeed: pendingSpeed,
    currentSpeed,
    playbackOriginalSpeed: normalizedPendingOriginal,
    currentPlaybackOriginalSpeed: normalizedCurrentOriginal,
    scopeChanged: pendingScope !== currentScope,
    durationChanged: !numericEquals(pendingDuration, currentDuration),
    speedChanged: !numericEquals(pendingSpeed, currentSpeed),
    originalSpeedChanged: normalizedPendingOriginal !== normalizedCurrentOriginal,
  };
}

function formatPlaybackSpeedValue(value) {
  if (!Number.isFinite(value)) return '';
  const text = value.toFixed(4).replace(/\.?0+$/, '');
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

function getSelectedTimestepsValue(state) {
  if (!state) return null;
  if (Number.isInteger(pendingSelection) && pendingSelection > 0) {
    return pendingSelection;
  }
  const candidate = Number.isInteger(state.selected) ? state.selected : null;
  return Number.isInteger(candidate) && candidate > 0 ? candidate : null;
}

function computeOriginalSpeedValue(state) {
  const timesteps = getSelectedTimestepsValue(state);
  if (!Number.isInteger(timesteps) || timesteps <= 0) {
    return null;
  }
  const snapshot = getPendingPreferencesSnapshot(state);
  const duration = snapshot.recordingDuration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  const speed = timesteps / duration;
  return Number.isFinite(speed) && speed > 0 ? speed : null;
}

function formatOriginalSpeedDisplay(value) {
  const formatted = formatPlaybackSpeedValue(value);
  return formatted || String(value);
}

function applyOriginalSpeedValue(value) {
  if (pendingPreferences) {
    pendingPreferences.playbackSpeed = value;
  }
  pendingPreferenceValidity.playbackSpeed = true;
  if (elements.playbackSpeed) {
    elements.playbackSpeed.value = formatPlaybackSpeedValue(value);
    elements.playbackSpeed.disabled = true;
    elements.playbackSpeed.removeAttribute('aria-invalid');
  }
  if (elements.playbackOriginalValue) {
    elements.playbackOriginalValue.textContent = `≈ ${formatOriginalSpeedDisplay(value)} steps/s`;
  }
}

function setOriginalSpeedEnabled(enabled, state) {
  if (!ensureElements()) return false;
  if (enabled) {
    const computed = computeOriginalSpeedValue(state);
    if (!Number.isFinite(computed) || computed <= 0) {
      if (elements.playbackOriginalToggle) {
        elements.playbackOriginalToggle.checked = false;
      }
      if (pendingPreferences) {
        pendingPreferences.playbackOriginalSpeed = false;
      }
      originalSpeedEnabled = false;
      return false;
    }
    originalSpeedEnabled = true;
    if (pendingPreferences) {
      pendingPreferences.playbackOriginalSpeed = true;
    }
    if (elements.playbackOriginalToggle) {
      elements.playbackOriginalToggle.checked = true;
    }
    applyOriginalSpeedValue(computed);
    return true;
  }
  originalSpeedEnabled = false;
  if (pendingPreferences) {
    pendingPreferences.playbackOriginalSpeed = false;
  }
  if (elements.playbackOriginalToggle) {
    elements.playbackOriginalToggle.checked = false;
  }
  if (elements.playbackSpeed) {
    elements.playbackSpeed.disabled = false;
  }
  return true;
}

function updateOriginalSpeedUI(state) {
  if (!elements.playbackOriginalContainer) return;
  const computed = computeOriginalSpeedValue(state);
  const available = Number.isFinite(computed) && computed > 0;
  if (!available) {
    elements.playbackOriginalContainer.classList.add('hidden');
    if (elements.playbackOriginalValue) {
      elements.playbackOriginalValue.textContent = '';
    }
    if (originalSpeedEnabled) {
      setOriginalSpeedEnabled(false, state);
    }
    return;
  }
  elements.playbackOriginalContainer.classList.remove('hidden');
  if (originalSpeedEnabled) {
    applyOriginalSpeedValue(computed);
    if (elements.playbackOriginalToggle && !elements.playbackOriginalToggle.checked) {
      elements.playbackOriginalToggle.checked = true;
    }
  } else {
    if (elements.playbackSpeed) {
      elements.playbackSpeed.disabled = false;
    }
    if (elements.playbackOriginalValue) {
      elements.playbackOriginalValue.textContent = `≈ ${formatOriginalSpeedDisplay(computed)} steps/s`;
    }
  }
}

function formatArrayLabel(array) {
  if (!array) return '';
  const base = array.displayName || array.name || array.id || 'Array';
  return array.shapeLabel ? `${base} · ${array.shapeLabel}` : base;
}

function renderEmptyState(message, { tone = 'muted' } = {}) {
  if (!elements.optionsList) return;
  clearChildren(elements.optionsList);
  const wrapper = document.createElement('div');
  wrapper.className = 'rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center';
  const text = document.createElement('p');
  text.className = tone === 'error' ? 'text-sm text-red-600' : 'text-sm text-slate-500';
  text.textContent = message;
  wrapper.appendChild(text);
  elements.optionsList.appendChild(wrapper);
}

function updatePendingSelection(state) {
  const available = new Set(state.options.map(option => option.timesteps));
  if (!modalOpen) {
    pendingSelection = state.selected ?? null;
    return;
  }
  if (pendingSelection != null && available.has(pendingSelection)) {
    return;
  }
  pendingSelection = state.selected ?? null;
}

function renderPreferences(state) {
  if (!ensureElements()) return;
  ensurePendingPreferences(state);

  const snapshot = getPendingPreferencesSnapshot(state);

  if (elements.analysisScope) {
    elements.analysisScope.value = snapshot.scope;
  }

  if (elements.recordingDuration) {
    const value = snapshot.recordingDuration;
    elements.recordingDuration.value = value != null ? String(value) : '';
    if (pendingPreferenceValidity.recordingDuration) {
      elements.recordingDuration.removeAttribute('aria-invalid');
    } else {
      elements.recordingDuration.setAttribute('aria-invalid', 'true');
    }
  }

  if (elements.playbackSpeed) {
    const value = snapshot.playbackSpeed;
    elements.playbackSpeed.value = value != null ? String(value) : '';
    if (pendingPreferenceValidity.playbackSpeed) {
      elements.playbackSpeed.removeAttribute('aria-invalid');
    } else {
      elements.playbackSpeed.setAttribute('aria-invalid', 'true');
    }
  }

  originalSpeedEnabled = Boolean(snapshot.playbackOriginalSpeed);
  if (pendingPreferences) {
    pendingPreferences.playbackOriginalSpeed = originalSpeedEnabled;
  }
  updateOriginalSpeedUI(state);
}

function renderOptions(state) {
  if (!elements.optionsList) return;
  clearChildren(elements.optionsList);

  if (!state.projectName) {
    renderEmptyState('Select a project to explore available timesteps.');
    return;
  }
  if (state.loading) {
    renderEmptyState('Scanning arrays for available timesteps…');
    return;
  }
  if (state.error) {
    renderEmptyState(state.error, { tone: 'error' });
    return;
  }
  if (!state.options.length) {
    renderEmptyState('No matching timestep groups were detected yet.');
    return;
  }

  state.options.forEach((option, index) => {
    const label = document.createElement('label');
    label.className = 'flex w-full cursor-pointer items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm transition hover:border-slate-300 hover:shadow-sm focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-200';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'timeControlTimesteps';
    radio.value = String(option.timesteps);
    radio.className = 'h-4 w-4 flex-shrink-0 text-blue-600 focus:ring-blue-500';
    if (pendingSelection === option.timesteps) {
      radio.checked = true;
    }
    if (index === 0) {
      radio.setAttribute('data-modal-autofocus', 'true');
    }
    radio.addEventListener('change', () => {
      pendingSelection = option.timesteps;
      const state = getSettingsState();
      ensurePendingPreferences(state);
      updateOriginalSpeedUI(state);
      updateApplyState(state);
    });

    const body = document.createElement('div');
    body.className = 'flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1';

    const heading = document.createElement('span');
    heading.className = 'font-semibold text-slate-900';
    heading.textContent = `${option.timesteps.toLocaleString()} ${option.timesteps === 1 ? 'timestep' : 'timesteps'}`;

    const meta = document.createElement('span');
    meta.className = 'text-xs font-medium text-slate-600';
    meta.textContent = option.arrays.length === 1
      ? 'Matches 1 array'
      : `Matches ${option.arrays.length} arrays`;

    body.appendChild(heading);
    body.appendChild(meta);

    if (option.arrays.length) {
      const list = document.createElement('ul');
      list.className = 'flex flex-wrap gap-1.5';
      option.arrays.forEach(array => {
        const item = document.createElement('li');
        item.className = 'inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700';
        item.textContent = formatArrayLabel(array);
        list.appendChild(item);
      });
      body.appendChild(list);
    }

    label.appendChild(radio);
    label.appendChild(body);
    elements.optionsList.appendChild(label);
  });
}

function renderUnmatched(state) {
  if (!elements.unmatchedContainer) return;
  clearChildren(elements.unmatchedContainer);

  const sections = [];

  if (state.unmatched.length) {
    const section = document.createElement('div');
    section.className = 'rounded-xl border border-amber-200 bg-amber-50 px-3 py-2';
    const title = document.createElement('p');
    title.className = 'text-xs font-semibold text-amber-800';
    title.textContent = 'Arrays without a detectable row count';
    const list = document.createElement('ul');
    list.className = 'mt-1 flex flex-wrap gap-1.5';
    state.unmatched.forEach(array => {
      const item = document.createElement('li');
      item.className = 'inline-flex items-center rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-amber-700';
      item.textContent = formatArrayLabel(array);
      list.appendChild(item);
    });
    section.appendChild(title);
    section.appendChild(list);
    sections.push(section);
  }

  if (state.disabled.length) {
    const section = document.createElement('div');
    section.className = 'rounded-xl border border-slate-200 bg-slate-100 px-3 py-2';
    const title = document.createElement('p');
    title.className = 'text-xs font-semibold text-slate-700';
    title.textContent = 'Hidden arrays (excluded from aggregation)';
    const list = document.createElement('ul');
    list.className = 'mt-1 flex flex-wrap gap-1.5';
    state.disabled.forEach(array => {
      const item = document.createElement('li');
      item.className = 'inline-flex items-center rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600';
      item.textContent = formatArrayLabel(array);
      list.appendChild(item);
    });
    section.appendChild(title);
    section.appendChild(list);
    sections.push(section);
  }

  if (!sections.length) {
    elements.unmatchedContainer.classList.add('hidden');
    return;
  }

  elements.unmatchedContainer.classList.remove('hidden');
  sections.forEach(section => elements.unmatchedContainer.appendChild(section));
}

function updateApplyState(state) {
  if (!elements.applyBtn) return;
  const selectionValid = pendingSelection != null
    && state.options.some(option => option.timesteps === pendingSelection);
  const snapshot = getPendingPreferencesSnapshot(state);
  const hasPreferenceChanges = snapshot.scopeChanged
    || snapshot.durationChanged
    || snapshot.speedChanged
    || snapshot.originalSpeedChanged;
  const timestepsChanged = selectionValid && pendingSelection !== state.selected;
  const hasChanges = timestepsChanged || hasPreferenceChanges;

  const disabled = !modalOpen
    || state.loading
    || state.error
    || state.saving
    || !selectionValid
    || !hasChanges
    || !pendingPreferenceValidity.recordingDuration
    || !pendingPreferenceValidity.playbackSpeed;
  elements.applyBtn.disabled = disabled;
}

function handleScopeChange(event) {
  const state = getSettingsState();
  ensurePendingPreferences(state);
  const value = event?.target?.value;
  const nextScope = normalizeScope(value) ?? DEFAULT_SCOPE;
  if (pendingPreferences) {
    pendingPreferences.analysisScope = nextScope;
  }
  updateApplyState(state);
}

function handleRecordingDurationInput(event) {
  const state = getSettingsState();
  ensurePendingPreferences(state);
  const input = event?.target;
  if (!input) return;
  const raw = typeof input.value === 'string' ? input.value : '';
  const trimmed = raw.trim();
  if (!trimmed) {
    if (pendingPreferences) {
      pendingPreferences.recordingDuration = null;
    }
    pendingPreferenceValidity.recordingDuration = true;
    input.removeAttribute('aria-invalid');
    if (originalSpeedEnabled) {
      setOriginalSpeedEnabled(false, state);
    }
  } else {
    const parsed = parseRecordingDuration(trimmed);
    const valid = parsed != null;
    pendingPreferenceValidity.recordingDuration = valid;
    if (valid && pendingPreferences) {
      pendingPreferences.recordingDuration = parsed;
      input.removeAttribute('aria-invalid');
      updateOriginalSpeedUI(state);
    } else if (!valid) {
      input.setAttribute('aria-invalid', 'true');
      if (originalSpeedEnabled) {
        setOriginalSpeedEnabled(false, state);
      }
    }
  }
  updateOriginalSpeedUI(state);
  updateApplyState(state);
}

function handlePlaybackSpeedInput(event) {
  const state = getSettingsState();
  ensurePendingPreferences(state);
  const input = event?.target;
  if (!input) return;
  const raw = typeof input.value === 'string' ? input.value : '';
  const trimmed = raw.trim();
  if (!trimmed) {
    if (pendingPreferences) {
      pendingPreferences.playbackSpeed = null;
    }
    pendingPreferenceValidity.playbackSpeed = true;
    input.removeAttribute('aria-invalid');
  } else {
    const parsed = parsePlaybackSpeed(trimmed);
    const valid = parsed != null;
    pendingPreferenceValidity.playbackSpeed = valid;
    if (valid && pendingPreferences) {
      pendingPreferences.playbackSpeed = parsed;
      input.removeAttribute('aria-invalid');
    } else if (!valid) {
      input.setAttribute('aria-invalid', 'true');
    }
  }
  updateApplyState(state);
}

function handleOriginalSpeedToggle(event) {
  const state = getSettingsState();
  ensurePendingPreferences(state);
  const checked = Boolean(event?.target?.checked);
  if (checked) {
    const enabled = setOriginalSpeedEnabled(true, state);
    if (!enabled && event?.target) {
      event.target.checked = false;
    }
  } else {
    setOriginalSpeedEnabled(false, state);
  }
  updateOriginalSpeedUI(state);
  updateApplyState(state);
}

function renderState(state) {
  if (!ensureElements()) return;

  updatePendingSelection(state);
  ensurePendingPreferences(state);
  if (elements.applyBtn) {
    const label = state.saving
      ? 'Saving…'
      : applyButtonDefaultLabel || 'Use selection';
    elements.applyBtn.textContent = label;
    if (state.saving) {
      elements.applyBtn.setAttribute('aria-busy', 'true');
    } else {
      elements.applyBtn.removeAttribute('aria-busy');
    }
  }

  renderPreferences(state);
  renderOptions(state);
  renderUnmatched(state);
  updateApplyState(state);
}

function handleClose() {
  if (!ensureElements()) return;
  closeModal(elements.modal);
  modalOpen = false;
  pendingSelection = null;
  pendingPreferences = null;
  pendingPreferenceValidity = { recordingDuration: true, playbackSpeed: true };
  pendingProjectName = null;
  if (elements.recordingDuration) {
    elements.recordingDuration.removeAttribute('aria-invalid');
  }
  if (elements.playbackSpeed) {
    elements.playbackSpeed.removeAttribute('aria-invalid');
    elements.playbackSpeed.disabled = false;
  }
  if (elements.playbackOriginalToggle) {
    elements.playbackOriginalToggle.checked = false;
  }
  if (elements.playbackOriginalContainer) {
    elements.playbackOriginalContainer.classList.add('hidden');
  }
  if (elements.playbackOriginalValue) {
    elements.playbackOriginalValue.textContent = '';
  }
  originalSpeedEnabled = false;
}

async function handleApply() {
  if (!modalOpen) return;
  if (!pendingPreferenceValidity.recordingDuration || !pendingPreferenceValidity.playbackSpeed) {
    return;
  }
  const state = getSettingsState();
  const selectionValid = pendingSelection != null
    && state.options.some(option => option.timesteps === pendingSelection);
  if (!selectionValid) {
    return;
  }
  const snapshot = getPendingPreferencesSnapshot(state);
  const timestepsChanged = pendingSelection !== state.selected;
  const preferenceChanges = snapshot.scopeChanged
    || snapshot.durationChanged
    || snapshot.speedChanged
    || snapshot.originalSpeedChanged;
  if (!timestepsChanged && !preferenceChanges) {
    return;
  }

  const selectionApplied = setSelectedTimesteps(pendingSelection);
  if (!selectionApplied) {
    return;
  }
  setTimeControlPreferences({
    analysisScope: snapshot.scope,
    recordingDuration: snapshot.recordingDuration,
    playbackSpeed: snapshot.playbackSpeed,
    playbackOriginalSpeed: snapshot.playbackOriginalSpeed,
  });
  try {
    await persistTimeControlSettings({
      timesteps: pendingSelection,
      analysisScope: snapshot.scope,
      recordingDuration: snapshot.recordingDuration,
      playbackSpeed: snapshot.playbackSpeed,
      playbackOriginalSpeed: snapshot.playbackOriginalSpeed,
    });
    handleClose();
  } catch (error) {
    console.warn('[timeControls:settingsModal] Failed to persist time control settings', error);
  }
}

function attachEventListeners() {
  if (!ensureElements()) return;
  elements.closeBtn.addEventListener('click', handleClose);
  elements.cancelBtn.addEventListener('click', handleClose);
  elements.applyBtn.addEventListener('click', handleApply);
  elements.analysisScope.addEventListener('change', handleScopeChange);
  elements.recordingDuration.addEventListener('input', handleRecordingDurationInput);
  elements.recordingDuration.addEventListener('change', handleRecordingDurationInput);
  elements.playbackSpeed.addEventListener('input', handlePlaybackSpeedInput);
  elements.playbackSpeed.addEventListener('change', handlePlaybackSpeedInput);
  elements.playbackOriginalToggle.addEventListener('change', handleOriginalSpeedToggle);
  elements.backdrop.addEventListener('click', event => {
    if (event.target === elements.backdrop) {
      handleClose();
    }
  });
  elements.modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      handleClose();
    }
  });
}

export function initTimeControlSettingsModal() {
  if (!ensureElements()) {
    return;
  }
  if (unsubscribe) {
    return;
  }
  attachEventListeners();
  unsubscribe = subscribeToSettings(renderState);
}

export function openTimeControlSettingsModal() {
  if (!ensureElements()) {
    return;
  }
  const state = getSettingsState();
  modalOpen = true;
  updatePendingSelection(state);
  renderState(state);
  openModal(elements.modal);
}

export default {
  initTimeControlSettingsModal,
  openTimeControlSettingsModal,
};
