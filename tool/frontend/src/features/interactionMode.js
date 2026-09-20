import { fetchInteractionMode, updateInteractionMode } from '../api/uiState.js';
import { getSnapshot, setUiFlag, subscribe } from '../state/store.js';
import { byId } from '../ui/dom.js';

const FEATURE_NAME = 'interactionMode';
const VALID_MODES = ['explore', 'edit'];

const state = {
  initialized: false,
  pending: false,
  unsubscribe: null,
};

const elements = {
  root: null,
  buttons: [],
};

function cacheElements() {
  elements.root = byId('interactionModeToggle');
  elements.buttons = elements.root
    ? Array.from(elements.root.querySelectorAll('[data-mode]'))
    : [];
}

function normalizeMode(mode) {
  const text = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  return VALID_MODES.includes(text) ? text : 'explore';
}

function setButtonsDisabled(isDisabled) {
  elements.buttons.forEach(button => {
    button.disabled = Boolean(isDisabled);
    button.setAttribute('aria-disabled', String(Boolean(isDisabled)));
  });
}

function renderActiveMode(mode) {
  const normalized = normalizeMode(mode);
  elements.buttons.forEach(button => {
    const targetMode = button.dataset.mode;
    const isActive = targetMode === normalized;
    button.classList.toggle('bg-white', isActive);
    button.classList.toggle('text-gray-900', isActive);
    button.classList.toggle('shadow-sm', isActive);
    button.classList.toggle('text-gray-500', !isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

async function syncModeWithServer() {
  try {
    const payload = await fetchInteractionMode();
    const mode = normalizeMode(payload?.mode);
    if (mode !== getSnapshot().ui.interactionMode) {
      setUiFlag('interactionMode', mode);
    }
  } catch (error) {
    console.warn(`[features:${FEATURE_NAME}] Failed to load interaction mode`, error);
  }
}

async function persistMode(mode) {
  const target = normalizeMode(mode);
  try {
    state.pending = true;
    setButtonsDisabled(true);
    const response = await updateInteractionMode(target);
    const nextMode = normalizeMode(response?.mode);
    setUiFlag('interactionMode', nextMode);
  } catch (error) {
    console.error(`[features:${FEATURE_NAME}] Failed to update interaction mode`, error);
    // Re-render current snapshot to keep UI consistent.
    renderActiveMode(getSnapshot().ui.interactionMode);
  } finally {
    state.pending = false;
    setButtonsDisabled(false);
  }
}

function handleSnapshot(snapshot) {
  if (!snapshot || !snapshot.ui) return;
  renderActiveMode(snapshot.ui.interactionMode);
}

function handleToggleClick(event) {
  const target = event.target.closest('[data-mode]');
  if (!target || state.pending) return;
  const mode = normalizeMode(target.dataset.mode);
  const currentMode = normalizeMode(getSnapshot().ui.interactionMode);
  if (mode === currentMode) return;
  persistMode(mode);
}

function bindEvents() {
  if (!elements.root) return;
  elements.root.addEventListener('click', handleToggleClick);
}

export function init() {
  if (state.initialized) return;
  cacheElements();
  if (!elements.root) {
    console.warn(`[features:${FEATURE_NAME}] Toggle root element not found.`);
    return;
  }
  bindEvents();
  state.unsubscribe = subscribe(handleSnapshot);
  handleSnapshot(getSnapshot());
  syncModeWithServer();
  state.initialized = true;
}

export default { init };
