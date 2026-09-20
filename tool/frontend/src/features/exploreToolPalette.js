import { getSnapshot, subscribe } from '../state/store.js';
import { byId, toggleHidden } from '../ui/dom.js';
import { openTemporalFocusModal } from './timeControls/temporalFocusModal.js';
import { openSubjectSelectorModal } from './subjectSelector.js';
import { subscribe as subscribeToTimeRangeFilter, getActiveDomain as getActiveTimeRangeDomain } from '../state/timeRangeFilter.js';

const FEATURE_NAME = 'exploreToolPalette';

const state = {
  initialized: false,
  unsubscribe: null,
  unsubscribeTimeRange: null,
  activeSheetId: null,
};

const elements = {
  root: null,
  divider: null,
  toolButtons: [],
};

function cacheElements() {
  elements.root = byId('exploreToolPalette');
  elements.divider = byId('exploreToolPaletteDivider');
  elements.toolButtons = elements.root
    ? Array.from(elements.root.querySelectorAll('[data-tool-button]'))
    : [];
}

function updateTemporalFocusButton() {
  const button = elements.toolButtons.find(btn => btn.dataset.tool === 'time-focus');
  if (!button) return;

  const hasActiveFilter = state.activeSheetId && getActiveTimeRangeDomain(state.activeSheetId);
  button.classList.toggle('explore-tool-button--active', !!hasActiveFilter);
}

function setToolbarInteractivity(isEnabled) {
  elements.toolButtons.forEach(button => {
    button.tabIndex = isEnabled ? 0 : -1;
    button.setAttribute('aria-disabled', isEnabled ? 'false' : 'true');
    button.toggleAttribute('disabled', !isEnabled);
  });
}

function renderMode(mode) {
  const activeMode = typeof mode === 'string' ? mode.toLowerCase() : '';
  const isExplore = activeMode === 'explore';
  toggleHidden(elements.root, !isExplore);
  toggleHidden(elements.divider, !isExplore);
  if (elements.root) {
    elements.root.setAttribute('aria-hidden', isExplore ? 'false' : 'true');
  }
  setToolbarInteractivity(isExplore);
}

function handleSnapshot(snapshot) {
  if (!snapshot || !snapshot.ui) return;
  renderMode(snapshot.ui.interactionMode);
}

function handleTimeRangeChange(domain) {
  updateTemporalFocusButton();
}

function handleToolButtonClick(event) {
  const button = event.target.closest('[data-tool-button]');
  if (!button || !elements.root?.contains(button)) return;
  const tool = button.dataset.tool;
  if (tool === 'time-focus') {
    event.preventDefault();
    openTemporalFocusModal();
    button.setAttribute('aria-pressed', 'false');
    return;
  }
  if (tool === 'subject-selector') {
    event.preventDefault();
    openSubjectSelectorModal();
    button.setAttribute('aria-pressed', 'false');
    return;
  }
  const isToggleable = button.dataset.toggle !== 'false';
  if (isToggleable) {
    const nextState = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', nextState ? 'true' : 'false');
  } else {
    button.classList.add('animate-pulse');
    window.setTimeout(() => {
      button.classList.remove('animate-pulse');
    }, 300);
  }
}

function bindEvents() {
  if (elements.root) {
    elements.root.addEventListener('click', handleToolButtonClick);
  }
}

function setActiveSheetContext(sheetId) {
  const normalized = typeof sheetId === 'string' && sheetId.trim() ? sheetId.trim() : null;
  if (state.activeSheetId === normalized) return;

  if (state.unsubscribeTimeRange) {
    state.unsubscribeTimeRange();
    state.unsubscribeTimeRange = null;
  }

  state.activeSheetId = normalized;

  if (state.activeSheetId) {
    state.unsubscribeTimeRange = subscribeToTimeRangeFilter(state.activeSheetId, handleTimeRangeChange);
  }

  updateTemporalFocusButton();
}

export function init() {
  if (state.initialized) return;
  cacheElements();
  if (!elements.root) {
    console.warn(`[features:${FEATURE_NAME}] Palette root element not found.`);
    return;
  }
  bindEvents();
  state.unsubscribe = subscribe(handleSnapshot);
  handleSnapshot(getSnapshot());
  state.initialized = true;

  // Watch for sheet selection changes
  document.addEventListener('sheet:selected', event => {
    const sheetId = event?.detail?.sheetId ?? null;
    setActiveSheetContext(sheetId);
  });

  document.addEventListener('sheet:deleted', event => {
    const sheetId = event?.detail?.sheetId ?? null;
    if (sheetId && state.activeSheetId && sheetId === state.activeSheetId) {
      setActiveSheetContext(null);
    }
  });
}

export default { init };
