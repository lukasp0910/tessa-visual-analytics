const state = {
  projects: [],
  currentPreview: null,
  ui: {
    isBootstrapped: false,
    isEditingVisibility: false,
    activeModalCount: 0,
    statusMessages: {},
    interactionMode: 'explore',
    activeSheets: {},
  },
};

const listeners = new Set();

function notify() {
  listeners.forEach(listener => {
    try {
      listener(getSnapshot());
    } catch (error) {
      console.error('[state:store] listener error', error);
    }
  });
}

export function getSnapshot() {
  return {
    projects: [...state.projects],
    currentPreview: state.currentPreview ? { ...state.currentPreview } : null,
    ui: {
      ...state.ui,
      statusMessages: { ...state.ui.statusMessages },
      activeSheets: { ...state.ui.activeSheets },
    },
  };
}

export function getState() {
  return state;
}

export function setProjects(projects) {
  state.projects = Array.isArray(projects) ? [...projects] : [];
  notify();
}

export function setCurrentPreview(preview) {
  state.currentPreview = preview ? { ...preview } : null;
  notify();
}

export function setUiFlag(flag, value) {
  if (!flag) return;
  if (state.ui[flag] === value) return;
  state.ui[flag] = value;
  notify();
}

export function setStatusMessage(key, message) {
  if (!key) return;
  state.ui.statusMessages[key] = message;
  notify();
}

export function clearStatusMessage(key) {
  if (!key) return;
  delete state.ui.statusMessages[key];
  notify();
}

export function incrementModalCount() {
  state.ui.activeModalCount += 1;
  notify();
}

export function decrementModalCount() {
  state.ui.activeModalCount = Math.max(0, state.ui.activeModalCount - 1);
  notify();
}

export function resetState() {
  state.projects = [];
  state.currentPreview = null;
  state.ui = {
    isBootstrapped: false,
    isEditingVisibility: false,
    activeModalCount: 0,
    statusMessages: {},
    interactionMode: 'explore',
    activeSheets: {},
  };
  notify();
}

function normalizeKey(value) {
  if (value == null) return '';
  return String(value).trim();
}

export function setActiveSheet(projectName, sheetId) {
  const projectKey = normalizeKey(projectName);
  if (!projectKey) return;

  const normalizedSheetId = normalizeKey(sheetId);
  if (normalizedSheetId) {
    if (state.ui.activeSheets[projectKey] === normalizedSheetId) return;
    state.ui.activeSheets[projectKey] = normalizedSheetId;
  } else if (state.ui.activeSheets[projectKey]) {
    delete state.ui.activeSheets[projectKey];
  } else {
    return;
  }

  notify();
}

export function subscribe(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('Listener must be a function');
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const store = {
  getState,
  getSnapshot,
  setProjects,
  setCurrentPreview,
  setUiFlag,
  setStatusMessage,
  clearStatusMessage,
  incrementModalCount,
  decrementModalCount,
  resetState,
  setActiveSheet,
  subscribe,
};

export default store;
