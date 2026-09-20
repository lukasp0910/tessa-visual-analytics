import { openModal, closeModal } from '../../ui/modal.js';
import { getTimeRange, setTimeRange, clearTimeRange } from '../../state/timeRangeFilter.js';
import { getState as getTimeSettingsState, subscribe as subscribeToTimeSettings } from './settingsState.js';

const FEATURE_NAME = 'temporalFocusModal';
const STYLE_ID = 'temporal-focus-modal-styles';

const elements = {
  modal: null,
  backdrop: null,
  closeBtn: null,
  startHandle: null,
  endHandle: null,
  track: null,
  trackActive: null,
  readout: null,
  minLabel: null,
  maxLabel: null,
  saveBtn: null,
  cancelBtn: null,
  status: null,
};

const sliderState = {
  min: 0,
  max: 0,
  start: 0,
  end: 0,
  dragging: null,
  hasTimesteps: false,
};

let initialized = false;
let modalOpen = false;
let activeSheetId = null;
let pendingAnimation = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [data-component="temporal-focus-modal"] {
      --tfm-accent: #7c3aed;
      --tfm-accent-strong: #6d28d9;
      --tfm-track: color-mix(in oklab, white 80%, var(--tfm-accent));
      --tfm-track-muted: color-mix(in oklab, white 92%, var(--tfm-accent));
      --tfm-thumb-bg: color-mix(in oklab, white 75%, var(--tfm-accent));
      color: #0f172a;
    }
    @media (prefers-color-scheme: dark) {
      [data-component="temporal-focus-modal"] {
        --tfm-track: color-mix(in oklab, #0f172a 55%, var(--tfm-accent));
        --tfm-track-muted: color-mix(in oklab, #0f172a 70%, var(--tfm-accent));
        --tfm-thumb-bg: color-mix(in oklab, #111827 45%, var(--tfm-accent));
        color: #e2e8f0;
      }
      [data-component="temporal-focus-modal"] .tfm__status {
        color: #94a3b8;
      }
    }
    [data-component="temporal-focus-modal"] .tfm__title-accent {
      height: 3px;
      width: 64px;
      border-radius: 9999px;
      background: linear-gradient(90deg, var(--tfm-accent) 0%, var(--tfm-accent-strong) 100%);
    }
    [data-component="temporal-focus-modal"] .tfm__slider {
      position: relative;
      width: 100%;
      height: 64px;
      display: flex;
      align-items: center;
      touch-action: none;
    }
    [data-component="temporal-focus-modal"] .tfm__track {
      position: absolute;
      inset: 0;
      top: 50%;
      height: 10px;
      transform: translateY(-50%);
      border-radius: 9999px;
      background: var(--tfm-track-muted);
      box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--tfm-accent) 16%, transparent);
    }
    [data-component="temporal-focus-modal"] .tfm__track-active {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 0;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--tfm-accent) 0%, var(--tfm-accent-strong) 100%);
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--tfm-accent) 24%, transparent);
    }
    [data-component="temporal-focus-modal"] .tfm__thumb {
      position: absolute;
      top: 50%;
      width: 26px;
      height: 26px;
      border-radius: 9999px;
      border: 2px solid var(--tfm-accent-strong);
      background: var(--tfm-thumb-bg);
      transform: translate(-50%, -50%);
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.18);
      cursor: grab;
      touch-action: none;
      transition: box-shadow 0.15s ease, transform 0.15s ease;
    }
    [data-component="temporal-focus-modal"] .tfm__thumb:active {
      cursor: grabbing;
    }
    [data-component="temporal-focus-modal"] .tfm__thumb:focus-visible {
      outline: none;
      box-shadow: 0 0 0 4px color-mix(in oklab, var(--tfm-accent) 32%, transparent);
    }
    [data-component="temporal-focus-modal"] .tfm__thumb::after {
      content: '';
      position: absolute;
      inset: 4px;
      border-radius: inherit;
      background: color-mix(in oklab, white 65%, var(--tfm-accent));
    }
    [data-component="temporal-focus-modal"] .tfm__labels {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.85rem;
      font-weight: 600;
      color: color-mix(in oklab, currentColor 80%, #475569);
    }
    [data-component="temporal-focus-modal"] .tfm__readout {
      display: inline-flex;
      align-items: center;
      border-radius: 9999px;
      background: color-mix(in oklab, white 78%, var(--tfm-accent));
      color: #0f172a;
      padding: 0.35rem 0.85rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--tfm-accent) 22%, transparent);
    }
    @media (prefers-color-scheme: dark) {
      [data-component="temporal-focus-modal"] .tfm__readout {
        background: color-mix(in oklab, #0b1220 65%, var(--tfm-accent));
        color: #f1f5f9;
      }
    }
    [data-component="temporal-focus-modal"] .tfm__status[hidden] {
      display: none;
    }
  `;
  document.head.appendChild(style);
}

function cacheElements() {
  elements.modal = document.getElementById('temporalFocusModal');
  elements.backdrop = document.querySelector('[data-modal="temporal-focus-backdrop"]');
  elements.closeBtn = document.getElementById('temporalFocusModalClose');
  elements.startHandle = document.getElementById('temporalFocusStartHandle');
  elements.endHandle = document.getElementById('temporalFocusEndHandle');
  elements.track = elements.modal ? elements.modal.querySelector('.tfm__track') : null;
  elements.trackActive = elements.modal ? elements.modal.querySelector('.tfm__track-active') : null;
  elements.readout = document.getElementById('temporalFocusReadout');
  elements.minLabel = document.getElementById('temporalFocusMinLabel');
  elements.maxLabel = document.getElementById('temporalFocusMaxLabel');
  elements.saveBtn = document.getElementById('temporalFocusSave');
  elements.cancelBtn = document.getElementById('temporalFocusCancel');
  elements.status = document.getElementById('temporalFocusStatus');
}

function clampToDomain(value) {
  if (!Number.isFinite(value)) return sliderState.min;
  const rounded = Math.round(value);
  if (rounded < sliderState.min) return sliderState.min;
  if (rounded > sliderState.max) return sliderState.max;
  return rounded;
}

function scheduleRender() {
  if (pendingAnimation != null) return;
  pendingAnimation = window.requestAnimationFrame(() => {
    pendingAnimation = null;
    renderSlider();
  });
}

function updateHandleAria(handle, role, value) {
  if (!handle) return;
  handle.setAttribute('aria-valuemin', String(sliderState.min));
  handle.setAttribute('aria-valuemax', String(sliderState.max));
  handle.setAttribute('aria-valuenow', String(value));
  handle.setAttribute('aria-valuetext', `${role === 'start' ? 'Start' : 'End'} index ${value.toLocaleString()}`);
}

function updateReadout() {
  if (!elements.readout) return;
  elements.readout.textContent = `Selected: ${sliderState.start.toLocaleString()} — ${sliderState.end.toLocaleString()}`;
}

function renderSlider() {
  if (!elements.track || !elements.trackActive || !elements.startHandle || !elements.endHandle) {
    updateReadout();
    return;
  }

  const span = Math.max(sliderState.max - sliderState.min, 1);
  const startPct = ((sliderState.start - sliderState.min) / span) * 100;
  const endPct = ((sliderState.end - sliderState.min) / span) * 100;
  const leftPct = Math.min(startPct, endPct);
  const widthPct = Math.max(Math.abs(endPct - startPct), 0);

  elements.trackActive.style.left = `${leftPct}%`;
  elements.trackActive.style.width = `${widthPct}%`;
  elements.startHandle.style.left = `${startPct}%`;
  elements.endHandle.style.left = `${endPct}%`;

  updateHandleAria(elements.startHandle, 'start', sliderState.start);
  updateHandleAria(elements.endHandle, 'end', sliderState.end);
  updateReadout();
}

function setSliderValues(nextStart, nextEnd, { handle } = {}) {
  let start = clampToDomain(nextStart);
  let end = clampToDomain(nextEnd);

  if (handle === 'start' && start > end) {
    end = start;
  } else if (handle === 'end' && end < start) {
    start = end;
  } else if (start > end) {
    const temp = start;
    start = end;
    end = temp;
  }

  if (start < sliderState.min) start = sliderState.min;
  if (start > sliderState.max) start = sliderState.max;
  if (end < sliderState.min) end = sliderState.min;
  if (end > sliderState.max) end = sliderState.max;

  if (handle === 'start' && start > end) {
    end = start;
  }
  if (handle === 'end' && end < start) {
    start = end;
  }

  const changed = start !== sliderState.start || end !== sliderState.end;
  sliderState.start = start;
  sliderState.end = end;

  if (changed || modalOpen) {
    scheduleRender();
  }

  return changed;
}

function updateLabels() {
  if (elements.minLabel) {
    elements.minLabel.textContent = sliderState.min.toLocaleString();
  }
  if (elements.maxLabel) {
    elements.maxLabel.textContent = sliderState.max.toLocaleString();
  }
}

function updateStatusMessage() {
  if (!elements.status) return;
  let message = '';
  if (!activeSheetId) {
    message = 'Select a sheet to apply a temporal focus.';
  } else if (!sliderState.hasTimesteps) {
    message = 'Configure timesteps to enable temporal focus controls.';
  }
  elements.status.textContent = message;
  if (message) {
    elements.status.removeAttribute('hidden');
  } else {
    elements.status.setAttribute('hidden', '');
  }
}

function updateSaveButtonState() {
  if (!elements.saveBtn) return;
  const disabled = !activeSheetId || !sliderState.hasTimesteps;
  elements.saveBtn.disabled = disabled;
  elements.saveBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  updateStatusMessage();
}

function applySettingsSnapshot(state) {
  const hasTimesteps = Number.isInteger(state?.selected) && state.selected > 0;
  sliderState.hasTimesteps = hasTimesteps;
  const maxIndex = hasTimesteps ? Math.max(state.selected - 1, 0) : 0;
  sliderState.min = 0;
  sliderState.max = maxIndex;

  if (!modalOpen) {
    sliderState.start = sliderState.min;
    sliderState.end = sliderState.max;
  } else {
    setSliderValues(sliderState.start, sliderState.end);
  }

  updateLabels();
  updateSaveButtonState();
  if (modalOpen) {
    scheduleRender();
  }
}

function positionToValue(clientX) {
  if (!elements.track) return sliderState.min;
  const rect = elements.track.getBoundingClientRect();
  if (!Number.isFinite(rect.width) || rect.width <= 0) {
    return sliderState.min;
  }
  const ratio = (clientX - rect.left) / rect.width;
  const clampedRatio = Math.min(Math.max(ratio, 0), 1);
  const span = sliderState.max - sliderState.min;
  if (span <= 0) {
    return sliderState.min;
  }
  const value = sliderState.min + clampedRatio * span;
  return clampToDomain(value);
}

function cancelDrag() {
  if (sliderState.dragging && sliderState.dragging.target && typeof sliderState.dragging.target.releasePointerCapture === 'function') {
    try {
      sliderState.dragging.target.releasePointerCapture(sliderState.dragging.pointerId);
    } catch (error) {
      console.warn('[features:%s] Failed to release pointer capture', FEATURE_NAME, error);
    }
  }
  sliderState.dragging = null;
  document.removeEventListener('pointermove', handlePointerMove);
  document.removeEventListener('pointerup', handlePointerUp);
  document.removeEventListener('pointercancel', handlePointerUp);
}

function beginDrag(handle, pointerId, target) {
  sliderState.dragging = { handle, pointerId, target };
  document.addEventListener('pointermove', handlePointerMove);
  document.addEventListener('pointerup', handlePointerUp);
  document.addEventListener('pointercancel', handlePointerUp);
}

function handlePointerMove(event) {
  if (!sliderState.dragging) return;
  if (sliderState.dragging.pointerId != null && event.pointerId != null && sliderState.dragging.pointerId !== event.pointerId) {
    return;
  }
  event.preventDefault();
  const handle = sliderState.dragging.handle;
  const value = positionToValue(event.clientX);
  if (handle === 'start') {
    setSliderValues(value, sliderState.end, { handle: 'start' });
  } else {
    setSliderValues(sliderState.start, value, { handle: 'end' });
  }
}

function handlePointerUp(event) {
  if (!sliderState.dragging) return;
  if (sliderState.dragging.pointerId != null && event.pointerId != null && sliderState.dragging.pointerId !== event.pointerId) {
    return;
  }
  cancelDrag();
}

function handleThumbPointerDown(event) {
  const target = event.currentTarget;
  const handle = target?.dataset?.handle;
  if (!handle) return;
  event.preventDefault();
  event.stopPropagation();
  if (typeof target.setPointerCapture === 'function' && event.pointerId != null) {
    try {
      target.setPointerCapture(event.pointerId);
    } catch (error) {
      console.warn('[features:%s] Pointer capture failed', FEATURE_NAME, error);
    }
  }
  beginDrag(handle, event.pointerId, target);
}

function handleTrackPointerDown(event) {
  if (!modalOpen) return;
  event.preventDefault();
  const value = positionToValue(event.clientX);
  const distanceToStart = Math.abs(value - sliderState.start);
  const distanceToEnd = Math.abs(value - sliderState.end);
  const handle = distanceToStart <= distanceToEnd ? 'start' : 'end';
  if (handle === 'start') {
    setSliderValues(value, sliderState.end, { handle: 'start' });
  } else {
    setSliderValues(sliderState.start, value, { handle: 'end' });
  }
  beginDrag(handle, event.pointerId, null);
}

function handleThumbKeydown(event) {
  const target = event.currentTarget;
  const handle = target?.dataset?.handle;
  if (!handle) return;
  const step = event.shiftKey ? 10 : 1;
  let handled = false;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    handled = true;
    if (handle === 'start') {
      setSliderValues(sliderState.start - step, sliderState.end, { handle: 'start' });
    } else {
      setSliderValues(sliderState.start, sliderState.end - step, { handle: 'end' });
    }
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    handled = true;
    if (handle === 'start') {
      setSliderValues(sliderState.start + step, sliderState.end, { handle: 'start' });
    } else {
      setSliderValues(sliderState.start, sliderState.end + step, { handle: 'end' });
    }
  } else if (event.key === 'Home') {
    handled = true;
    if (handle === 'start') {
      setSliderValues(sliderState.min, sliderState.end, { handle: 'start' });
    } else {
      setSliderValues(sliderState.start, sliderState.min, { handle: 'end' });
    }
  } else if (event.key === 'End') {
    handled = true;
    if (handle === 'start') {
      setSliderValues(sliderState.max, sliderState.end, { handle: 'start' });
    } else {
      setSliderValues(sliderState.start, sliderState.max, { handle: 'end' });
    }
  }

  if (handled) {
    event.preventDefault();
  }
}

function syncValuesFromFilter() {
  if (!activeSheetId) {
    setSliderValues(sliderState.min, sliderState.max);
    return;
  }
  try {
    const range = getTimeRange(activeSheetId);
    if (range && Number.isInteger(range.startIndex) && Number.isInteger(range.endIndex)) {
      setSliderValues(range.startIndex, range.endIndex);
      return;
    }
  } catch (error) {
    console.error('[features:%s] Failed to read time range state', FEATURE_NAME, error);
  }
  setSliderValues(sliderState.min, sliderState.max);
}

function handleSave() {
  if (!modalOpen) return;
  if (!activeSheetId) {
    closeTemporalFocusModal();
    return;
  }
  const start = sliderState.start;
  const end = sliderState.end;
  try {
    if (start <= sliderState.min && end >= sliderState.max) {
      clearTimeRange(activeSheetId);
    } else {
      setTimeRange(activeSheetId, { startIndex: start, endIndex: end });
    }
  } catch (error) {
    console.error('[features:%s] Failed to apply temporal focus range', FEATURE_NAME, error);
  }
  closeTemporalFocusModal();
}

function closeTemporalFocusModal() {
  if (!modalOpen) return;
  modalOpen = false;
  cancelDrag();
  closeModal(elements.modal);
  updateSaveButtonState();
}

function handleCancel() {
  closeTemporalFocusModal();
}

function handleBackdropClick(event) {
  if (event.target === elements.backdrop) {
    closeTemporalFocusModal();
  }
}

function handleModalKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeTemporalFocusModal();
  }
}

function setActiveSheetContext(sheetId) {
  const normalized = typeof sheetId === 'string' && sheetId.trim() ? sheetId.trim() : null;
  if (normalized === activeSheetId) {
    updateSaveButtonState();
    return;
  }
  activeSheetId = normalized;
  updateSaveButtonState();
  if (modalOpen) {
    syncValuesFromFilter();
    scheduleRender();
  }
}

function attachEventListeners() {
  elements.startHandle?.addEventListener('pointerdown', handleThumbPointerDown);
  elements.endHandle?.addEventListener('pointerdown', handleThumbPointerDown);
  elements.startHandle?.addEventListener('keydown', handleThumbKeydown);
  elements.endHandle?.addEventListener('keydown', handleThumbKeydown);
  elements.track?.addEventListener('pointerdown', handleTrackPointerDown);
  elements.saveBtn?.addEventListener('click', handleSave);
  elements.cancelBtn?.addEventListener('click', handleCancel);
  elements.closeBtn?.addEventListener('click', handleCancel);
  elements.backdrop?.addEventListener('click', handleBackdropClick);
  elements.modal?.addEventListener('keydown', handleModalKeydown);
}

export function openTemporalFocusModal() {
  if (!initialized) {
    init();
  }
  if (!elements.modal) return;
  if (!initialized) return;

  syncValuesFromFilter();
  updateLabels();
  updateSaveButtonState();
  scheduleRender();

  modalOpen = true;
  openModal(elements.modal, { focusTarget: elements.startHandle });
}

export function init() {
  if (initialized) return;

  ensureStyles();
  cacheElements();
  if (!elements.modal || !elements.startHandle || !elements.endHandle || !elements.track || !elements.trackActive || !elements.saveBtn || !elements.cancelBtn) {
    console.warn(`[features:${FEATURE_NAME}] Modal elements not found; temporal focus disabled.`);
    return;
  }

  attachEventListeners();
  applySettingsSnapshot(getTimeSettingsState?.() ?? {});

  try {
    subscribeToTimeSettings(state => {
      applySettingsSnapshot(state);
    });
  } catch (error) {
    console.error('[features:%s] Failed to subscribe to time settings', FEATURE_NAME, error);
  }

  document.addEventListener('sheet:selected', event => {
    const sheetId = event?.detail?.sheetId ?? null;
    setActiveSheetContext(sheetId);
  });

  document.addEventListener('sheet:deleted', event => {
    const sheetId = event?.detail?.sheetId ?? null;
    if (sheetId && activeSheetId && sheetId === activeSheetId) {
      setActiveSheetContext(null);
    }
  });

  initialized = true;
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default {
  init,
  openTemporalFocusModal,
};
