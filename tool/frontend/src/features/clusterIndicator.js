import {
  subscribe as subscribeToClusterFilter,
  getClusterFilter,
  clearClusterFilter,
} from '../state/clusterFilter.js';

const FEATURE_NAME = 'clusterIndicator';
const STYLE_ID = 'cluster-indicator-styles';
const ELEMENT_ID = 'clusterIndicator';

let initialized = false;
let activeSheetId = null;
let unsubscribeCluster = null;

let containerEl = null;
let labelEl = null;
let detailEl = null;
let clearBtnEl = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [data-component="cluster-indicator"] {
      --ci-accent: #0ea5e9; /* sky (distinct from selection/time) */
      --ci-accent-strong: #0284c7;
      --ci-bg: color-mix(in oklab, white 78%, var(--ci-accent));
      --ci-fg: #0f172a;
      --ci-border: color-mix(in oklab, var(--ci-accent) 32%, #cbd5e1);
      --ci-fg-muted: color-mix(in oklab, #0f172a 68%, #334155);
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0.5rem 0.25rem 0.4rem;
      border-radius: 9999px;
      background: var(--ci-bg);
      color: var(--ci-fg);
      border: 1px solid var(--ci-border);
      box-shadow: 0 1px 2px rgba(2, 6, 23, 0.06);
      white-space: nowrap;
      max-width: 240px;
      flex-shrink: 0;
    }
    @media (prefers-color-scheme: dark) {
      [data-component="cluster-indicator"] {
        --ci-bg: color-mix(in oklab, white 64%, var(--ci-accent));
        --ci-fg: #0b1220;
        --ci-border: color-mix(in oklab, var(--ci-accent) 42%, #94a3b8);
      }
    }
    .ci__icon {
      width: 1.05rem;
      height: 1.05rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--ci-accent-strong);
      flex: 0 0 auto;
    }
    .ci__content {
      display: flex;
      flex-direction: column;
      line-height: 1.05;
      gap: 0.15rem;
      min-width: 0;
    }
    .ci__label {
      font-weight: 700;
      font-size: 0.72rem;
      letter-spacing: 0.02em;
      color: var(--ci-fg);
    }
    .ci__detail {
      font-size: 0.68rem;
      font-weight: 500;
      color: var(--ci-fg-muted);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ci__clear {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--ci-accent-strong);
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
    .ci__clear:hover {
      background: color-mix(in oklab, white 78%, var(--ci-accent));
    }
    .ci__clear:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px color-mix(in oklab, var(--ci-accent) 35%, transparent);
    }
    .ci__clear svg {
      width: 0.9rem;
      height: 0.9rem;
      pointer-events: none;
    }
    .ci--hidden {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function clusterIconSVG() {
  return `
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none">
      <circle cx="7" cy="7" r="3" stroke="currentColor" stroke-width="1.6" />
      <circle cx="17" cy="7" r="3" stroke="currentColor" stroke-width="1.6" />
      <circle cx="12" cy="16" r="3" stroke="currentColor" stroke-width="1.6" />
      <path d="M9.2 9.2 11 12m2-2 1.8-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
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

function formatClusterDetail(cluster) {
  const count = Number(cluster?.clusterCount);
  if (!Number.isFinite(count) || count <= 0) return 'Clusters active';
  if (count === 1) return '1 cluster';
  return `${count.toLocaleString()} clusters`;
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
  wrapper.dataset.component = 'cluster-indicator';
  wrapper.className = 'ci--hidden';
  wrapper.setAttribute('role', 'status');
  wrapper.setAttribute('aria-live', 'polite');
  wrapper.setAttribute('aria-label', 'Active clustering filter');

  const icon = document.createElement('span');
  icon.className = 'ci__icon';
  icon.innerHTML = clusterIconSVG();
  icon.setAttribute('aria-hidden', 'true');

  const content = document.createElement('span');
  content.className = 'ci__content';

  const label = document.createElement('strong');
  label.className = 'ci__label';
  label.textContent = 'Clustering';

  const detail = document.createElement('span');
  detail.className = 'ci__detail';
  detail.textContent = '';

  content.appendChild(label);
  content.appendChild(detail);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'ci__clear';
  clearBtn.setAttribute('aria-label', 'Clear clustering filter');
  clearBtn.title = 'Clear clustering filter';
  clearBtn.innerHTML = closeIconSVG();
  clearBtn.addEventListener('click', () => {
    const sheetId = activeSheetId;
    if (sheetId) {
      try {
        clearClusterFilter(sheetId);
      } catch (err) {
        console.error('[clusterIndicator] Failed to clear clustering filter', err);
      }
    }
  });

  wrapper.appendChild(icon);
  wrapper.appendChild(content);
  wrapper.appendChild(clearBtn);

  // Insert before the sheet tabs to appear on the left side
  parent.insertBefore(wrapper, tabs);

  containerEl = wrapper;
  labelEl = label;
  detailEl = detail;
  clearBtnEl = clearBtn;
  return wrapper;
}

function setHidden(hidden) {
  if (!containerEl) return;
  containerEl.classList.toggle('ci--hidden', !!hidden);
}

function refreshFromCluster(cluster) {
  if (!cluster || !cluster.labels || !cluster.labels.length) {
    setHidden(true);
    return;
  }
  if (!containerEl) return;
  detailEl.textContent = formatClusterDetail(cluster);
  setHidden(false);
}

function attachClusterSubscription(sheetId) {
  if (typeof unsubscribeCluster === 'function') {
    try { unsubscribeCluster(); } catch {}
    unsubscribeCluster = null;
  }
  if (!sheetId) {
    refreshFromCluster(null);
    return;
  }
  try {
    unsubscribeCluster = subscribeToClusterFilter(sheetId, cluster => {
      refreshFromCluster(cluster);
    });
  } catch (err) {
    console.error('[clusterIndicator] Failed to subscribe to clustering changes', err);
    unsubscribeCluster = null;
  }
  try {
    const current = getClusterFilter(sheetId);
    refreshFromCluster(current);
  } catch (err) {
    refreshFromCluster(null);
  }
}

function setActiveSheetContext(nextSheetId) {
  const normalized = typeof nextSheetId === 'string' && nextSheetId.trim() ? nextSheetId.trim() : null;
  if (activeSheetId === normalized) return;
  activeSheetId = normalized;
  attachClusterSubscription(activeSheetId);
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
