import {
  subscribe as subscribeToSettings,
  getState as getSettingsState,
} from './settingsState.js';

const DEFAULT_PLAYBACK_SPEED = 100;

const globalScope =
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : undefined;

function now() {
  if (
    globalScope
    && typeof globalScope.performance === 'object'
    && globalScope.performance
    && typeof globalScope.performance.now === 'function'
  ) {
    return globalScope.performance.now();
  }
  return Date.now();
}

function scheduleFrame(callback) {
  if (globalScope && typeof globalScope.requestAnimationFrame === 'function') {
    return globalScope.requestAnimationFrame(callback);
  }
  if (globalScope && typeof globalScope.setTimeout === 'function') {
    return globalScope.setTimeout(() => callback(now()), 16);
  }
  return setTimeout(() => callback(now()), 16);
}

function cancelFrame(handle) {
  if (handle == null) return;
  if (globalScope && typeof globalScope.cancelAnimationFrame === 'function') {
    globalScope.cancelAnimationFrame(handle);
    return;
  }
  if (globalScope && typeof globalScope.clearTimeout === 'function') {
    globalScope.clearTimeout(handle);
    return;
  }
  clearTimeout(handle);
}

let initialized = false;
let unsubscribeSettings = null;

let timesteps = 0;
let playbackSpeed = DEFAULT_PLAYBACK_SPEED;
let currentIndex = 0;
let accumulator = 0;
let lastTimestamp = null;
let animationFrameId = null;
let playing = true;
let domainStartIndex = 0;
let domainEndIndex = null;
let resolvedDomainStart = 0;
let resolvedDomainEnd = 0;

const listeners = new Set();

function notifyListeners() {
  const snapshot = getState();
  listeners.forEach(listener => {
    try {
      listener(snapshot);
    } catch (error) {
      console.error('[timeControls:timeCursor] Listener error', error);
    }
  });
}

function stopAnimation() {
  if (animationFrameId !== null) {
    cancelFrame(animationFrameId);
    animationFrameId = null;
  }
  lastTimestamp = null;
  accumulator = 0;
}

function getMaxIndex() {
  return Math.max((timesteps || 0) - 1, 0);
}

function updateResolvedDomain() {
  const previousStart = resolvedDomainStart;
  const previousEnd = resolvedDomainEnd;

  if (timesteps <= 0) {
    resolvedDomainStart = 0;
    resolvedDomainEnd = 0;
    return previousStart !== resolvedDomainStart || previousEnd !== resolvedDomainEnd;
  }

  const maxIndex = getMaxIndex();
  let start = Number.isInteger(domainStartIndex) ? domainStartIndex : 0;
  let end = Number.isInteger(domainEndIndex) ? domainEndIndex : maxIndex;
  if (start < 0) start = 0;
  if (start > maxIndex) start = maxIndex;
  if (end < start) end = start;
  if (end > maxIndex) end = maxIndex;

  resolvedDomainStart = start;
  resolvedDomainEnd = end;
  return previousStart !== resolvedDomainStart || previousEnd !== resolvedDomainEnd;
}

function clampIndexToResolvedDomain(value) {
  const numeric = Number.isFinite(value) ? Math.trunc(value) : resolvedDomainStart;
  if (numeric < resolvedDomainStart) return resolvedDomainStart;
  if (numeric > resolvedDomainEnd) return resolvedDomainEnd;
  return numeric;
}

function getDomainSpan() {
  const span = resolvedDomainEnd - resolvedDomainStart + 1;
  return span > 0 ? span : 1;
}

function animationStep(timestamp) {
  if (!playing || timesteps <= 0 || playbackSpeed <= 0) {
    stopAnimation();
    return;
  }

  if (lastTimestamp == null) {
    lastTimestamp = timestamp;
  } else {
    const deltaSeconds = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    if (deltaSeconds > 0) {
      const progress = playbackSpeed * deltaSeconds + accumulator;
      const wholeSteps = Math.floor(progress);
      accumulator = progress - wholeSteps;

      if (wholeSteps > 0 && timesteps > 0) {
        updateResolvedDomain();
        const span = getDomainSpan();
        const base = clampIndexToResolvedDomain(currentIndex) - resolvedDomainStart;
        const relative = Number.isFinite(base) ? base : 0;
        const nextRelative = (relative + wholeSteps) % span;
        const normalizedRelative = nextRelative < 0 ? (nextRelative + span) % span : nextRelative;
        const nextIndex = resolvedDomainStart + normalizedRelative;
        if (nextIndex !== currentIndex) {
          currentIndex = nextIndex;
          notifyListeners();
        }
      }
    }
  }

  animationFrameId = scheduleFrame(animationStep);
}

function ensureAnimationRunning() {
  if (!playing || timesteps <= 0 || playbackSpeed <= 0) {
    stopAnimation();
    return;
  }

  if (animationFrameId == null) {
    animationFrameId = scheduleFrame(animationStep);
  }
}

function normalizeTimesteps(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const candidate = Math.trunc(value);
    return candidate > 0 ? candidate : 0;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

function normalizePlaybackSpeed(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_PLAYBACK_SPEED;
}

function handleSettingsUpdate(state) {
  const nextTimesteps = normalizeTimesteps(state?.selected);
  const nextPlayback = normalizePlaybackSpeed(state?.playbackSpeed);
  const previousTimesteps = timesteps;

  let updated = false;

  if (nextTimesteps !== timesteps) {
    timesteps = nextTimesteps;
    currentIndex = 0;
    accumulator = 0;
    updated = true;

    if (timesteps <= 0) {
      stopAnimation();
      playing = false;
    } else if (previousTimesteps <= 0 && !playing) {
      playing = true;
    }
  }

  const domainChanged = updateResolvedDomain();
  if (domainChanged) {
    const clamped = clampIndexToResolvedDomain(currentIndex);
    if (clamped !== currentIndex) {
      currentIndex = clamped;
      accumulator = 0;
      lastTimestamp = null;
    }
    updated = true;
  }

  if (!Object.is(nextPlayback, playbackSpeed)) {
    playbackSpeed = nextPlayback;
    accumulator = 0;
    lastTimestamp = null;
    updated = true;
  }

  ensureAnimationRunning();

  if (updated) {
    notifyListeners();
  }
}

export function init() {
  if (initialized) return;
  initialized = true;

  unsubscribeSettings = subscribeToSettings(handleSettingsUpdate);

  // Ensure listeners receive the initial state if the subscription mechanism is asynchronous.
  const initialState = getSettingsState();
  if (initialState !== undefined) {
    handleSettingsUpdate(initialState);
  }
}

export function subscribe(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('Listener must be a function');
  }
  listeners.add(listener);
  try {
    listener(getState());
  } catch (error) {
    console.error('[timeControls:timeCursor] Initial listener error', error);
  }
  return () => {
    listeners.delete(listener);
  };
}

export function setIndex(value) {
  if (timesteps <= 0) {
    if (currentIndex !== 0) {
      currentIndex = 0;
      accumulator = 0;
      notifyListeners();
    }
    return;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return;
  }

  updateResolvedDomain();
  const clamped = clampIndexToResolvedDomain(parsed);
  if (clamped === currentIndex) {
    return;
  }

  currentIndex = clamped;
  accumulator = 0;
  lastTimestamp = null;
  notifyListeners();
  ensureAnimationRunning();
}

export function setActiveDomain(startIndex, endIndex) {
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
    domainStartIndex = 0;
    domainEndIndex = null;
  } else {
    domainStartIndex = startIndex;
    domainEndIndex = endIndex;
  }

  const domainChanged = updateResolvedDomain();
  const clamped = clampIndexToResolvedDomain(currentIndex);
  let updated = false;

  if (clamped !== currentIndex) {
    currentIndex = clamped;
    accumulator = 0;
    lastTimestamp = null;
    updated = true;
  }

  if (domainChanged || updated) {
    notifyListeners();
    ensureAnimationRunning();
  }
}

function stepBy(delta) {
  if (!Number.isInteger(delta) || timesteps <= 0) {
    return;
  }

  const wasPlaying = playing;
  if (wasPlaying) {
    pause();
  }

  updateResolvedDomain();
  const current = clampIndexToResolvedDomain(currentIndex);
  const target = clampIndexToResolvedDomain(current + delta);

  if (target === current) {
    if (currentIndex !== current) {
      currentIndex = current;
      accumulator = 0;
      lastTimestamp = null;
      notifyListeners();
    }
    return;
  }

  currentIndex = target;
  accumulator = 0;
  lastTimestamp = null;
  notifyListeners();
}

export function stepForward() {
  stepBy(1);
}

export function stepBackward() {
  stepBy(-1);
}

export function getState() {
  return {
    index: currentIndex,
    timesteps,
    playbackSpeed,
    playing,
    active: timesteps > 0 && playbackSpeed > 0,
  };
}

export function play() {
  if (playing) {
    ensureAnimationRunning();
    return;
  }

  playing = true;
  ensureAnimationRunning();
  notifyListeners();
}

export function pause() {
  if (!playing) {
    return;
  }

  playing = false;
  stopAnimation();
  notifyListeners();
}

export function togglePlayback() {
  if (playing) {
    pause();
  } else {
    play();
  }
}

export function destroy() {
  if (!initialized) return;
  stopAnimation();
  if (typeof unsubscribeSettings === 'function') {
    unsubscribeSettings();
    unsubscribeSettings = null;
  }
  listeners.clear();
  timesteps = 0;
  playbackSpeed = DEFAULT_PLAYBACK_SPEED;
  currentIndex = 0;
  accumulator = 0;
  lastTimestamp = null;
  playing = true;
  domainStartIndex = 0;
  domainEndIndex = null;
  resolvedDomainStart = 0;
  resolvedDomainEnd = 0;
  initialized = false;
}

export default {
  init,
  subscribe,
  setIndex,
  setActiveDomain,
  stepForward,
  stepBackward,
  getState,
  play,
  pause,
  togglePlayback,
  destroy,
};
