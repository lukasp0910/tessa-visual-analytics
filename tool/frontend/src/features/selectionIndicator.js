import { 
  subscribe as subscribeToPointSelection, 
  getPointSelection, 
  clearPointSelection 
} from '../state/pointSelection.js';

const FEATURE_NAME = 'selectionIndicator';
const STYLE_ID = 'selection-indicator-styles';
const ELEMENT_ID = 'selectionIndicator';

let initialized = false;
let activeSheetId = null;
let unsubscribeSelection = null;

let containerEl = null;
let labelEl = null;
let countEl = null;
let clearBtnEl = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [data-component="selection-indicator"] {
      --si-accent: #f97316; /* orange (distinct selection color) */
      --si-accent-strong: #ea580c;
      --si-bg: color-mix(in oklab, white 78%, var(--si-accent));
      --si-fg: #0f172a;
      --si-border: color-mix(in oklab, var(--si-accent) 32%, #cbd5e1);
      --si-fg-muted: color-mix(in oklab, #0f172a 68%, #334155);
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0.5rem 0.25rem 0.4rem;
      border-radius: 9999px;
      background: var(--si-bg);
      color: var(--si-fg);
      border: 1px solid var(--si-border);
      box-shadow: 0 1px 2px rgba(2, 6, 23, 0.06);
      white-space: nowrap;
      max-width: 240px;
      flex-shrink: 0;
    }
    @media (prefers-color-scheme: dark) {
      [data-component="selection-indicator"] {
        --si-bg: color-mix(in oklab, white 64%, var(--si-accent));
        --si-fg: #0b1220;
        --si-border: color-mix(in oklab, var(--si-accent) 42%, #94a3b8);
      }
    }
    .si__icon {
      width: 1.05rem;
      height: 1.05rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--si-accent-strong);
      flex: 0 0 auto;
    }
    .si__content {
      display: flex;
      flex-direction: column;
      line-height: 1.05;
      gap: 0.15rem;
      min-width: 0;
    }
    .si__label {
      font-weight: 700;
      font-size: 0.72rem;
      letter-spacing: 0.02em;
      color: var(--si-fg);
    }
    .si__count {
      font-size: 0.68rem;
      font-weight: 500;
      color: var(--si-fg-muted);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .si__clear {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--si-accent-strong);
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
    .si__clear:hover {
      background: color-mix(in oklab, white 78%, var(--si-accent));
    }
    .si__clear:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px color-mix(in oklab, var(--si-accent) 35%, transparent);
    }
    .si__clear svg {
      width: 0.9rem;
      height: 0.9rem;
      pointer-events: none;
    }
    .si--hidden {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function filterIconSVG() {
  return `
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none">
      <path d="M3 6h18M8 12h8M11 18h2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
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

function formatCount(count) {
  if (!Number.isInteger(count) || count < 0) return '';
  if (count === 1) return '1 point';
  return `${count.toLocaleString()} points`;
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
  wrapper.dataset.component = 'selection-indicator';
  wrapper.className = 'si--hidden';
  wrapper.setAttribute('role', 'status');
  wrapper.setAttribute('aria-live', 'polite');
  wrapper.setAttribute('aria-label', 'Active selection filter');

  const icon = document.createElement('span');
  icon.className = 'si__icon';
  icon.innerHTML = filterIconSVG();
  icon.setAttribute('aria-hidden', 'true');

  const content = document.createElement('span');
  content.className = 'si__content';

  const label = document.createElement('strong');
  label.className = 'si__label';
  label.textContent = 'Selection Filter';

  const count = document.createElement('span');
  count.className = 'si__count';
  count.textContent = '';

  content.appendChild(label);
  content.appendChild(count);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'si__clear';
  clearBtn.setAttribute('aria-label', 'Clear selection filter');
  clearBtn.title = 'Clear selection filter';
  clearBtn.innerHTML = closeIconSVG();
  clearBtn.addEventListener('click', () => {
    const sheetId = activeSheetId;
    if (sheetId) {
      try {
        clearPointSelection(sheetId);
      } catch (err) {
        console.error('[selectionIndicator] Failed to clear selection filter', err);
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
  countEl = count;
  clearBtnEl = clearBtn;
  return wrapper;
}

function setHidden(hidden) {
  if (!containerEl) return;
  containerEl.classList.toggle('si--hidden', !!hidden);
}

function refreshFromSelection(selection) {
  const count = selection && selection instanceof Set ? selection.size : 0;
  
  if (count === 0) {
    setHidden(true);
    return;
  }
  
  if (!containerEl) return;
  countEl.textContent = formatCount(count);
  setHidden(false);
}

function attachSelectionSubscription(sheetId) {
  if (typeof unsubscribeSelection === 'function') {
    try { unsubscribeSelection(); } catch {}
    unsubscribeSelection = null;
  }
  if (!sheetId) {
    refreshFromSelection(null);
    return;
  }
  try {
    unsubscribeSelection = subscribeToPointSelection(sheetId, selection => {
      refreshFromSelection(selection);
    });
  } catch (err) {
    console.error('[selectionIndicator] Failed to subscribe to selection changes', err);
    unsubscribeSelection = null;
  }
  // Init UI state
  try {
    const current = getPointSelection(sheetId);
    refreshFromSelection(current);
  } catch (err) {
    refreshFromSelection(null);
  }
}

function setActiveSheetContext(nextSheetId) {
  const normalized = typeof nextSheetId === 'string' && nextSheetId.trim() ? nextSheetId.trim() : null;
  if (activeSheetId === normalized) return;
  activeSheetId = normalized;
  attachSelectionSubscription(activeSheetId);
}

export function init() {
  if (initialized) return;
  ensureStyles();
  const indicator = buildIndicator();
  if (!indicator) return;

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
