import {
  initSettingsState,
  setActiveProject,
  syncProjectEntries,
  refreshActiveProject,
  isActiveProject,
  setRuntimeTimesteps,
  subscribe as subscribeToSettings,
  getState as getSettingsState,
} from './timeControls/settingsState.js';
import {
  initTimeControlSettingsModal,
  openTimeControlSettingsModal,
} from './timeControls/settingsModal.js';
import {
  init as initTimeCursor,
  subscribe as subscribeToTimeCursor,
  setIndex as setTimeCursorIndex,
  getState as getTimeCursorState,
  pause as pauseTimeCursor,
  play as playTimeCursor,
  stepForward as stepTimeCursorForward,
  stepBackward as stepTimeCursorBackward,
  setActiveDomain as setTimeCursorDomain,
} from './timeControls/timeCursor.js';
import {
  subscribe as subscribeToTimeRangeFilter,
  getActiveDomain as getActiveTimeRangeDomain,
} from '../state/timeRangeFilter.js';

const FEATURE_NAME = 'timeControls';
const STYLE_ID = 'time-controls-styles';
const ROOT_ID = 'workspaceRoot';
const SCROLL_LOCK_CLASS = 'tc-scroll-locked';
const SCROLL_LOCK_RELEASE_DELAY = 260;

let scrollLockActive = false;
let releaseScrollLockTimer = null;

let initialized = false;
let sliderElement = null;
let startTimeElement = null;
let endTimeElement = null;
let settingsButtonElement = null;
let primaryButtonElement = null;
let unsubscribeSettings = null;
let latestCursorState = null;
let currentTimesteps = null;
let currentRecordingDuration = null;
let activeSheetId = null;
let unsubscribeTimeRange = null;
let activeTimeRangeDomain = null;

const runtimeTimestepsByProject = new Map();

const STEP_SPEED_LEVELS = [
  { after: 0, rate: 5 },
  { after: 2000, rate: 10 },
  { after: 4500, rate: 20 },
  { after: 7000, rate: 35 },
];

function attachStepButtonInteractions(button, stepFn) {
  if (!button || typeof stepFn !== 'function') {
    return;
  }

  let pointerHoldActive = false;
  let suppressNextClick = false;
  let repeatIntervalId = null;
  let rampTimeoutIds = [];
  let holdTimeoutId = null;

  const HOLD_TO_REPEAT_DELAY = 160;

  const clearRepeatInterval = () => {
    if (repeatIntervalId !== null) {
      clearInterval(repeatIntervalId);
      repeatIntervalId = null;
    }
  };

  const clearRampTimeouts = () => {
    if (rampTimeoutIds.length === 0) {
      return;
    }

    rampTimeoutIds.forEach(timeoutId => {
      clearTimeout(timeoutId);
    });
    rampTimeoutIds = [];
  };

  const clearHoldTimeout = () => {
    if (holdTimeoutId !== null) {
      clearTimeout(holdTimeoutId);
      holdTimeoutId = null;
    }
  };

  const stopPointerHold = () => {
    pointerHoldActive = false;
    clearRepeatInterval();
    clearRampTimeouts();
    clearHoldTimeout();
  };

  const applyRate = rate => {
    clearRepeatInterval();

    if (!Number.isFinite(rate) || rate <= 0) {
      return;
    }

    const interval = Math.max(20, Math.round(1000 / rate));
    repeatIntervalId = setInterval(() => {
      stepFn();
    }, interval);
  };

  const startAutoRepeat = () => {
    applyRate(STEP_SPEED_LEVELS[0]?.rate ?? 0);

    if (STEP_SPEED_LEVELS.length > 1) {
      for (let index = 1; index < STEP_SPEED_LEVELS.length; index += 1) {
        const level = STEP_SPEED_LEVELS[index];
        const delay = Math.max(0, level.after ?? 0);
        const timeoutId = setTimeout(() => {
          if (!pointerHoldActive) {
            return;
          }
          applyRate(level.rate);
        }, delay);
        rampTimeoutIds.push(timeoutId);
      }
    }
  };

  const handlePointerDown = event => {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }

    if (pointerHoldActive) {
      return;
    }

    suppressNextClick = true;
    pointerHoldActive = true;

    event.preventDefault();
    stepFn();

    clearRampTimeouts();
    clearRepeatInterval();
    clearHoldTimeout();

    if (typeof button.setPointerCapture === 'function' && event.pointerId !== undefined) {
      try {
        button.setPointerCapture(event.pointerId);
      } catch (error) {
        // Ignore capture errors
      }
    }

    holdTimeoutId = setTimeout(() => {
      if (!pointerHoldActive) {
        return;
      }
      startAutoRepeat();
    }, HOLD_TO_REPEAT_DELAY);
  };

  const handlePointerEnd = event => {
    if (!pointerHoldActive) {
      return;
    }

    if (typeof button.releasePointerCapture === 'function' && event.pointerId !== undefined) {
      try {
        button.releasePointerCapture(event.pointerId);
      } catch (error) {
        // Ignore release errors
      }
    }

    stopPointerHold();

    if (event.type !== 'pointerup') {
      suppressNextClick = false;
    }
  };

  button.addEventListener('pointerdown', handlePointerDown);
  button.addEventListener('pointerup', handlePointerEnd);
  button.addEventListener('pointercancel', handlePointerEnd);
  button.addEventListener('pointerleave', handlePointerEnd);
  button.addEventListener('lostpointercapture', () => {
    const shouldRestoreSuppression = suppressNextClick;
    stopPointerHold();

    if (shouldRestoreSuppression) {
      setTimeout(() => {
        suppressNextClick = false;
      }, 0);
    } else {
      suppressNextClick = false;
    }
  });

  button.addEventListener('click', event => {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      event.stopImmediatePropagation?.();
      return;
    }

    stepFn();
  });
}

function setScrollLock(locked) {
  const body = document.body;
  const docElement = document.documentElement;
  if (!body || !docElement) return;

  if (locked) {
    body.classList.add(SCROLL_LOCK_CLASS);
    docElement.classList.add(SCROLL_LOCK_CLASS);
    scrollLockActive = true;
  } else {
    body.classList.remove(SCROLL_LOCK_CLASS);
    docElement.classList.remove(SCROLL_LOCK_CLASS);
    scrollLockActive = false;
  }
}

function cancelPendingScrollUnlock() {
  if (releaseScrollLockTimer !== null) {
    clearTimeout(releaseScrollLockTimer);
    releaseScrollLockTimer = null;
  }
}

function engageScrollLock() {
  cancelPendingScrollUnlock();
  setScrollLock(true);
}

function releaseScrollLockWithDelay() {
  cancelPendingScrollUnlock();

  if (!scrollLockActive) {
    return;
  }

  releaseScrollLockTimer = setTimeout(() => {
    const expandedElement = document.querySelector('[data-component="time-controls"][data-expanded="true"]');
    if (expandedElement) {
      releaseScrollLockTimer = null;
      return;
    }

    setScrollLock(false);
    releaseScrollLockTimer = null;
  }, SCROLL_LOCK_RELEASE_DELAY);
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    html.${SCROLL_LOCK_CLASS},
    body.${SCROLL_LOCK_CLASS} {
      overflow-y: hidden;
    }

    [data-component="time-controls"] {
      position: relative;
      width: min(640px, calc(100% - 2rem));
      margin-left: auto;
      margin-right: auto;
      margin-top: auto;
      padding: 0.1rem 0 0.15rem;
      --tc-rail-height: 3rem;
      --tc-slider-height: 0.24rem;
      height: var(--tc-rail-height);
      z-index: 40;
      overflow: visible;
      --tc-bg: rgba(255, 255, 255, 0.68);
      --tc-bg-expanded: rgba(255, 255, 255, 0.58);
      --tc-border: rgba(148, 163, 184, 0.32);
      --tc-border-strong: rgba(148, 163, 184, 0.42);
      --tc-shadow: 0 12px 28px rgba(15, 23, 42, 0.16);
      --tc-foreground: #0f172a;
      --tc-muted: rgba(15, 23, 42, 0.62);
      --tc-muted-strong: rgba(15, 23, 42, 0.82);
      --tc-track: rgba(148, 163, 184, 0.32);
      --tc-accent: #2563eb;
      --tc-accent-strong: #3b82f6;
      --tc-accent-soft: rgba(37, 99, 235, 0.25);
      --tc-progress: 0%;
      --tc-radius: 16px;
      color: var(--tc-foreground);
    }

    [data-component="time-controls"][data-expanded="false"] {
      width: min(640px, calc(100% - 2rem));
      --tc-slider-height: 0.25rem;
      padding: 0.12rem 0 0.20rem;
    }

    @media (max-width: 640px) {
      [data-component="time-controls"] {
        width: calc(100% - 1rem);
      }

      [data-component="time-controls"][data-expanded="false"] {
        width: calc(100% - 1rem);
      }
    }

    @media (prefers-color-scheme: dark) {
      [data-component="time-controls"] {
        --tc-bg: rgba(255, 255, 255, 0.56);
        --tc-bg-expanded: rgba(255, 255, 255, 0.48);
        --tc-border: rgba(148, 163, 184, 0.28);
        --tc-border-strong: rgba(148, 163, 184, 0.38);
        --tc-shadow: 0 14px 34px rgba(2, 6, 23, 0.45);
        --tc-foreground: rgba(48, 68, 94, 0.92);
        --tc-muted: rgba(203, 213, 225, 0.85);
        --tc-muted-strong: rgba(48, 68, 94, 0.92);
        --tc-track: rgba(71, 85, 105, 0.48);
        --tc-accent: #60a5fa;
        --tc-accent-strong: #93c5fd;
        --tc-accent-soft: rgba(96, 165, 250, 0.35);
      }
    }

    [data-component="time-controls"] .time-controls__panel {
      position: absolute;
      left: 50%;
      bottom: 0;
      transform: translateX(-50%);
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
      background: var(--tc-bg);
      border: 1px solid var(--tc-border);
      border-radius: var(--tc-radius);
      padding: 0.75rem 1rem 0.85rem;
      box-shadow: var(--tc-shadow);
      backdrop-filter: blur(18px) saturate(135%);
      -webkit-backdrop-filter: blur(18px) saturate(135%);
      color: inherit;
      transition: padding 0.22s ease, gap 0.22s ease, border-radius 0.22s ease, box-shadow 0.22s ease, transform 0.22s ease;
    }

    [data-component="time-controls"][data-expanded="false"] .time-controls__panel {
      gap: 0.22rem;
      padding: 0.5rem 1rem 0.5rem;
      border-radius: var(--tc-radius);
      box-shadow: none;
      min-height: calc(var(--tc-rail-height) - 0.5rem);
      justify-content: center;
      transform: translateX(-50%) translateY(0);
    }

    [data-component="time-controls"][data-expanded="true"] .time-controls__panel {
      transform: translateX(-50%) translateY(-0.45rem);
      background: var(--tc-bg-expanded);
    }

    .time-controls__slider-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.65rem;
      width: 100%;
    }

    [data-component="time-controls"][data-expanded="false"] .time-controls__slider-row {
      justify-content: center;
      gap: 0.45rem;
    }

    .time-controls__time {
      flex: 0 0 auto;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--tc-muted-strong);
      text-transform: none;
      text-align: center;
      transition: opacity 0.18s ease, transform 0.18s ease;
      user-select: none;
      min-width: 2.75rem;
      line-height: 1.2;
    }

    [data-component="time-controls"][data-expanded="false"] .time-controls__time {
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
      min-width: 0;
      width: 0;
      line-height: 0;
      height: 0;
      overflow: hidden;
    }

    .time-controls__slider {
      appearance: none;
      width: 100%;
      flex: 1 1 auto;
      height: var(--tc-slider-height);
      border-radius: 999px;
      background:
        linear-gradient(90deg,
          var(--tc-accent-strong) 0%,
          var(--tc-accent-strong) var(--tc-progress),
          var(--tc-track) var(--tc-progress),
          var(--tc-track) 100%),
        linear-gradient(90deg,
          rgba(255, 255, 255, 0.2) 1px,
          transparent 1px);
      background-size: 100% 100%, 12px 100%;
      background-position: 0 0, 0 0;
      background-repeat: no-repeat, repeat;
      border: 1px solid var(--tc-border-strong);
      outline: none;
      position: relative;
      transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    }

    .time-controls__slider::-webkit-slider-runnable-track,
    .time-controls__slider::-moz-range-track {
      height: 100%;
      border-radius: inherit;
      background: transparent;
    }

    .time-controls__slider:focus-visible {
      border-color: var(--tc-accent);
      box-shadow: 0 0 0 3px var(--tc-accent-soft);
    }

    .time-controls__slider:hover {
      border-color: var(--tc-accent);
    }

    .time-controls__slider::-webkit-slider-thumb {
      appearance: none;
      width: 0.82rem;
      height: 0.82rem;
      border-radius: 999px;
      background: var(--tc-accent);
      border: 2px solid rgba(15, 23, 42, 0.08);
      box-shadow: 0 5px 12px rgba(37, 99, 235, 0.26);
      margin-top: calc((var(--tc-slider-height) - 0.82rem) / 2);
      transition: transform 0.18s ease, box-shadow 0.18s ease;
    }

    .time-controls__slider::-moz-range-thumb {
      width: 0.82rem;
      height: 0.82rem;
      border-radius: 999px;
      background: var(--tc-accent);
      border: 2px solid rgba(15, 23, 42, 0.08);
      box-shadow: 0 5px 12px rgba(37, 99, 235, 0.26);
      margin-top: calc((var(--tc-slider-height) - 0.82rem) / 2);
      transition: transform 0.18s ease, box-shadow 0.18s ease;
    }

    .time-controls__slider:active::-webkit-slider-thumb,
    .time-controls__slider:active::-moz-range-thumb {
      transform: scale(0.96);
      box-shadow: 0 3px 10px rgba(37, 99, 235, 0.32);
    }

    .time-controls__actions-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      width: 100%;
    }

    .time-controls__actions {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.55rem;
      transition: opacity 0.18s ease, transform 0.18s ease, max-height 0.24s ease;
      max-height: 240px;
      overflow: visible;
      flex: 1 1 auto;
    }

    [data-component="time-controls"][data-expanded="false"] .time-controls__actions {
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
      max-height: 0;
      overflow: hidden;
    }

    .time-controls__button {
      appearance: none;
      width: 2.35rem;
      height: 2.35rem;
      border-radius: 999px;
      border: 1px solid transparent;
      background: rgba(248, 250, 252, 0.08);
      color: var(--tc-muted-strong);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
    }

    .time-controls__button--subtle {
      border-color: rgba(148, 163, 184, 0.34);
      background: rgba(148, 163, 184, 0.18);
      color: var(--tc-muted-strong);
    }

    .time-controls__button:hover {
      background: rgba(37, 99, 235, 0.15);
      border-color: rgba(37, 99, 235, 0.35);
      color: var(--tc-foreground);
      transform: translateY(-1px) scale(1.04);
    }

    .time-controls__button:focus-visible {
      outline: none;
      border-color: var(--tc-accent);
      box-shadow: 0 0 0 3px var(--tc-accent-soft);
      color: var(--tc-foreground);
    }

    .time-controls__button:active {
      background: rgba(37, 99, 235, 0.22);
      border-color: var(--tc-accent);
      color: var(--tc-foreground);
      transform: scale(0.96);
    }

    .time-controls__button--primary {
      width: 2.9rem;
      height: 2.9rem;
      background: linear-gradient(135deg, var(--tc-accent) 0%, var(--tc-accent-strong) 100%);
      color: #ffffff;
      border-color: transparent;
    }

    .time-controls__button--primary:hover {
      background: linear-gradient(135deg, var(--tc-accent) 0%, var(--tc-accent-strong) 100%);
      transform: translateY(-1px) scale(1.06);
    }

    .time-controls__button--primary:active {
      transform: scale(0.97);
    }

    .time-controls__button--primary,
    .time-controls__button--primary:hover,
    .time-controls__button--primary:focus-visible,
    .time-controls__button--primary:active {
      color: #ffffff;
    }

    .time-controls__button-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }

    .time-controls__button-icon * {
      pointer-events: none;
    }

    .time-controls__button-icon svg {
      width: 1.38rem;
      height: 1.38rem;
    }

    .time-controls__settings {
      display: flex;
      justify-content: flex-end;
      transition: opacity 0.18s ease, transform 0.18s ease;
      max-height: 160px;
      overflow: visible;
      flex: 0 0 auto;
    }

    [data-component="time-controls"][data-expanded="false"] .time-controls__settings {
      opacity: 0;
      transform: translateY(6px);
      pointer-events: none;
      max-height: 0;
      overflow: hidden;
    }

    @media (prefers-reduced-motion: reduce) {
      [data-component="time-controls"] {
        transition-duration: 0.01ms;
      }

      [data-component="time-controls"] .time-controls__panel,
      .time-controls__slider,
      .time-controls__button,
      .time-controls__actions,
      .time-controls__time {
        transition-duration: 0.01ms !important;
      }
    }
  `;
  document.head.appendChild(style);
}

const ICONS = Object.freeze({
  play: `
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.8" d="M10 8.5L16 12l-6 3.5Z" />
    </svg>
  `,
  'step-forward': `
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.6" d="M16 8v8" />
      <path fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.6" d="M9 8.6 14.4 12 9 15.4Z" />
    </svg>
  `,
  'step-back': `
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.6" d="M8 8v8" />
      <path fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.6" d="M15 8.6 9.6 12 15 15.4Z" />
    </svg>
  `,
  pause: `
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.6" d="M10 8v8" />
      <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.6" d="M14 8v8" />
    </svg>
  `,
  settings: `
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.6"
        d="M12 9.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5Zm6.25 2.75c0-.38-.03-.75-.09-1.11l1.54-1.17-1.04-1.82-1.93.58a6.46 6.46 0 0 0-1.55-.9l-.3-2.01h-2.1l-.3 2.01a6.46 6.46 0 0 0-1.55.9l-1.93-.58-1.04 1.82 1.54 1.17a6.55 6.55 0 0 0 0 2.22l-1.54 1.17 1.04 1.82 1.93-.58c.47.36 1 .67 1.55.9l.3 2.01h2.1l.3-2.01c.55-.23 1.08-.54 1.55-.9l1.93.58 1.04-1.82-1.54-1.17c.06-.36.09-.73.09-1.11Z"
      />
    </svg>
  `,
});

function syncSliderProgress(slider) {
  if (!slider) return;

  const min = Number(slider.min ?? 0);
  const max = Number(slider.max ?? 100);
  const value = Number(slider.value ?? min);
  const range = Math.max(max - min, 1);
  const progress = Math.min(Math.max(((value - min) / range) * 100, 0), 100);
  slider.style.setProperty('--tc-progress', `${progress}%`);
}

function syncSliderAccessibility(slider) {
  if (!slider) return;
  slider.setAttribute('aria-valuemin', slider.min ?? '0');
  slider.setAttribute('aria-valuemax', slider.max ?? '0');
  slider.setAttribute('aria-valuenow', slider.value ?? slider.min ?? '0');
}

function hasRecordingDuration() {
  return Number.isFinite(currentRecordingDuration) && currentRecordingDuration >= 0;
}

function hasTimesteps() {
  return Number.isFinite(currentTimesteps) && currentTimesteps > 0;
}

function getSliderDomainBounds() {
  if (!hasTimesteps()) {
    return { min: 0, max: 0, hasTimesteps: false };
  }

  const maxIndex = Math.max(Number(currentTimesteps) - 1, 0);
  if (activeTimeRangeDomain
    && Number.isInteger(activeTimeRangeDomain.domainStartIndex)
    && Number.isInteger(activeTimeRangeDomain.domainEndIndex)) {
    const start = Math.min(Math.max(activeTimeRangeDomain.domainStartIndex, 0), maxIndex);
    const end = Math.min(Math.max(activeTimeRangeDomain.domainEndIndex, 0), maxIndex);
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    return { min, max, hasTimesteps: true };
  }

  return { min: 0, max: maxIndex, hasTimesteps: true };
}

function clampValueToSliderDomain(value) {
  const { min, max } = getSliderDomainBounds();
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return min;
  }
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function applySliderDomain({ clampCursor = false } = {}) {
  if (!sliderElement) return;

  const domain = getSliderDomainBounds();
  const previousValue = Number.parseInt(sliderElement.value, 10);
  const clampedValue = clampValueToSliderDomain(Number.isInteger(previousValue) ? previousValue : domain.min);

  sliderElement.min = String(domain.min);
  sliderElement.max = String(domain.max);

  if (sliderElement.value !== String(clampedValue)) {
    sliderElement.value = String(clampedValue);
    clampCursor = true;
  }

  sliderElement.disabled = !domain.hasTimesteps;

  if (startTimeElement) {
    startTimeElement.textContent = formatTimeLabel(sliderElement.value);
  }
  if (endTimeElement) {
    endTimeElement.textContent = formatTimeLabel(domain.max);
  }

  syncSliderProgress(sliderElement);
  syncSliderAccessibility(sliderElement);

  if (clampCursor && domain.hasTimesteps) {
    setTimeCursorIndex(clampedValue);
  }

  if (typeof setTimeCursorDomain === 'function') {
    if (domain.hasTimesteps) {
      setTimeCursorDomain(domain.min, domain.max);
    } else {
      setTimeCursorDomain(null, null);
    }
  }
}

function handleTimeRangeDomainChange(domain) {
  let next = null;
  if (domain && Number.isInteger(domain?.domainStartIndex) && Number.isInteger(domain?.domainEndIndex)) {
    const start = Math.min(domain.domainStartIndex, domain.domainEndIndex);
    const end = Math.max(domain.domainStartIndex, domain.domainEndIndex);
    next = { domainStartIndex: start, domainEndIndex: end };
  }

  const changed = !(
    (!activeTimeRangeDomain && !next)
    || (activeTimeRangeDomain
      && next
      && activeTimeRangeDomain.domainStartIndex === next.domainStartIndex
      && activeTimeRangeDomain.domainEndIndex === next.domainEndIndex)
  );

  activeTimeRangeDomain = next;
  applySliderDomain({ clampCursor: changed });
}

function setActiveSheetContext(sheetId) {
  const normalized = typeof sheetId === 'string' && sheetId.trim() ? sheetId.trim() : null;
  if (activeSheetId === normalized) {
    return;
  }

  if (typeof unsubscribeTimeRange === 'function') {
    try {
      unsubscribeTimeRange();
    } catch (error) {
      console.error('[timeControls] Failed to detach time range filter subscription', error);
    }
  }

  activeSheetId = normalized;
  unsubscribeTimeRange = null;
  activeTimeRangeDomain = null;

  if (activeSheetId && typeof subscribeToTimeRangeFilter === 'function') {
    try {
      unsubscribeTimeRange = subscribeToTimeRangeFilter(activeSheetId, handleTimeRangeDomainChange);
    } catch (error) {
      console.error('[timeControls] Failed to subscribe to time range filter updates', error);
      unsubscribeTimeRange = null;
    }
  }

  if (activeSheetId && typeof getActiveTimeRangeDomain === 'function') {
    try {
      handleTimeRangeDomainChange(getActiveTimeRangeDomain(activeSheetId));
    } catch (error) {
      console.error('[timeControls] Failed to read time range filter state', error);
      handleTimeRangeDomainChange(null);
    }
  } else {
    handleTimeRangeDomainChange(null);
  }

  recomputeRuntimeTimesteps();
}

function recomputeRuntimeTimesteps() {
  const settings = typeof getSettingsState === 'function' ? getSettingsState() : null;
  const activeProject = settings?.projectName || null;

  if (!activeProject) {
    setRuntimeTimesteps(null);
    return;
  }

  const entries = runtimeTimestepsByProject.get(activeProject);
  if (!entries || entries.size === 0) {
    setRuntimeTimesteps(null);
    return;
  }

  let maxTimesteps = 0;
  entries.forEach(entry => {
    if (activeSheetId && entry?.sheetId && entry.sheetId !== activeSheetId) {
      return;
    }

    if (Number.isInteger(entry?.timesteps) && entry.timesteps > maxTimesteps) {
      maxTimesteps = entry.timesteps;
    }
  });

  setRuntimeTimesteps(maxTimesteps > 0 ? maxTimesteps : null);
}

function handleRuntimeTimestepsEvent(event) {
  const detail = event?.detail || {};
  const settings = typeof getSettingsState === 'function' ? getSettingsState() : null;
  const activeProject = settings?.projectName || null;
  const eventProject = typeof detail.projectName === 'string' && detail.projectName.trim() ? detail.projectName.trim() : null;

  if (!activeProject || !eventProject || eventProject !== activeProject) {
    return;
  }

  const projectMap = runtimeTimestepsByProject.get(activeProject) ?? new Map();
  const chartKey = typeof detail.chartId === 'string' && detail.chartId.trim() ? detail.chartId.trim() : '__default';
  const timesteps = Number.isInteger(detail.timesteps) && detail.timesteps > 0 ? detail.timesteps : null;

  if (timesteps === null) {
    projectMap.delete(chartKey);
  } else {
    projectMap.set(chartKey, {
      timesteps,
      sheetId: typeof detail.sheetId === 'string' && detail.sheetId.trim() ? detail.sheetId.trim() : null,
    });
  }

  if (projectMap.size === 0) {
    runtimeTimestepsByProject.delete(activeProject);
  } else {
    runtimeTimestepsByProject.set(activeProject, projectMap);
  }

  recomputeRuntimeTimesteps();
}

function formatTimeLabel(value) {
  if (value == null) {
    return '0';
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return String(value);
  }

  if (!hasRecordingDuration() || !hasTimesteps()) {
    return numberValue.toLocaleString();
  }

  const maxIndex = Math.max(Number(currentTimesteps) - 1, 1);
  const clampedValue = Math.min(Math.max(numberValue, 0), maxIndex);
  const seconds = (clampedValue / maxIndex) * currentRecordingDuration;
  const maxFractionDigits = seconds >= 10 ? 1 : 2;
  const formattedSeconds = seconds.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  });
  return `${formattedSeconds} s`;
}

function syncPrimaryButtonState(cursorState) {
  latestCursorState = cursorState ?? null;
  const button = primaryButtonElement;
  if (!button) return;

  const iconWrapper = button.querySelector('.time-controls__button-icon');
  const totalTimesteps = cursorState?.timesteps;
  const hasTimesteps = Number.isFinite(totalTimesteps) && totalTimesteps > 0;
  const isPlaying = Boolean(cursorState?.playing) && hasTimesteps;

  if (iconWrapper) {
    iconWrapper.innerHTML = isPlaying ? ICONS.pause : ICONS.play;
  }

  const label = isPlaying ? 'Pause' : 'Play';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
  button.disabled = !hasTimesteps;
}

function createControlButton({ label, icon, variant }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'time-controls__button';
  if (variant) {
    button.classList.add(`time-controls__button--${variant}`);
  }
  button.setAttribute('aria-label', label);
  button.title = label;

  const iconSpan = document.createElement('span');
  iconSpan.className = 'time-controls__button-icon';
  iconSpan.setAttribute('aria-hidden', 'true');
  iconSpan.innerHTML = ICONS[icon] || '';

  button.appendChild(iconSpan);
  return button;
}

function buildControls() {
  const root = document.getElementById(ROOT_ID);
  if (!root) {
    console.warn(`[Feature:${FEATURE_NAME}] Workspace root element not found.`);
    return null;
  }

  root.classList.add('relative');

  let container = root.querySelector('[data-component="time-controls"]');
  if (container) {
    return container;
  }

  container = document.createElement('div');
  container.dataset.component = 'time-controls';
  container.setAttribute('data-expanded', 'false');
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', 'Time controls');

  const panel = document.createElement('div');
  panel.className = 'time-controls__panel';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '0';
  slider.value = '0';
  slider.className = 'time-controls__slider';
  slider.setAttribute('aria-label', 'Time scrubber');
  slider.disabled = true;

  const handleSliderInput = () => {
    const clamped = clampValueToSliderDomain(slider.value);
    if (slider.value !== String(clamped)) {
      slider.value = String(clamped);
    }
    syncSliderProgress(slider);
    syncSliderAccessibility(slider);
    startTime.textContent = formatTimeLabel(slider.value);
    setTimeCursorIndex(clamped);
  };

  slider.addEventListener('input', handleSliderInput);
  slider.addEventListener('change', handleSliderInput);
  slider.addEventListener('pointerdown', () => {
    pauseTimeCursor();
  });
  syncSliderProgress(slider);
  syncSliderAccessibility(slider);

  const sliderRow = document.createElement('div');
  sliderRow.className = 'time-controls__slider-row';

  const startTime = document.createElement('span');
  startTime.className = 'time-controls__time time-controls__time--start';
  startTime.textContent = '0';

  const endTime = document.createElement('span');
  endTime.className = 'time-controls__time time-controls__time--end';
  endTime.textContent = '0';

  sliderRow.appendChild(startTime);
  sliderRow.appendChild(slider);
  sliderRow.appendChild(endTime);

  const actions = document.createElement('div');
  actions.className = 'time-controls__actions';

  const buttons = [
    { label: 'Step backward', icon: 'step-back', variant: 'subtle' },
    { label: 'Play', icon: 'play', variant: 'primary' },
    { label: 'Step forward', icon: 'step-forward', variant: 'subtle' },
  ];

  let primaryButton = null;
  let stepBackwardButton = null;
  let stepForwardButton = null;

  buttons.forEach(detail => {
    const button = createControlButton(detail);
    if (detail.variant === 'primary') {
      primaryButton = button;
    } else if (detail.icon === 'step-back') {
      stepBackwardButton = button;
    } else if (detail.icon === 'step-forward') {
      stepForwardButton = button;
    }
    actions.appendChild(button);
  });

  if (primaryButton) {
    primaryButton.addEventListener('click', event => {
      event.preventDefault();

      const state = latestCursorState ?? getTimeCursorState();
      const totalTimesteps = state?.timesteps;
      const hasTimesteps = Number.isFinite(totalTimesteps) && totalTimesteps > 0;

      if (state?.playing) {
        pauseTimeCursor();
      } else {
        playTimeCursor();
      }

      if (!hasTimesteps) {
        return;
      }

      const updatedState = getTimeCursorState();
      syncPrimaryButtonState(updatedState);
    });
  }

  attachStepButtonInteractions(stepBackwardButton, stepTimeCursorBackward);
  attachStepButtonInteractions(stepForwardButton, stepTimeCursorForward);

  panel.appendChild(sliderRow);
  const actionsRow = document.createElement('div');
  actionsRow.className = 'time-controls__actions-row';
  const settings = document.createElement('div');
  settings.className = 'time-controls__settings';

  const settingsButton = createControlButton({
    label: 'Settings',
    icon: 'settings',
    variant: 'subtle',
  });
  settingsButton.classList.add('time-controls__settings-button');
  settingsButton.addEventListener('click', () => {
    openTimeControlSettingsModal();
  });

  settings.appendChild(settingsButton);
  actionsRow.appendChild(actions);
  actionsRow.appendChild(settings);
  panel.appendChild(actionsRow);
  container.appendChild(panel);
  root.appendChild(container);

  let expandedState = false;

  const setExpanded = expanded => {
    const isExpanded = Boolean(expanded);
    if (expandedState === isExpanded) {
      return;
    }

    expandedState = isExpanded;
    container.setAttribute('data-expanded', isExpanded ? 'true' : 'false');
    if (isExpanded) {
      engageScrollLock();
    } else {
      releaseScrollLockWithDelay();
    }
  };

  let collapseTimer = null;
  const clearCollapseTimer = () => {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
  };

  const scheduleCollapse = delay => {
    clearCollapseTimer();
    collapseTimer = setTimeout(() => {
      setExpanded(false);
    }, delay);
  };

  container.addEventListener('mouseenter', () => {
    clearCollapseTimer();
    setExpanded(true);
  });

  container.addEventListener('pointerdown', () => {
    clearCollapseTimer();
    setExpanded(true);
  });

  container.addEventListener('mouseleave', () => {
    scheduleCollapse(120);
  });

  container.addEventListener('focusin', () => {
    clearCollapseTimer();
    setExpanded(true);
  });

  container.addEventListener('focusout', event => {
    if (!container.contains(event.relatedTarget)) {
      scheduleCollapse(150);
    }
  });

  container.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      scheduleCollapse(0);
    }
  });

  scheduleCollapse(0);

  sliderElement = slider;
  startTimeElement = startTime;
  endTimeElement = endTime;
  settingsButtonElement = settingsButton;
  primaryButtonElement = primaryButton;

  syncPrimaryButtonState(getTimeCursorState());
  return container;
}

export function init() {
  if (initialized) return;

  ensureStyles();
  initSettingsState();
  const component = buildControls();
  if (!component) return;

  initTimeControlSettingsModal();

  const applySettingsToControls = state => {
    const recordingDuration = Number.isFinite(state.recordingDuration) && state.recordingDuration >= 0
      ? state.recordingDuration
      : null;
    currentRecordingDuration = recordingDuration;

    if (sliderElement) {
      const timesteps = Number.isInteger(state.selected) && state.selected > 0 ? state.selected : null;
      currentTimesteps = timesteps;
      applySliderDomain({ clampCursor: true });
    }

    if (settingsButtonElement) {
      const disabled = !state.projectName || state.loading || state.saving;
      settingsButtonElement.disabled = disabled;
      if (state.loading || state.saving) {
        settingsButtonElement.setAttribute('aria-busy', 'true');
      } else {
        settingsButtonElement.removeAttribute('aria-busy');
      }
      const currentLabel = state.projectName
        ? state.selected
          ? `Time control settings (current: ${state.selected.toLocaleString()} timesteps)`
          : 'Configure time control settings'
        : 'Select a project to configure time control settings';
      settingsButtonElement.setAttribute('aria-label', currentLabel);
      settingsButtonElement.title = currentLabel;
    }
  };

  unsubscribeSettings = subscribeToSettings(applySettingsToControls);

  initTimeCursor();

  const applyCursorToControls = cursorState => {
    if (!sliderElement) return;

    const { index, timesteps } = cursorState ?? {};
    if (Number.isFinite(timesteps) && timesteps > 0) {
      currentTimesteps = timesteps;
    } else if (!Number.isFinite(currentTimesteps) || currentTimesteps <= 0) {
      currentTimesteps = null;
    }

    const domain = getSliderDomainBounds();
    const clampedIndex = clampValueToSliderDomain(Number.isFinite(index) ? index : domain.min);

    if (sliderElement.min !== String(domain.min)) {
      sliderElement.min = String(domain.min);
    }
    if (sliderElement.max !== String(domain.max)) {
      sliderElement.max = String(domain.max);
    }
    if (sliderElement.value !== String(clampedIndex)) {
      sliderElement.value = String(clampedIndex);
    }

    sliderElement.disabled = !domain.hasTimesteps;
    if (startTimeElement) {
      startTimeElement.textContent = formatTimeLabel(clampedIndex);
    }
    if (endTimeElement) {
      endTimeElement.textContent = formatTimeLabel(domain.max);
    }
    syncSliderProgress(sliderElement);
    syncSliderAccessibility(sliderElement);

    syncPrimaryButtonState(cursorState);
  };

  subscribeToTimeCursor(applyCursorToControls);

  document.addEventListener('project:selected', event => {
    runtimeTimestepsByProject.clear();
    setRuntimeTimesteps(null);

    const detail = event?.detail || {};
    const projectEntry = detail.project || null;
    const projectName = detail.projectName || projectEntry?.name || null;
    setActiveProject({ projectName, projectEntry });
  });

  document.addEventListener('projects:updated', event => {
    const projects = event?.detail?.projects || [];
    syncProjectEntries(projects);
  });

  document.addEventListener('time-controls:runtime-timesteps', handleRuntimeTimestepsEvent);

  document.addEventListener('project:data-uploaded', event => {
    const projectName = event?.detail?.projectName;
    if (projectName && isActiveProject(projectName)) {
      refreshActiveProject().catch(() => {});
    }
  });

  document.addEventListener('array:renamed', event => {
    const projectName = event?.detail?.projectName;
    if (projectName && isActiveProject(projectName)) {
      refreshActiveProject().catch(() => {});
    }
  });

  document.addEventListener('array:deleted', event => {
    const projectName = event?.detail?.projectName;
    if (projectName && isActiveProject(projectName)) {
      refreshActiveProject().catch(() => {});
    }
  });

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
}

export default { init };
