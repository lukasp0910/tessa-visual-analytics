import { showConfirmationDialog } from '../ui/confirm.js';
import { byId } from '../ui/dom.js';
import { openCardConfigurator } from './cardConfigurator.js';
import {
  sanitizeText,
  summarizeConfiguration,
} from './cards/cardsSanitizers.js';
import {
  DEFAULT_CARD_ROWS,
  DEFAULT_CARD_COLUMNS,
  findLargestEmptyRectangle,
  updateCardElementPosition,
} from './cards/cardsLayout.js';
import {
  setupCardVisualization,
  teardownCardVisualization,
  teardownAllCardVisualizations,
  resetCardVisualization,
  toggleScatterAutoRotation,
  getScatterAutoRotationState,
  toggleScatterRenderMode,
  getScatterRenderMode,
  // Performance Mode + rotation state
  getScatterPerformanceMode,
  setScatterPerformanceMode,
  toggleScatterPerformanceMode,
  getScatterRotationActive,
  getLineChartFocusRange,
  // Filtered visibility (applies to both TimeRangeFilter and Point Selection)
  getScatterFilteredVisibilityMode,
  setScatterFilteredVisibilityMode,
  toggleScatterFilteredVisibilityMode,
  // Chart instance accessor
  getCardChart,
  // Selection toolbox (in-chart overlay) visibility
  getScatterSelectionToolbarVisible,
  toggleScatterSelectionToolbarVisible,
  // PCA overlay visibility helpers
  getScatterPcaOverlayVisible,
  toggleScatterPcaOverlayVisible,
  // UMAP overlay visibility helpers
  getScatterUmapOverlayVisible,
  toggleScatterUmapOverlayVisible,
  ensureScatterUmapOverlay,
  destroyScatterUmapOverlay,
  // T-SNE overlay visibility helpers
  getScatterTsneOverlayVisible,
  toggleScatterTsneOverlayVisible,
  setScatterReductionMethod,
} from './cards/cardsVisualization.js';
import { setTimeRange } from '../state/timeRangeFilter.js';
import { getSnapshot } from '../state/store.js';

// Supported dimensionality reduction methods
const REDUCTION_METHODS = ['pca', 'umap', 'tsne'];
import {
  FEATURE_NAME,
  initCardsState,
  isInitialized,
  setInitialized,
  getMode,
  isEditMode,
  getProjectName,
  getSheetId,
  getRowCount,
  getColumnCount,
  getCards,
  getActiveCardId,
  isPersistPending,
  generateCardId,
  appendCard,
  removeCardAt,
  applySheetSelection,
  applySheetDeletion,
  getCardConfiguration,
  setCardConfiguration,
  ensureCardConfiguration,
  setActiveCard,
  persistCards,
} from './cards/cardsState.js';
import createCardsInteractions from './cards/cardsInteractions.js';

const elements = {
  grid: null,
  layer: null,
  addButton: null,
  editButton: null,
  deleteButton: null,
};

const cardElements = new Map();
let interactions = null;

// Track sampling slider visibility state per card
const samplingSliderVisible = new Map();
// Track clustering panel visibility and persisted form values per card
const clusteringPanelVisible = new Map();
const clusteringParams = new Map();

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (!text) return false;
    if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  }
  return false;
}

function setSelectionToolboxButtonState(button, visible = false) {
  if (!button) return;
  const isOn = !!visible;
  button.classList.toggle('border-blue-400', isOn);
  button.classList.toggle('text-blue-500', isOn);
  button.classList.toggle('text-gray-600', !isOn);
  button.setAttribute('aria-pressed', isOn ? 'true' : 'false');
}

function setClusteringButtonState(button, visible = false) {
  if (!button) return;
  const isOn = !!visible;
  button.classList.toggle('border-blue-400', isOn);
  button.classList.toggle('text-blue-500', isOn);
  button.classList.toggle('text-gray-600', !isOn);
  button.setAttribute('aria-pressed', isOn ? 'true' : 'false');
}

function setScatterModeButtonState(button, mode) {
  if (!button) return;
  const isLine = mode === 'line';
  const targetMode = isLine ? 'points' : 'line';
  const label = targetMode === 'line' ? 'Switch to Line Mode' : 'Switch to Points Mode';
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  // Icon shows target mode
  const icon =
    targetMode === 'line'
      ? '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" class="h-[14px] w-[14px]"><polyline points="2,14 7,9 12,12 18,6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="h-[14px] w-[14px]"><circle cx="6" cy="6" r="1.6"/><circle cx="13" cy="5" r="1.2"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="13" r="1.6"/></svg>';
  button.innerHTML = icon;
}

// Performance button always shown as neutral (no active state)
function setPerformanceButtonState(button, { active = false, disabled = false } = {}) {
  if (!button) return;
  button.disabled = false;
  button.classList.remove('border-blue-400');
  button.classList.remove('text-blue-500');
  button.classList.add('text-gray-600');
  button.classList.remove('opacity-60');
  button.style.cursor = 'pointer';
  const title = 'Performance Mode';
  button.setAttribute('title', title);
  button.setAttribute('aria-label', title);
  button.setAttribute('aria-pressed', 'false');
}

function setReductionSettingsButtonState(button, { enabled = false, active = false, method = '' } = {}) {
  if (!button) return;
  const isEnabled = !!enabled;
  const isActive = isEnabled && !!active;
  const normalizedMethod = typeof method === 'string' ? method.toLowerCase() : '';
  const methodLabelMap = {
    pca: 'PCA',
    umap: 'UMAP',
    tsne: 't-SNE',
  };
  const methodLabel = methodLabelMap[normalizedMethod] || (method ? method.toUpperCase() : 'reduction');

  button.disabled = !isEnabled;
  button.classList.toggle('border-blue-400', isActive);
  button.classList.toggle('text-blue-500', isActive);
  button.classList.toggle('text-gray-600', !isActive);
  button.classList.toggle('opacity-50', !isEnabled);
  button.classList.toggle('cursor-not-allowed', !isEnabled);
  button.classList.toggle('cursor-pointer', isEnabled);
  button.setAttribute('aria-pressed', isActive ? 'true' : 'false');

  let title;
  if (!isEnabled) {
    title = `${methodLabel} settings unavailable`;
  } else {
    title = isActive
      ? `Hide ${methodLabel} settings`
      : `Show ${methodLabel} settings`;
  }
  button.setAttribute('title', title);
  button.setAttribute('aria-label', title);
}

function setAutorotateButtonState(button, enabled) {
  if (!button) return;
  const isOn = !!enabled;
  button.classList.toggle('border-blue-400', isOn);
  button.classList.toggle('text-blue-500', isOn);
  button.classList.toggle('text-gray-600', !isOn);
  button.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  const title = isOn ? 'Disable autorotation' : 'Enable autorotation';
  button.setAttribute('title', title);
  button.setAttribute('aria-label', title);
}

function setFilteredVisibilityButtonState(button, mode = 'grey', rangeActive = false) {
  if (!button) return;
  const isHide = mode === 'hide';
  button.classList.toggle('border-blue-400', isHide);
  button.classList.toggle('text-blue-500', isHide);
  button.classList.toggle('text-gray-600', !isHide);
  button.setAttribute('aria-pressed', isHide ? 'true' : 'false');
  const title = isHide ? 'Show greyed out-of-range points' : 'Hide out-of-range points';
  button.setAttribute('title', title);
  button.setAttribute('aria-label', title);
  const eyeIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" class="h-[14px] w-[14px]"><path stroke-linecap="round" stroke-linejoin="round" d="M1.5 10s3.5-6 8.5-6 8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6z"/><circle cx="10" cy="10" r="2.4"/></svg>';
  const eyeOffIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" class="h-[14px] w-[14px]"><path stroke-linecap="round" stroke-linejoin="round" d="M3.5 3.5l13 13"/><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 13.5c1.1-1.1 2-2.4 2.5-3.5 0 0-3.5-6-8.5-6-1.3 0-2.6.4-3.7 1"/><path stroke-linecap="round" stroke-linejoin="round" d="M6.2 6.2C4 7.6 2.5 10 2.5 10s3.5 6 8.5 6c1.4 0 2.8-.4 4-1.1"/><path stroke-linecap="round" stroke-linejoin="round" d="M12.5 12.5a2.5 2.5 0 01-3.5-3.5"/></svg>';
  button.innerHTML = isHide ? eyeOffIcon : eyeIcon;

  // Hide when no active range
  button.classList.toggle('hidden', !rangeActive);
  button.disabled = !rangeActive;
  button.setAttribute('aria-hidden', rangeActive ? 'false' : 'true');
}

function setLineAggregateButtonState(button, active = false) {
  if (!button) return;
  const isOn = !!active;
  button.classList.toggle('border-blue-400', isOn);
  button.classList.toggle('text-blue-500', isOn);
  button.classList.toggle('text-gray-600', !isOn);
  button.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  const title = isOn ? 'Show all individual measures' : 'Show mean with range band';
  button.setAttribute('title', title);
  button.setAttribute('aria-label', title);
}

function normalizeScatterFieldValues(detail) {
  const fieldValues = detail?.fieldValues && typeof detail.fieldValues === 'object'
    ? detail.fieldValues
    : {};

  const columns = Array.isArray(fieldValues.columns)
    ? fieldValues.columns.map(value => (typeof value === 'string' ? value.trim() : value)).filter(Boolean)
    : [];
  const dimension = Number(fieldValues.dimension) === 3 ? 3 : 2;
  const reductionText = (fieldValues.reduction || '').toString().trim().toLowerCase();
  const reduction = REDUCTION_METHODS.includes(reductionText) ? reductionText : '';
  const multiSubject = normalizeBoolean(fieldValues.multiSubject ?? fieldValues.multi_subject);

  return { columns, dimension, reduction, multiSubject };
}

function updateScatterFieldValues(cardId, updater) {
  if (typeof updater !== 'function') return;

  const detail = getCardConfiguration(cardId);
  if (!detail) return;

  const nextFieldValues = { ...(detail.fieldValues || {}) };
  const normalized = normalizeScatterFieldValues(detail);
  nextFieldValues.columns = [...normalized.columns];
  nextFieldValues.dimension = normalized.dimension;
  nextFieldValues.reduction = normalized.reduction;
  nextFieldValues.multiSubject = Boolean(nextFieldValues.multiSubject ?? normalized.multiSubject);

  updater(nextFieldValues);

  nextFieldValues.multiSubject = normalizeBoolean(nextFieldValues.multiSubject);

  if (nextFieldValues.columns.length > nextFieldValues.dimension && !nextFieldValues.reduction) {
    nextFieldValues.reduction = 'pca';
  }
  if (nextFieldValues.columns.length <= nextFieldValues.dimension) {
    nextFieldValues.reduction = '';
  }

  const nextDetail = { ...detail, fieldValues: nextFieldValues };
  const stored = setCardConfiguration(cardId, nextDetail);
  if (stored) {
    persistAndRefresh();
  }
}

function renderScatterHeaderControls(element, cardId, detail) {
  const dimensionHost = element.querySelector('[data-scatter-dimension-control]');
  const reductionHost = element.querySelector('[data-scatter-reduction-control]');
  if (!dimensionHost || !reductionHost) return;

  dimensionHost.innerHTML = '';
  reductionHost.innerHTML = '';

  const chartType = (detail?.chartType || '').toString().trim().toLowerCase();
  const { columns, dimension, reduction } = normalizeScatterFieldValues(detail);
  const isScatter = chartType === 'scatter';

  dimensionHost.classList.toggle('hidden', !isScatter);
  reductionHost.classList.toggle('hidden', !isScatter);

  if (!isScatter) return;

  const dimensionLabel = document.createElement('span');
  dimensionLabel.className = 'text-[11px] leading-4 text-gray-600';
  dimensionLabel.textContent = 'View:';

  const dimensionSelect = document.createElement('select');
  dimensionSelect.className = [
    'h-6 rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-700 shadow-sm',
    'focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500',
  ].join(' ');
  dimensionSelect.setAttribute('aria-label', 'Scatter plot dimensionality');

  [
    { value: '2', label: '2D' },
    { value: '3', label: '3D' },
  ].forEach(option => {
    const optEl = document.createElement('option');
    optEl.value = option.value;
    optEl.textContent = option.label;
    optEl.selected = dimension === Number(option.value);
    dimensionSelect.append(optEl);
  });

  dimensionSelect.addEventListener('pointerdown', event => event.stopPropagation());
  dimensionSelect.addEventListener('change', event => {
    const nextValue = Number.parseInt(event.target.value, 10) === 3 ? 3 : 2;
    updateScatterFieldValues(cardId, next => {
      next.dimension = nextValue;
    });
  });

  const supportsThreeDimensions = columns.length >= 3;
  if (!supportsThreeDimensions) {
    const tooltip = '3D view unavailable: this data source exposes only two dimensions.';
    if (dimension === 3) {
      updateScatterFieldValues(cardId, next => {
        next.dimension = 2;
      });
    }
    dimensionSelect.value = '2';
    dimensionSelect.disabled = true;
    dimensionSelect.setAttribute('aria-disabled', 'true');
    dimensionSelect.setAttribute('title', tooltip);
    dimensionLabel.setAttribute('title', tooltip);
    dimensionSelect.classList.add('cursor-not-allowed', 'bg-gray-100', 'text-gray-500', 'opacity-70');
  } else {
    dimensionSelect.disabled = false;
    dimensionSelect.removeAttribute('aria-disabled');
    dimensionSelect.removeAttribute('title');
    dimensionLabel.removeAttribute('title');
    dimensionSelect.classList.remove('cursor-not-allowed', 'bg-gray-100', 'text-gray-500', 'opacity-70');
  }

  dimensionHost.appendChild(dimensionLabel);
  dimensionHost.appendChild(dimensionSelect);

  const needsReduction = columns.length > dimension;
  reductionHost.classList.toggle('hidden', !needsReduction);
  if (!needsReduction) return;

  const reductionGroup = document.createElement('div');
  reductionGroup.className = 'flex items-center gap-2';

  let reductionSelect = null;
  let settingsButton = null;

  if (needsReduction) {
    const reductionLabel = document.createElement('span');
    reductionLabel.className = 'text-[11px] leading-4 text-gray-600';
    reductionLabel.textContent = 'Reduction:';

    reductionSelect = document.createElement('select');
    reductionSelect.className = [
      'h-6 rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-700 shadow-sm',
      'focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500',
    ].join(' ');
    reductionSelect.setAttribute('aria-label', 'Dimensionality reduction method');

    REDUCTION_METHODS.forEach(method => {
      const option = document.createElement('option');
      option.value = method;
      option.textContent = method.toUpperCase();
      option.selected = (!reduction && method === 'pca') || reduction === method;
      reductionSelect.append(option);
    });

    settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.dataset.reductionSettingsToggle = 'true';
    settingsButton.className = [
      'inline-flex h-6 w-6 items-center justify-center rounded-md border border-gray-300 bg-white',
      'text-gray-600 shadow-sm transition-colors cursor-pointer',
      'focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500',
    ].join(' ');
    settingsButton.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" class="h-[14px] w-[14px]"><circle cx="10" cy="10" r="2.4"/><path d="M10 2v1.6" stroke-linecap="round"/><path d="M10 16.4V18" stroke-linecap="round"/><path d="M3.5 6.5l1.4 0.9" stroke-linecap="round"/><path d="M15.1 12.6l1.4 0.9" stroke-linecap="round"/><path d="M2 10h1.6" stroke-linecap="round"/><path d="M16.4 10H18" stroke-linecap="round"/><path d="M3.5 13.5l1.4-0.9" stroke-linecap="round"/><path d="M15.1 7.4l1.4-0.9" stroke-linecap="round"/></svg>';

    const getSelectedReduction = () => (reductionSelect.value || '').toString().trim().toLowerCase();

    const updateSettingsButton = () => {
      const methodValue = getSelectedReduction();
      let overlayVisible = false;
      if (methodValue === 'pca') {
        const current = getScatterPcaOverlayVisible(cardId);
        overlayVisible = typeof current === 'boolean' ? current : true;
      } else if (methodValue === 'umap') {
        const current = getScatterUmapOverlayVisible(cardId);
        overlayVisible = typeof current === 'boolean' ? current : true;
      } else if (methodValue === 'tsne') {
        const current = getScatterTsneOverlayVisible(cardId);
        overlayVisible = typeof current === 'boolean' ? current : true;
      }
      setReductionSettingsButtonState(settingsButton, {
        enabled: methodValue === 'pca' || methodValue === 'umap' || methodValue === 'tsne',
        active: overlayVisible,
        method: methodValue || 'reduction',
      });
    };

    settingsButton.addEventListener('pointerdown', event => event.stopPropagation());
    settingsButton.addEventListener('click', event => {
      event.stopPropagation();
      const methodValue = getSelectedReduction();
      if (methodValue === 'pca') {
        toggleScatterPcaOverlayVisible(cardId);
      } else if (methodValue === 'umap') {
        toggleScatterUmapOverlayVisible(cardId);
      } else if (methodValue === 'tsne') {
        toggleScatterTsneOverlayVisible(cardId);
      } else {
        return;
      }
      updateSettingsButton();
    });

    reductionSelect.addEventListener('pointerdown', event => event.stopPropagation());
    reductionSelect.addEventListener('change', event => {
      const nextValue = (event.target.value || '').toString().trim().toLowerCase();
      const nextReduction = REDUCTION_METHODS.includes(nextValue) ? nextValue : '';
      updateScatterFieldValues(cardId, next => {
        next.reduction = nextReduction;
      });
      setScatterReductionMethod(cardId, nextReduction);
      updateSettingsButton();
    });

    reductionGroup.appendChild(reductionLabel);
    reductionGroup.appendChild(reductionSelect);
    reductionGroup.appendChild(settingsButton);
    updateSettingsButton();
  }

  reductionHost.appendChild(reductionGroup);
}

// Position clustering panel below the clustering toggle button
function positionClusteringPanel(cardElement, panel) {
  if (!cardElement || !panel) return;
  const btn = cardElement.querySelector('[data-cluster-toggle]');
  if (!btn) return;

  const cardRect = cardElement.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();

  const topOffset = btnRect.bottom - cardRect.top + 4;
  const rightOffset = cardRect.right - btnRect.right;

  panel.style.top = `${topOffset}px`;
  panel.style.right = `${rightOffset}px`;
}

// Inject clustering panel styles once
function ensureClusteringPanelStyles() {
  if (document.getElementById('clustering-panel-styles')) return;

  const style = document.createElement('style');
  style.id = 'clustering-panel-styles';
  style.textContent = `
    .workspace-card__cluster-panel {
      position: absolute;
      z-index: 16;
      pointer-events: auto;
      min-width: 230px;
      max-width: 320px;
      margin-top: 0.25rem;
    }

    .workspace-card__cluster-panel.hidden {
      display: none;
    }

    /* Hide clustering UI while editing layout */
    .workspace-card:not(.workspace-card--readonly) .workspace-card__cluster-panel {
      display: none;
    }
  `;
  document.head.appendChild(style);
}

// Create DBSCAN clustering panel (UI only)
function createClusteringPanel(cardId) {
  ensureClusteringPanelStyles();

  const container = document.createElement('div');
  container.dataset.clusterPanel = 'true';
  container.dataset.cardId = cardId;
  container.className = 'workspace-card__cluster-panel hidden';

  // Prevent dragging the card while interacting with the panel
  ['pointerdown', 'pointermove', 'click', 'wheel'].forEach(evt => {
    container.addEventListener(evt, (e) => { e.stopPropagation(); });
  });

  const wrapper = document.createElement('div');
  wrapper.className = 'flex flex-col gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 shadow-lg';

  const title = document.createElement('div');
  title.className = 'text-[11px] font-semibold uppercase tracking-wide text-gray-700';
  title.textContent = 'DBSCAN clustering';

  const form = document.createElement('div');
  form.className = 'flex flex-col gap-1.5';

  const initial = clusteringParams.get(cardId) || { eps: 0.13, minSamples: 130 };
  clusteringParams.set(cardId, initial);

  const makeRow = (labelText, key, value, attrs = {}) => {
    const row = document.createElement('label');
    row.className = 'flex items-center justify-between gap-2 text-xs text-gray-700';

    const label = document.createElement('span');
    label.className = 'whitespace-nowrap font-medium';
    label.textContent = labelText;

    const input = document.createElement('input');
    input.type = 'number';
    input.value = value ?? '';
    input.className = 'w-24 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-700 shadow-inner transition focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200';
    Object.entries(attrs).forEach(([attr, val]) => {
      if (val !== undefined && val !== null) {
        input.setAttribute(attr, String(val));
      }
    });

    input.addEventListener('input', () => {
      const existing = clusteringParams.get(cardId) || { eps: 0.13, minSamples: 130 };
      const numeric = Number(input.value);
      const sanitized = Number.isFinite(numeric) ? numeric : existing[key];
      clusteringParams.set(cardId, { ...existing, [key]: sanitized });
    });

    row.appendChild(label);
    row.appendChild(input);
    return { row, input };
  };

  const epsRow = makeRow('EPS', 'eps', initial.eps, { step: '0.01', min: '0', placeholder: '0.13' });
  const minSamplesRow = makeRow('Min samples', 'minSamples', initial.minSamples, { step: '1', min: '1', placeholder: '130' });

  form.appendChild(epsRow.row);
  form.appendChild(minSamplesRow.row);

  const actions = document.createElement('div');
  actions.className = 'flex items-center justify-end gap-2 pt-1';

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'inline-flex items-center justify-center rounded-full border border-gray-300 px-3 py-1 text-xs font-semibold text-gray-700 transition hover:border-blue-400 hover:text-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
  runBtn.textContent = 'Run clustering';
  runBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const current = clusteringParams.get(cardId) || { eps: 0.13, minSamples: 130 };
    const detail = {
      cardId,
      algorithm: 'dbscan',
      eps: Number.isFinite(Number(current.eps)) ? Number(current.eps) : 0.13,
      minSamples: Number.isFinite(Number(current.minSamples)) ? Number(current.minSamples) : 130,
    };
    const host = container.closest('.workspace-card');
    host?.dispatchEvent(new CustomEvent('scatter:cluster-ui', { bubbles: true, detail }));
  });

  actions.appendChild(runBtn);

  wrapper.appendChild(title);
  wrapper.appendChild(form);
  wrapper.appendChild(actions);

  container.appendChild(wrapper);
  return container;
}

// Toggle clustering panel visibility (UI only)
function toggleClusteringPanel(cardId, cardElement) {
  if (!cardElement) return false;

  const nextVisible = !(clusteringPanelVisible.get(cardId) || false);
  clusteringPanelVisible.set(cardId, nextVisible);

  let panel = cardElement.querySelector('[data-cluster-panel]');

  if (nextVisible) {
    if (!panel) {
      panel = createClusteringPanel(cardId);
      cardElement.appendChild(panel);
    }
    panel.classList.remove('hidden');
    positionClusteringPanel(cardElement, panel);
  } else if (panel) {
    panel.classList.add('hidden');
  }

  return nextVisible;
}

function hideClusteringPanel(cardId, cardElement) {
  clusteringPanelVisible.set(cardId, false);
  const panel = cardElement?.querySelector('[data-cluster-panel]');
  if (panel) panel.classList.add('hidden');
  const btn = cardElement?.querySelector('[data-cluster-toggle]');
  setClusteringButtonState(btn, false);
}

// Toggle sampling slider visibility
function toggleSamplingSlider(cardId, cardElement) {
  if (!cardElement) return;
  
  const currentlyVisible = samplingSliderVisible.get(cardId) || false;
  const nextVisible = !currentlyVisible;
  
  samplingSliderVisible.set(cardId, nextVisible);
  
  let sliderContainer = cardElement.querySelector('[data-sampling-slider]');
  
  if (nextVisible) {
    // Show slider: create if doesn't exist
    if (!sliderContainer) {
      sliderContainer = createSamplingSlider(cardId);
      // Append to card element (will be positioned absolutely relative to card)
      cardElement.appendChild(sliderContainer);
    }
    sliderContainer.classList.remove('hidden');
    
    // Position the slider relative to the Performance Mode button
    positionSamplingSlider(cardElement, sliderContainer);
  } else {
    // Hide slider
    if (sliderContainer) {
      sliderContainer.classList.add('hidden');
    }
  }
}

// Position sampling slider below Performance Mode button as an overlay
function positionSamplingSlider(cardElement, sliderContainer) {
  const perfBtn = cardElement.querySelector('[data-performance-mode]');
  if (!perfBtn) return;
  
  // Get button position relative to card
  const cardRect = cardElement.getBoundingClientRect();
  const btnRect = perfBtn.getBoundingClientRect();
  
  // Calculate position: below button, aligned to button's right edge
  const topOffset = btnRect.bottom - cardRect.top;
  const rightOffset = cardRect.right - btnRect.right;
  
  sliderContainer.style.top = `${topOffset}px`;
  sliderContainer.style.right = `${rightOffset}px`;
}

// Create sampling slider UI (compact overlay)
function createSamplingSlider(cardId) {
  const container = document.createElement('div');
  container.dataset.samplingSlider = 'true';
  container.className = 'workspace-card__sampling-slider';
  
  // Prevent drag interaction and stop event propagation
  container.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  container.addEventListener('pointermove', (e) => { e.stopPropagation(); });
  container.addEventListener('click', (e) => { e.stopPropagation(); });
  
  // Inner wrapper for padding and layout
  const wrapper = document.createElement('div');
  wrapper.className = 'flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-300 rounded-lg shadow-lg';
  
  // Label
  const label = document.createElement('label');
  label.htmlFor = `sampling-slider-${cardId}`;
  label.className = 'text-xs font-medium text-gray-600 whitespace-nowrap';
  label.textContent = 'Sample:';
  
  // Determine initial value: use 5% for t-SNE, otherwise get from chart or default to 20%
  const chart = getCardChart(cardId);
  let initialValue = 20;
  if (chart && typeof chart.getSamplingPercentage === 'function') {
    initialValue = chart.getSamplingPercentage();
  }
  
  // Slider input
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = `sampling-slider-${cardId}`;
  slider.min = '5';
  slider.max = '100';
  slider.step = '5';
  slider.value = String(initialValue);
  slider.className = 'sampling-slider__input';
  slider.setAttribute('aria-label', 'Sampling percentage');
  
  // Value display
  const valueDisplay = document.createElement('span');
  valueDisplay.className = 'text-xs font-semibold text-gray-700 min-w-[3ch] text-right';
  valueDisplay.textContent = `${initialValue}%`;
  
  // Update display and progress indicator on input
  const updateProgress = () => {
    const value = slider.value;
    valueDisplay.textContent = `${value}%`;
    const progress = ((value - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.setProperty('--slider-progress', `${progress}%`);
  };
  
  slider.addEventListener('input', () => {
    updateProgress();
    
    // Update chart sampling percentage
    const percentage = parseInt(slider.value, 10);
    const chart = getCardChart(cardId);
    if (chart && typeof chart.setSamplingPercentage === 'function') {
      chart.setSamplingPercentage(percentage);
    }
  });
  
  // Initialize progress
  updateProgress();
  
  wrapper.appendChild(label);
  wrapper.appendChild(slider);
  wrapper.appendChild(valueDisplay);
  container.appendChild(wrapper);
  
  // Add slider styles
  ensureSamplingSliderStyles();
  
  return container;
}

// Inject slider styles once
function ensureSamplingSliderStyles() {
  if (document.getElementById('sampling-slider-styles')) return;
  
  const style = document.createElement('style');
  style.id = 'sampling-slider-styles';
  style.textContent = `
    .workspace-card__sampling-slider {
      position: absolute;
      z-index: 15;
      pointer-events: auto;
      min-width: 200px;
      max-width: 280px;
      margin-top: 0.25rem;
    }
    
    .workspace-card__sampling-slider.hidden {
      display: none;
    }
    
    /* Hide sampling slider in Edit mode (when card is NOT readonly) */
    .workspace-card:not(.workspace-card--readonly) .workspace-card__sampling-slider {
      display: none;
    }
    
    .sampling-slider__input {
      appearance: none;
      width: 100px;
      height: 0.25rem;
      border-radius: 999px;
      background: linear-gradient(90deg, #3b82f6 0%, #3b82f6 var(--slider-progress, 100%), #e5e7eb var(--slider-progress, 100%), #e5e7eb 100%);
      border: 1px solid #d1d5db;
      outline: none;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      cursor: pointer;
    }
    
    .sampling-slider__input::-webkit-slider-runnable-track,
    .sampling-slider__input::-moz-range-track {
      height: 100%;
      border-radius: inherit;
      background: transparent;
    }
    
    .sampling-slider__input:focus-visible {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
    }
    
    .sampling-slider__input:hover {
      border-color: #3b82f6;
    }
    
    .sampling-slider__input::-webkit-slider-thumb {
      appearance: none;
      width: 0.82rem;
      height: 0.82rem;
      border-radius: 999px;
      background: #3b82f6;
      border: 2px solid rgba(255, 255, 255, 0.9);
      box-shadow: 0 2px 6px rgba(37, 99, 235, 0.3);
      cursor: pointer;
      transition: transform 0.18s ease, box-shadow 0.18s ease;
    }
    
    .sampling-slider__input::-moz-range-thumb {
      width: 0.82rem;
      height: 0.82rem;
      border-radius: 999px;
      background: #3b82f6;
      border: 2px solid rgba(255, 255, 255, 0.9);
      box-shadow: 0 2px 6px rgba(37, 99, 235, 0.3);
      cursor: pointer;
      transition: transform 0.18s ease, box-shadow 0.18s ease;
    }
    
    .sampling-slider__input:active::-webkit-slider-thumb,
    .sampling-slider__input:active::-moz-range-thumb {
      transform: scale(0.96);
      box-shadow: 0 1px 4px rgba(37, 99, 235, 0.4);
    }
  `;
  document.head.appendChild(style);
}

function persistAndRefresh() {
  persistCards().then(() => {
    renderCards();
    updateCardSelectionStyles();
  });
}

function updateCardContent(element, cardId) {
  if (!element) return;
  const container = element.querySelector('.workspace-card__content');
  if (!container) return;

  const detail = getCardConfiguration(cardId);
  const description = summarizeConfiguration(detail);

  renderScatterHeaderControls(element, cardId, detail);
  
  // Reposition sampling slider if visible
  const sliderContainer = element.querySelector('[data-sampling-slider]');
  if (sliderContainer && !sliderContainer.classList.contains('hidden')) {
    positionSamplingSlider(element, sliderContainer);
  }

  // Update header title from configuration summary
  const headerTitleEl = element.querySelector('.workspace-card__title');
  if (headerTitleEl) {
    headerTitleEl.textContent = description?.title || 'Title';
  }

  // Update original dimensionality badge next to title (Scatter only)
  (function updateOriginalDimBadge() {
    const badge = element.querySelector('[data-scatter-original-dim]');
    if (!badge) return;
    const chartType = (detail?.chartType || '').toString().trim().toLowerCase();
    const isScatter = chartType === 'scatter';
    const fieldValues = detail?.fieldValues && typeof detail.fieldValues === 'object' ? detail.fieldValues : {};
    const cols = Array.isArray(fieldValues.columns)
      ? fieldValues.columns.map(v => (typeof v === 'string' ? v.trim() : v)).filter(Boolean)
      : [];
    if (isScatter && cols.length > 0) {
      badge.textContent = `(DIM=${cols.length})`;
      badge.title = `Original dimensionality: ${cols.length}`;
      badge.classList.remove('hidden');
      badge.setAttribute('aria-hidden', 'false');
    } else {
      badge.textContent = '';
      badge.title = '';
      badge.classList.add('hidden');
      badge.setAttribute('aria-hidden', 'true');
    }
  })();

  // Toggle reset button visibility for Scatter and Line charts
  const resetBtn = element.querySelector('[data-reset-view]');
  if (resetBtn) {
    const chartType = (detail?.chartType || '').toString().trim().toLowerCase();
    const showReset = chartType === 'scatter' || chartType === 'line';
    resetBtn.classList.toggle('hidden', !showReset);
    resetBtn.disabled = !showReset;
  }

  // Time-Range Sync button visibility baseline: always hidden/disabled initially.
  // LineChart will emit 'line:ui-state' to show when selection is reduced.
  const syncBtn = element.querySelector('[data-sync-time-range]');
  if (syncBtn) {
    syncBtn.classList.add('hidden');
    syncBtn.disabled = true;
    syncBtn.setAttribute('aria-hidden', 'true');
  }

  const aggregateBtn = element.querySelector('[data-line-aggregate]');
  if (aggregateBtn) {
    aggregateBtn.classList.add('hidden');
    aggregateBtn.disabled = true;
    aggregateBtn.setAttribute('aria-hidden', 'true');
    setLineAggregateButtonState(aggregateBtn, false);
  }

  // Toggle auto-rotation control visibility/state for 3D Scatter only
  const autoBtn = element.querySelector('[data-auto-rotate]');
  if (autoBtn) {
    const chartType = (detail?.chartType || '').toString().trim().toLowerCase();
    const dim = Number(detail?.fieldValues?.dimension);
    const is3DScatter = chartType === 'scatter' && dim === 3;

    autoBtn.classList.toggle('hidden', !is3DScatter);
    autoBtn.disabled = !is3DScatter;

    if (is3DScatter) {
      let enabled = getScatterAutoRotationState(cardId);
      if (enabled === null) enabled = true; // default behavior in 3D is enabled
      setAutorotateButtonState(autoBtn, !!enabled);
    } else {
      setAutorotateButtonState(autoBtn, false);
    }
  }

  const modeBtn = element.querySelector('[data-scatter-mode]');
  if (modeBtn) {
    const chartType = (detail?.chartType || '').toString().trim().toLowerCase();
    const isScatter = chartType === 'scatter';
    modeBtn.classList.toggle('hidden', !isScatter);
    modeBtn.disabled = !isScatter;
    const mode = isScatter ? getScatterRenderMode(cardId) || 'points' : 'points';
    setScatterModeButtonState(modeBtn, mode);
  }

  // Performance Mode button (2D and 3D scatter)
  const perfBtn = element.querySelector('[data-performance-mode]');
  if (perfBtn) {
    const chartType = (detail?.chartType || '').toString().trim().toLowerCase();
    const dim = Number(detail?.fieldValues?.dimension);
    const isScatter = chartType === 'scatter' && (dim === 2 || dim === 3);
    perfBtn.classList.toggle('hidden', !isScatter);
    // Always show as neutral inactive button (Performance Mode is always-on internally)
    setPerformanceButtonState(perfBtn, { active: false, disabled: false });
    
    // Hide sampling slider if chart type changed to non-scatter
    if (!isScatter) {
      const sliderContainer = element.querySelector('[data-sampling-slider]');
      if (sliderContainer) {
        sliderContainer.classList.add('hidden');
        samplingSliderVisible.set(cardId, false);
      }
    }
  }

  // Filtered Visibility button (shown when TimeRangeFilter OR Point Selection active)
  const filterBtn = element.querySelector('[data-filtered-visibility]');
  if (filterBtn) {
    filterBtn.classList.add('hidden');
    filterBtn.disabled = true;
    filterBtn.setAttribute('aria-hidden', 'true');
    setFilteredVisibilityButtonState(filterBtn, 'grey', false);
  }

  // Clustering toggle + panel (2D scatter only)
  (function applyClusteringUi() {
    const clusterBtnEl = element.querySelector('[data-cluster-toggle]');
    const clusterPanelEl = element.querySelector('[data-cluster-panel]');
    const chartType = (detail?.chartType || '').toString().trim().toLowerCase();
    const { dimension } = normalizeScatterFieldValues(detail);
    const isScatter2D = chartType === 'scatter' && dimension === 2;

    if (clusterBtnEl) {
      clusterBtnEl.classList.toggle('hidden', !isScatter2D);
      clusterBtnEl.disabled = !isScatter2D;
      clusterBtnEl.setAttribute('aria-hidden', isScatter2D ? 'false' : 'true');
      const visible = isScatter2D && !!clusteringPanelVisible.get(cardId);
      setClusteringButtonState(clusterBtnEl, visible);
    }

    if (!isScatter2D) {
      hideClusteringPanel(cardId, element);
    } else if (clusterPanelEl && !clusterPanelEl.classList.contains('hidden')) {
      positionClusteringPanel(element, clusterPanelEl);
    }
  })();

  // Selection Toolbox + divider
  const toolboxBtnEl = element.querySelector('[data-selection-toolbox]');
  const dividerEl = element.querySelector('[data-selection-divider]');
  const controlsEl = element.querySelector('[data-controls="true"]');
  (function applySelectionToolbox() {
    const chartType = (detail?.chartType || '').toString().trim().toLowerCase();
    const dim = Number(detail?.fieldValues?.dimension);
    const isScatter = chartType === 'scatter' && (dim === 2 || dim === 3);
    const items = [toolboxBtnEl, dividerEl];
    items.forEach((el) => {
      if (!el) return;
      el.classList.toggle('hidden', !isScatter);
      if ('disabled' in el) { try { el.disabled = !isScatter; } catch (_) {} }
      el.setAttribute?.('aria-hidden', isScatter ? 'false' : 'true');
    });
    if (isScatter && controlsEl && dividerEl) {
      // Place divider left of Autorotation (3D) or Performance (2D)
      if (dim === 3) {
        const autoEl = element.querySelector('[data-auto-rotate]');
        if (autoEl) controlsEl.insertBefore(dividerEl, autoEl);
      } else {
        const perfEl = element.querySelector('[data-performance-mode]');
        if (perfEl) controlsEl.insertBefore(dividerEl, perfEl);
      }
    }
    // Sync with in-chart overlay visibility
    if (toolboxBtnEl) {
      let visible = getScatterSelectionToolbarVisible(cardId);
      if (visible == null) visible = false;
      setSelectionToolboxButtonState(toolboxBtnEl, visible);
    }
  })();
 
  const visualization = setupCardVisualization({ cardId, container });

  visualization.renderCardState({
    mode: getMode(),
    detail,
    description,
    projectName: getProjectName(),
    sheetId: getSheetId(),
  });
}

function cacheElements() {
  elements.grid = byId('workspaceGrid');
  elements.addButton = byId('addCardBtn');
  elements.editButton = byId('editCardBtn');
  elements.deleteButton = byId('deleteCardBtn');
  if (!elements.grid) return;

  const existingLayer = elements.grid.querySelector('[data-card-layer]');
  if (existingLayer) {
    elements.layer = existingLayer;
    return;
  }

  const layer = document.createElement('div');
  layer.dataset.cardLayer = 'true';
  layer.className = 'workspace-card-layer';
  elements.grid.appendChild(layer);
  elements.layer = layer;
}

function updateLayerVisibility() {
  if (!elements.layer) return;
  elements.layer.classList.toggle('workspace-card-layer--empty', getCards().length === 0);
}

function applyModeToCard(element) {
  if (!element) return;
  const editable = isEditMode();
  element.classList.toggle('workspace-card--readonly', !editable);
  const handles = element.querySelectorAll('.workspace-card__handle');
  handles.forEach(handle => {
    handle.hidden = !editable;
    handle.tabIndex = editable ? 0 : -1;
    handle.setAttribute('aria-hidden', editable ? 'false' : 'true');
  });
}

function updateCardSelectionStyles() {
  const activeId = getActiveCardId();
  const editable = isEditMode();
  cardElements.forEach((element, id) => {
    const selected = editable && activeId && activeId === id;
    element.classList.toggle('workspace-card--selected', Boolean(selected));
    element.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  updateAddButtonState();
}

function applyModeStyles() {
  const editable = isEditMode();
  if (elements.grid) {
    elements.grid.classList.toggle('workspace-grid--editing', editable);
  }
  cardElements.forEach(element => {
    applyModeToCard(element);
  });
  updateCardSelectionStyles();
}

function createCardElement(card) {
  const wrapper = document.createElement('div');
  wrapper.className = 'workspace-card';
  wrapper.dataset.cardId = card.id;
  wrapper.setAttribute('aria-selected', 'false');

  // Header area (reserved space above chart)
  const header = document.createElement('div');
  header.className = 'workspace-card__header';

  const titleEl = document.createElement('div');
  titleEl.className = 'workspace-card__title';
  titleEl.textContent = 'Title';

  // Original dimensionality badge (compact, non-bold)
  const originalDimEl = document.createElement('span');
  originalDimEl.dataset.scatterOriginalDim = 'true';
  originalDimEl.className = 'text-[11px] text-gray-600';
  originalDimEl.textContent = '';
  originalDimEl.setAttribute('aria-label', 'Original data dimensionality');

  // Tight wrapper for title + dim badge to minimize spacing
  const titleWrap = document.createElement('div');
  titleWrap.className = 'flex items-baseline min-w-0 gap-0.5';
  // Normalize line-height for better baseline alignment
  try { titleEl.style.lineHeight = '1rem'; } catch (_) {}
  try { originalDimEl.style.lineHeight = '1rem'; } catch (_) {}
  titleWrap.appendChild(titleEl);
  titleWrap.appendChild(originalDimEl);

  const scatterMeta = document.createElement('div');
  scatterMeta.className = 'flex items-baseline gap-2';

  const dimensionControl = document.createElement('div');
  dimensionControl.dataset.scatterDimensionControl = 'true';
  dimensionControl.className = 'flex items-baseline gap-1 text-xs text-gray-600';

  const reductionControl = document.createElement('div');
  reductionControl.dataset.scatterReductionControl = 'true';
  reductionControl.className = 'flex items-baseline gap-1 text-xs text-gray-600';

  scatterMeta.appendChild(titleWrap);
  scatterMeta.appendChild(dimensionControl);
  scatterMeta.appendChild(reductionControl);

  // Controls container (right side)
  const controls = document.createElement('div');
  controls.className = 'flex items-center gap-1';
  controls.dataset.controls = 'true';

  // Clustering toggle (Scatter only; opens DBSCAN panel)
  const clusterBtn = document.createElement('button');
  clusterBtn.type = 'button';
  clusterBtn.dataset.clusterToggle = 'true';
  clusterBtn.className = [
    'hidden', // shown for Scatter only
    'flex','h-6','w-6','items-center','justify-center',
    'rounded-full','border','border-gray-300','text-gray-600','transition',
    'hover:border-blue-400','hover:text-blue-500',
    'focus-visible:outline-none','focus-visible:ring-2','focus-visible:ring-blue-500',
  ].join(' ');
  const clusterLabel = 'Toggle clustering controls';
  clusterBtn.setAttribute('title', clusterLabel);
  clusterBtn.setAttribute('aria-label', clusterLabel);
  clusterBtn.setAttribute('aria-pressed', 'false');
  clusterBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" class="h-[14px] w-[14px]"><circle cx="6" cy="6" r="2.2"/><circle cx="14" cy="5" r="1.9"/><circle cx="10" cy="13" r="2.4"/><path stroke-linecap="round" stroke-linejoin="round" d="M7.6 7.6 9 10m1.7 1.4 1.6-5.1"/></svg>';
  clusterBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  clusterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = toggleClusteringPanel(card.id, wrapper);
    setClusteringButtonState(clusterBtn, !!next);
    if (next) {
      const panel = wrapper.querySelector('[data-cluster-panel]');
      if (panel) positionClusteringPanel(wrapper, panel);
    }
  });
  clusterBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      clusterBtn.click();
    }
  });

  // Selection Toolbox toggle: shows/hides in-chart toolbox overlay
  const toolboxBtn = document.createElement('button');
  toolboxBtn.type = 'button';
  toolboxBtn.dataset.selectionToolbox = 'true';
  toolboxBtn.className = [
    'hidden', // shown for Scatter (2D/3D) only
    'flex','h-6','w-6','items-center','justify-center',
    'rounded-full','border','border-gray-300','text-gray-600','transition',
    'hover:border-blue-400','hover:text-blue-500',
    'focus-visible:outline-none','focus-visible:ring-2','focus-visible:ring-blue-500',
  ].join(' ');
  const toolboxLabel = 'Toggle selection toolbox';
  toolboxBtn.setAttribute('title', toolboxLabel);
  toolboxBtn.setAttribute('aria-label', toolboxLabel);
  toolboxBtn.setAttribute('aria-pressed', 'false');
  // Icon: toolbox
  toolboxBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" class="h-[14px] w-[14px]"><rect x="3.5" y="6.5" width="13" height="9" rx="1.8"/><path d="M6 6.5v-1A2.5 2.5 0 0 1 8.5 3h3A2.5 2.5 0 0 1 14 5.5v1"/></svg>';
  toolboxBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  toolboxBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = toggleScatterSelectionToolbarVisible(card.id);
    setSelectionToolboxButtonState(toolboxBtn, !!next);
  });
  toolboxBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toolboxBtn.click();
    }
  });

  // Vertical divider (thin grey line)
  const selectionDivider = document.createElement('div');
  selectionDivider.dataset.selectionDivider = 'true';
  selectionDivider.className = 'hidden h-4 w-px bg-gray-300 mx-1 self-center';
  selectionDivider.setAttribute('aria-hidden', 'true');
 
  // Autorotate (3D scatter only)
  const autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.dataset.autoRotate = 'true';
  autoBtn.className = [
    'hidden', // initially hidden; toggled by updateCardContent for 3D scatter only
    'flex',
    'h-6',
    'w-6',
    'items-center',
    'justify-center',
    'rounded-full',
    'border',
    'border-gray-300',
    'text-gray-600',
    'transition',
    'hover:border-blue-400',
    'hover:text-blue-500',
    'focus-visible:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-blue-500',
  ].join(' ');
  autoBtn.setAttribute('title', 'Enable autorotation');
  autoBtn.setAttribute('aria-label', 'Enable autorotation');
  autoBtn.setAttribute('aria-pressed', 'false');
  autoBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" class="h-[14px] w-[14px]"><path stroke-linecap="round" stroke-linejoin="round" d="M5 8a5.5 5.5 0 019.5-2.5"/><path stroke-linecap="round" stroke-linejoin="round" d="M14.5 5.5V3.5m0 2h-2"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a5.5 5.5 0 01-9.5 2.5"/><path stroke-linecap="round" stroke-linejoin="round" d="M5.5 14.5v2m0-2h2"/></svg>';

  autoBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  autoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = toggleScatterAutoRotation(card.id);
    if (next !== null) setAutorotateButtonState(autoBtn, next);
  });

  // Filtered Visibility toggle
  const filterBtn = document.createElement('button');
  filterBtn.type = 'button';
  filterBtn.dataset.filteredVisibility = 'true';
  filterBtn.className = [
    'hidden', // shown only when TimeRangeFilter is active via UI event
    'flex',
    'h-6',
    'w-6',
    'items-center',
    'justify-center',
    'rounded-full',
    'border',
    'border-gray-300',
    'text-gray-600',
    'transition',
    'hover:border-blue-400',
    'hover:text-blue-500',
    'focus-visible:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-blue-500',
  ].join(' ');
  setFilteredVisibilityButtonState(filterBtn, 'grey', false);
  filterBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = toggleScatterFilteredVisibilityMode(card.id);
    if (next) {
      setFilteredVisibilityButtonState(filterBtn, next, true);
    }
  });

  const modeBtn = document.createElement('button');
  modeBtn.type = 'button';
  modeBtn.dataset.scatterMode = 'true';
  modeBtn.className = [
    'hidden', // initially hidden; toggled by updateCardContent for Scatter charts
    'flex',
    'h-6',
    'w-6',
    'items-center',
    'justify-center',
    'rounded-full',
    'border',
    'border-gray-300',
    'text-gray-600',
    'transition',
    'hover:border-blue-400',
    'hover:text-blue-500',
    'focus-visible:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-blue-500',
  ].join(' ');
  // Pointer down should not initiate drag
  modeBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = toggleScatterRenderMode(card.id);
    if (next) setScatterModeButtonState(modeBtn, next);
  });
  // Initialize assuming current mode is points, so icon suggests switching to line
  setScatterModeButtonState(modeBtn, 'points');

  const aggregateBtn = document.createElement('button');
  aggregateBtn.type = 'button';
  aggregateBtn.dataset.lineAggregate = 'true';
  aggregateBtn.className = [
    'hidden', // shown only for multi-measure line charts via UI events
    'flex','h-6','w-6','items-center','justify-center',
    'rounded-full','border','border-gray-300','text-gray-600','transition',
    'hover:border-blue-400','hover:text-blue-500',
    'focus-visible:outline-none','focus-visible:ring-2','focus-visible:ring-blue-500',
  ].join(' ');
  const aggregateLabel = 'Toggle mean band view';
  aggregateBtn.setAttribute('title', aggregateLabel);
  aggregateBtn.setAttribute('aria-label', aggregateLabel);
  aggregateBtn.setAttribute('aria-pressed', 'false');
  aggregateBtn.setAttribute('aria-hidden', 'true');
  aggregateBtn.disabled = true;
  aggregateBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" class="h-[14px] w-[14px]"><path d="M3 12.5l3-3 3 2 3-4 3 3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 14.5c3-3 6-3 9 0s5-3 5-3v3.5H3Z" fill="currentColor" opacity="0.18"/></svg>';
  aggregateBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  aggregateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const chart = getCardChart(card.id);
    if (!chart || typeof chart.toggleAggregateMode !== 'function') return;
    const active = chart.toggleAggregateMode();
    setLineAggregateButtonState(aggregateBtn, active);
  });

  // Performance Mode button (matches Reset styling)
  const perfBtn = document.createElement('button');
  perfBtn.type = 'button';
  perfBtn.dataset.performanceMode = 'true';
  perfBtn.className = [
    'hidden', // toggled visible for 3D scatter
    'flex',
    'h-6',
    'w-6',
    'items-center',
    'justify-center',
    'rounded-full',
    'border',
    'border-gray-300',
    'text-gray-600',
    'transition',
    'hover:border-blue-400',
    'hover:text-blue-500',
    'focus-visible:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-blue-500',
  ].join(' ');
  perfBtn.setAttribute('title', 'Performance Mode');
  perfBtn.setAttribute('aria-label', 'Performance Mode');
  // Tachometer icon
  perfBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" class="h-[14px] w-[14px]"><path stroke-linecap="round" stroke-linejoin="round" d="M3.5 12a6.5 6.5 0 1113 0"/><path stroke-linecap="round" stroke-linejoin="round" d="M10 12l3.5-3.5"/><circle cx="10" cy="12" r="1.2" /></svg>';

  // Prevent header drag interaction
  perfBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  perfBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Toggle sampling slider visibility
    toggleSamplingSlider(card.id, wrapper);
  });

  // Time-Range Sync button (Line chart only; becomes visible when a non-full range is selected)
  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.dataset.syncTimeRange = 'true';
  syncBtn.className = [
    'hidden', // hidden by default; LineChart will toggle via events
    'flex','h-6','w-6','items-center','justify-center',
    'rounded-full','border','border-gray-300','text-gray-600','transition',
    'hover:border-blue-400','hover:text-blue-500',
    'focus-visible:outline-none','focus-visible:ring-2','focus-visible:ring-blue-500',
  ].join(' ');
  const syncLabel = 'Apply time range selection to all charts';
  syncBtn.setAttribute('title', syncLabel);
  syncBtn.setAttribute('aria-label', syncLabel);
  // Icon: filter (funnel)
  syncBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" class="h-[14px] w-[14px]"><path stroke-linecap="round" stroke-linejoin="round" d="M3 5h14l-5.5 6v4l-3 2v-6L3 5z"/></svg>';
  // Prevent header drag interaction
  syncBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  // No-op click for now (future: synchronize other charts)
  syncBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (syncBtn.disabled) return;

    try {
      const sheetId = getSheetId();
      if (!sheetId) {
        return;
      }

      const range = getLineChartFocusRange(card.id);
      if (!range || range.startIndex == null || range.endIndex == null) {
        return;
      }

      setTimeRange(sheetId, { startIndex: range.startIndex, endIndex: range.endIndex });
    } catch (error) {
      console.error('[Feature:cards] Failed to apply time range filter', error);
    }
  });

  // Reset-view button (only shown for Scatter charts; click resets zoom/orientation)
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.dataset.resetView = 'true';
  resetBtn.className = [
    'hidden', // initially hidden; toggled by updateCardContent for supported charts
    'flex',
    'h-6',
    'w-6',
    'items-center',
    'justify-center',
    'rounded-full',
    'border',
    'border-gray-300',
    'text-gray-600',
    'transition',
    'hover:border-blue-400',
    'hover:text-blue-500',
    'focus-visible:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-blue-500',
  ].join(' ');
  resetBtn.setAttribute('title', 'Reset view');
  resetBtn.setAttribute('aria-label', 'Reset view');
  resetBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" class="h-[14px] w-[14px]"><path stroke-linecap="round" stroke-linejoin="round" d="M3.5 10a6.5 6.5 0 111.9 4.6"/><path stroke-linecap="round" stroke-linejoin="round" d="M3.5 10V6m0 4h4"/></svg>';

  // Prevent header drag interaction when using the buttons
  resetBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetCardVisualization(card.id);
  });

  header.appendChild(scatterMeta);
  // Clustering appears left of the Selection Toolbox button
  controls.appendChild(clusterBtn);
  controls.appendChild(toolboxBtn);
  controls.appendChild(selectionDivider);
  // Then core controls
  controls.appendChild(autoBtn);
  controls.appendChild(perfBtn);
  controls.appendChild(filterBtn);
  controls.appendChild(modeBtn);
  controls.appendChild(aggregateBtn);
  controls.appendChild(syncBtn);
  controls.appendChild(resetBtn);
  header.appendChild(controls);
  wrapper.appendChild(header);

  // Chart/content area (chart mounts here, below header)
  const content = document.createElement('div');
  content.className = 'workspace-card__content';
  content.textContent = 'Visualization placeholder';
  wrapper.appendChild(content);

  const handles = [
    ['nw', 'nwse-resize'],
    ['ne', 'nesw-resize'],
    ['se', 'nwse-resize'],
    ['sw', 'nesw-resize'],
  ];

  handles.forEach(([handle, cursor]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `workspace-card__handle workspace-card__handle--${handle}`;
    button.dataset.handle = handle;
    button.style.cursor = cursor;
    button.setAttribute('aria-label', `Resize card (${handle.toUpperCase()})`);
    wrapper.appendChild(button);
    button.addEventListener('pointerdown', event => {
      interactions?.handleResizePointerDown(event, card.id, handle);
    });
  });

  // Preserve drag interaction from header and content to avoid changing UX
  header.addEventListener('pointerdown', event => {
    interactions?.handleMovePointerDown(event, card.id);
  });
  content.addEventListener('pointerdown', event => {
    interactions?.handleMovePointerDown(event, card.id);
  });

  // Listen to chart UI state changes to keep buttons synced with rotation and settings
  wrapper.addEventListener('scatter:ui-state', (ev) => {
    try {
      // Performance Mode button is always neutral (no state updates needed)
      // The button is a no-op placeholder since Performance Mode is always-on internally
      
      const autoBtnEl = wrapper.querySelector('[data-auto-rotate]');
      if (autoBtnEl && !autoBtnEl.classList.contains('hidden')) {
        const enabled = getScatterAutoRotationState(card.id);
        if (enabled !== null) {
          setAutorotateButtonState(autoBtnEl, !!enabled);
        }
      }
      // Filtered Visibility toggle state (applies to both TimeRangeFilter and Point Selection)
      const filterBtnEl = wrapper.querySelector('[data-filtered-visibility]');
      if (filterBtnEl) {
        const rangeActive = !!ev.detail?.rangeActive;
        const mode = ev.detail?.filteredVisibility === 'hide' ? 'hide' : 'grey';
        filterBtnEl.classList.toggle('hidden', !rangeActive);
        filterBtnEl.disabled = !rangeActive;
        filterBtnEl.setAttribute('aria-hidden', rangeActive ? 'false' : 'true');
        setFilteredVisibilityButtonState(filterBtnEl, mode, rangeActive);
      }
    } catch (_) {
      // ignore
    }
  });

  // Listen to Line chart UI state for time-range selection visibility
  wrapper.addEventListener('line:ui-state', (ev) => {
    try {
      const btn = wrapper.querySelector('[data-sync-time-range]');
      if (btn) {
        const active = !!ev.detail?.selectionActive;
        btn.classList.toggle('hidden', !active);
        btn.disabled = !active;
        btn.setAttribute('aria-hidden', active ? 'false' : 'true');
      }

      const aggregateBtnEl = wrapper.querySelector('[data-line-aggregate]');
      if (aggregateBtnEl) {
        const available = !!ev.detail?.aggregateAvailable;
        const active = !!ev.detail?.aggregateActive;
        aggregateBtnEl.classList.toggle('hidden', !available);
        aggregateBtnEl.disabled = !available;
        aggregateBtnEl.setAttribute('aria-hidden', available ? 'false' : 'true');
        setLineAggregateButtonState(aggregateBtnEl, available && active);
      }
    } catch (_) {
      // ignore
    }
  });
 
  updateCardContent(wrapper, card.id);
 
  return wrapper;
}

function renderCards() {
  if (!elements.layer) return;
  const cards = getCards();
  const activeIds = new Set();

  cards.forEach(card => {
    let element = cardElements.get(card.id);
    if (!element) {
      element = createCardElement(card);
      cardElements.set(card.id, element);
      elements.layer.appendChild(element);
    }
    element.dataset.cardId = card.id;
    updateCardElementPosition(element, card, getRowCount(), getColumnCount());
    updateCardContent(element, card.id);
    activeIds.add(card.id);
  });

  cardElements.forEach((element, id) => {
    if (activeIds.has(id)) return;
    teardownCardVisualization(id);
    element.remove();
    cardElements.delete(id);
    samplingSliderVisible.delete(id);
  });

  updateLayerVisibility();
  applyModeStyles();
}

function clearCardElements() {
  teardownAllCardVisualizations();
  cardElements.forEach(element => element.remove());
  cardElements.clear();
  samplingSliderVisible.clear();
  updateLayerVisibility();
  updateCardSelectionStyles();
}

function handleSheetSelected(event) {
  interactions?.cancelAllInteractions({ revert: true });
  const detail = event?.detail || {};
  const { hasSheet, projectChanged } = applySheetSelection(detail);
  if (projectChanged) {
    teardownAllCardVisualizations();
  }
  if (!hasSheet) {
    clearCardElements();
    updateAddButtonState();
    return;
  }
  renderCards();
  updateAddButtonState();
}

function handleSheetDeleted(event) {
  const detail = event?.detail || {};
  const { cleared } = applySheetDeletion({
    projectName: detail.projectName,
    sheetId: detail.sheetId,
  });
  if (!cleared) return;
  interactions?.cancelAllInteractions({ revert: true });
  clearCardElements();
  updateAddButtonState();
}

function updateAddButtonState() {
  const canEdit = isEditMode() && Boolean(getProjectName()) && Boolean(getSheetId());
  const hasSelection = canEdit && Boolean(getActiveCardId());

  if (elements.addButton) {
    elements.addButton.classList.toggle('hidden', !canEdit);
    elements.addButton.disabled = !canEdit || isPersistPending();
  }

  if (elements.editButton) {
    elements.editButton.classList.toggle('hidden', !canEdit);
    elements.editButton.disabled = !hasSelection;
  }

  if (elements.deleteButton) {
    elements.deleteButton.classList.toggle('hidden', !canEdit);
    elements.deleteButton.disabled = !hasSelection || isPersistPending();
  }
}

function handleAddCardClick() {
  if (!isEditMode()) return;
  if (!getProjectName() || !getSheetId()) return;

  const rows = Math.max(getRowCount(), 1);
  const columns = Math.max(getColumnCount(), 1);
  let cardRows = Math.min(rows, Math.max(1, Math.min(DEFAULT_CARD_ROWS, rows)));
  let cardColumns = Math.min(columns, Math.max(1, Math.min(DEFAULT_CARD_COLUMNS, columns)));
  let startRow = Math.max(0, Math.floor((rows - cardRows) / 2));
  let startColumn = Math.max(0, Math.floor((columns - cardColumns) / 2));

  const largestEmpty = findLargestEmptyRectangle(getCards(), rows, columns);
  if (!largestEmpty || largestEmpty.height <= 0 || largestEmpty.width <= 0) {
    window.alert('No space left on this sheet. Please delete or resize existing cards, or add a new sheet.');
    return;
  }

  cardRows = Math.min(cardRows, largestEmpty.height);
  cardColumns = Math.min(cardColumns, largestEmpty.width);
  const rowMargin = largestEmpty.height - cardRows;
  const columnMargin = largestEmpty.width - cardColumns;
  startRow = largestEmpty.topRow + Math.max(0, Math.floor(rowMargin / 2));
  startColumn = largestEmpty.leftColumn + Math.max(0, Math.floor(columnMargin / 2));

  const maxStartRow = Math.max(0, rows - cardRows);
  const maxStartColumn = Math.max(0, columns - cardColumns);
  startRow = Math.min(Math.max(startRow, 0), maxStartRow);
  startColumn = Math.min(Math.max(startColumn, 0), maxStartColumn);

  const card = {
    id: generateCardId(),
    topLeft: { row: startRow, column: startColumn },
    bottomRight: {
      row: startRow + cardRows - 1,
      column: startColumn + cardColumns - 1,
    },
  };

  appendCard(card);
  const changed = setActiveCard(card.id, { persist: true });
  renderCards();
  if (changed) {
    updateCardSelectionStyles();
  }
  updateAddButtonState();
  persistAndRefresh();
}

async function handleEditCardClick(event) {
  if (event?.currentTarget?.disabled) return;
  if (!isEditMode()) return;
  if (!getProjectName() || !getSheetId()) return;
  const cardId = getActiveCardId();
  if (!cardId) return;
  const configuration = await ensureCardConfiguration(cardId, { refresh: true });
  openCardConfigurator({
    cardId,
    projectName: getProjectName(),
    sheetId: getSheetId(),
    configuration,
  });
}

async function handleDeleteCardClick(event) {
  if (event?.currentTarget?.disabled) return;
  if (!isEditMode()) return;
  if (!getProjectName() || !getSheetId()) return;

  const activeCardId = getActiveCardId();
  if (!activeCardId) return;

  const confirmed = await showConfirmationDialog({
    title: 'Delete card',
    message: 'Are you sure you want to delete this card?',
    confirmLabel: 'Delete card',
    cancelLabel: 'Cancel',
  });

  if (!confirmed) {
    return;
  }

  const cards = getCards();
  const index = cards.findIndex(card => card.id === activeCardId);
  if (index < 0) {
    setActiveCard(null, { persist: true });
    updateAddButtonState();
    return;
  }

  removeCardAt(index);
  const nextIndex = Math.min(index, Math.max(0, getCards().length - 1));
  const nextActiveCard = getCards()[nextIndex]?.id ?? null;
  const changed = setActiveCard(nextActiveCard, { persist: true });
  renderCards();
  if (changed) {
    updateCardSelectionStyles();
  }
  updateAddButtonState();
  persistAndRefresh();
}

function handleCardConfigurationSaved(event) {
  const detail = event?.detail || {};
  const cardId = typeof detail.cardId === 'string' ? detail.cardId : '';
  if (!cardId) return;
  if (getProjectName() && detail.projectName && detail.projectName !== getProjectName()) {
    return;
  }
  if (getSheetId() && detail.sheetId && detail.sheetId !== getSheetId()) {
    return;
  }
  const storedDetail = setCardConfiguration(cardId, detail);
  const element = cardElements.get(cardId);
  if (element) {
    updateCardContent(element, cardId);
  }
  if (storedDetail) {
    persistAndRefresh();
  }
}

function handleStoreSnapshot({ modeChanged } = {}) {
  if (modeChanged && !isEditMode()) {
    interactions?.cancelAllInteractions({ revert: true });
  }
  updateAddButtonState();
  applyModeStyles();
  cardElements.forEach((element, cardId) => {
    updateCardContent(element, cardId);
  });
}

export function initCardsFeature() {
  if (isInitialized()) return;
  cacheElements();
  if (!elements.grid) {
    console.warn(`[Feature:${FEATURE_NAME}] Workspace grid element not found.`);
    return;
  }

  interactions = createCardsInteractions({
    getGridElement: () => elements.grid,
    getCardElement: id => cardElements.get(id) || null,
    onSelectionChange: updateCardSelectionStyles,
    onPersist: persistAndRefresh,
  });

  elements.addButton?.addEventListener('click', handleAddCardClick);
  elements.editButton?.addEventListener('click', handleEditCardClick);
  elements.deleteButton?.addEventListener('click', handleDeleteCardClick);
  window.addEventListener('pointermove', interactions.handlePointerMove);
  window.addEventListener('pointerup', interactions.handlePointerUp);
  window.addEventListener('pointercancel', interactions.handlePointerCancel);
  document.addEventListener('sheet:selected', handleSheetSelected);
  document.addEventListener('sheet:deleted', handleSheetDeleted);
  document.addEventListener('card:configurationSaved', handleCardConfigurationSaved);
  
  // Reposition visible sampling sliders on window resize
  window.addEventListener('resize', () => {
    cardElements.forEach((element, cardId) => {
      const sliderContainer = element.querySelector('[data-sampling-slider]');
      if (sliderContainer && !sliderContainer.classList.contains('hidden')) {
        positionSamplingSlider(element, sliderContainer);
      }
    });
  });

  initCardsState({ onStoreSnapshot: handleStoreSnapshot });

  updateAddButtonState();
  renderCards();

  setInitialized(true);
}

export function init() {
  initCardsFeature();
}

export { FEATURE_NAME };

export default { init: initCardsFeature };
