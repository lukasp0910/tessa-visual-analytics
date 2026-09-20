import { subscribe as subscribeToTimeRangeFilter, getActiveDomain as getActiveTimeRangeDomain, clearTimeRange } from '../state/timeRangeFilter.js';
import { getState as getTimeSettingsState, subscribe as subscribeToTimeSettings } from './timeControls/settingsState.js';

const FEATURE_NAME = 'timeRangeIndicator';
const STYLE_ID = 'time-range-indicator-styles';
const ELEMENT_ID = 'timeRangeIndicator';

let initialized = false;
let activeSheetId = null;
let unsubscribeRange = null;
let unsubscribeSettings = null;

let containerEl = null;
let labelEl = null;
let rangeEl = null;
let clearBtnEl = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [data-component="time-range-indicator"] {
      --tri-accent: #7c3aed; /* purple (distinct from app blues) */
      --tri-accent-strong: #6d28d9;
      --tri-bg: color-mix(in oklab, white 78%, var(--tri-accent));
      --tri-fg: #0f172a;
      --tri-border: color-mix(in oklab, var(--tri-accent) 32%, #cbd5e1);
      --tri-fg-muted: color-mix(in oklab, #0f172a 68%, #334155);
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0.5rem 0.25rem 0.4rem;
      border-radius: 9999px;
      background: var(--tri-bg);
      color: var(--tri-fg);
      border: 1px solid var(--tri-border);
      box-shadow: 0 1px 2px rgba(2, 6, 23, 0.06);
      white-space: nowrap;
      max-width: 240px;
      flex-shrink: 0;
    }
    @media (prefers-color-scheme: dark) {
      [data-component="time-range-indicator"] {
        --tri-bg: color-mix(in oklab, white 64%, var(--tri-accent));
        --tri-fg: #0b1220;
        --tri-border: color-mix(in oklab, var(--tri-accent) 42%, #94a3b8);
      }
    }
    .tri__icon {
      width: 1.05rem;
      height: 1.05rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--tri-accent-strong);
      flex: 0 0 auto;
    }
    .tri__content {
      display: flex;
      flex-direction: column;
      line-height: 1.05;
      gap: 0.15rem;
      min-width: 0;
    }
    .tri__label {
      font-weight: 700;
      font-size: 0.72rem;
      letter-spacing: 0.02em;
      color: var(--tri-fg);
    }
    .tri__range {
      font-size: 0.68rem;
      font-weight: 500;
      color: var(--tri-fg-muted);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tri__clear {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--tri-accent-strong);
      width: 1.35rem;
      height: 1.35rem;
      border-radius: 9999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex: 0 0 auto;
      margin-left: 0.1rem;
    }
    .tri__clear:hover {
      background: color-mix(in oklab, white 78%, var(--tri-accent));
    }
    .tri__clear:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px color-mix(in oklab, var(--tri-accent) 35%, transparent);
    }
    .tri__clear svg {
      width: 0.9rem;
      height: 0.9rem;
      pointer-events: none;
    }
    .tri--hidden {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function clockIconSVG() {
  return `
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6" />
      <path d="M12 7.5v5l3 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
}

function closeIconSVG() {
  return `
    <svg aria-hidden="true" focusable="false" viewBox="0 0 20 20" fill="none">
      <path d="M6 6l8 8m0-8l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
}

function formatIndex(index) {
  const n = Number(index);
  if (!Number.isFinite(n)) return String(index ?? '');
  const settings = getTimeSettingsState?.() ?? {};
  const timesteps = Number.isInteger(settings.selected) && settings.selected > 0 ? settings.selected : null;
  const duration = Number.isFinite(settings.recordingDuration) && settings.recordingDuration >= 0 ? settings.recordingDuration : null;

  if (!timesteps || duration == null) {
    return n.toLocaleString();
  }

  const maxIndex = Math.max(timesteps - 1, 1);
  const clamped = Math.min(Math.max(n, 0), maxIndex);
  const seconds = (clamped / maxIndex) * duration;
  const maxFractionDigits = seconds >= 10 ? 1 : 2;
  return `${seconds.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  })} s`;
}

function formatRangeLine(domain) {
  if (!domain || !Number.isInteger(domain.domainStartIndex) || !Number.isInteger(domain.domainEndIndex)) {
    return '';
  }
  const start = Math.min(domain.domainStartIndex, domain.domainEndIndex);
  const end = Math.max(domain.domainStartIndex, domain.domainEndIndex);
  const left = formatIndex(start);
  const right = formatIndex(end);
  return `${left} — ${right}`;
}

function buildIndicator() {
  if (containerEl) return containerEl;
  const tabs = document.getElementById('sheetTabs');
  if (!tabs || !tabs.parentElement) {
    console.warn(`[Feature:${FEATURE_NAME}] sheetTabs container not found.`);
    return null;
  }

  const parent = tabs.parentElement;

  const wrapper = document.createElement('div');
  wrapper.id = ELEMENT_ID;
  wrapper.dataset.component = 'time-range-indicator';
  wrapper.className = 'tri--hidden';
  wrapper.setAttribute('role', 'status');
  wrapper.setAttribute('aria-live', 'polite');
  wrapper.setAttribute('aria-label', 'Active time filter');

  const icon = document.createElement('span');
  icon.className = 'tri__icon';
  icon.innerHTML = clockIconSVG();
  icon.setAttribute('aria-hidden', 'true');

  const content = document.createElement('span');
  content.className = 'tri__content';

  const label = document.createElement('strong');
  label.className = 'tri__label';
  label.textContent = 'Time Filter';

  const range = document.createElement('span');
  range.className = 'tri__range';
  range.textContent = '';

  content.appendChild(label);
  content.appendChild(range);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'tri__clear';
  clearBtn.setAttribute('aria-label', 'Clear time filter');
  clearBtn.title = 'Clear time filter';
  clearBtn.innerHTML = closeIconSVG();
  clearBtn.addEventListener('click', () => {
    const sheetId = activeSheetId;
    if (sheetId) {
      try {
        clearTimeRange(sheetId);
      } catch (err) {
        console.error('[timeRangeIndicator] Failed to clear time filter', err);
      }
    }
  });

  wrapper.appendChild(icon);
  wrapper.appendChild(content);
  wrapper.appendChild(clearBtn);

  // Insert before sheet tabs
  parent.insertBefore(wrapper, tabs);

  containerEl = wrapper;
  labelEl = label;
  rangeEl = range;
  clearBtnEl = clearBtn;
  return wrapper;
}

function setHidden(hidden) {
  if (!containerEl) return;
  containerEl.classList.toggle('tri--hidden', !!hidden);
}

function refreshFromDomain(domain) {
  const text = formatRangeLine(domain);
  if (!text) {
    setHidden(true);
    return;
  }
  if (!containerEl) return;
  rangeEl.textContent = text;
  setHidden(false);
}

function attachRangeSubscription(sheetId) {
  if (typeof unsubscribeRange === 'function') {
    try { unsubscribeRange(); } catch {}
    unsubscribeRange = null;
  }
  if (!sheetId) {
    refreshFromDomain(null);
    return;
  }
  try {
    unsubscribeRange = subscribeToTimeRangeFilter(sheetId, domain => {
      refreshFromDomain(domain);
    });
  } catch (err) {
    console.error('[timeRangeIndicator] Failed to subscribe to time range changes', err);
    unsubscribeRange = null;
  }
  // Init UI state
  try {
    const current = getActiveTimeRangeDomain(sheetId);
    refreshFromDomain(current);
  } catch (err) {
    refreshFromDomain(null);
  }
}

function setActiveSheetContext(nextSheetId) {
  const normalized = typeof nextSheetId === 'string' && nextSheetId.trim() ? nextSheetId.trim() : null;
  if (activeSheetId === normalized) return;
  activeSheetId = normalized;
  attachRangeSubscription(activeSheetId);
}

export function init() {
  if (initialized) return;
  ensureStyles();
  const indicator = buildIndicator();
  if (!indicator) return;

  // Update labels when time settings change
  try {
    unsubscribeSettings = subscribeToTimeSettings(() => {
      if (activeSheetId) {
        const current = getActiveTimeRangeDomain(activeSheetId);
        // Only update text; visibility handled by refreshFromDomain
        if (current && !containerEl.classList.contains('tri--hidden')) {
          refreshFromDomain(current);
        }
      }
    });
  } catch (err) {
    console.error('[timeRangeIndicator] Failed to subscribe to time settings', err);
    unsubscribeSettings = null;
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

export default { init };