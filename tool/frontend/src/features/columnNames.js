import { byId, qsa, setStatusMessage } from '../ui/dom.js';
import { closeModal, openModal } from '../ui/modal.js';

const FEATURE_NAME = 'columnNames';

const elements = {};
let initialized = false;
let modalState = null;
let isEditingVisibility = false;

function cacheElements() {
  elements.modal = byId('columnNamesModal');
  elements.modalClose = byId('columnNamesModalClose');
  elements.modalBackdrop = document.querySelector('[data-modal="column-names-backdrop"]');
  elements.form = byId('columnNamesForm');
  elements.modeSelect = byId('columnNamesMode');
  elements.sections = qsa('[data-column-names-section]');
  elements.baseInput = byId('columnNamesBaseInput');
  elements.indexInput = byId('columnNamesIndexInput');
  elements.valueInput = byId('columnNamesValueInput');
  elements.listInput = byId('columnNamesListInput');
  elements.preview = byId('columnNamesPreview');
  elements.resetBtn = byId('columnNamesResetBtn');
  elements.cancelBtn = byId('columnNamesCancelBtn');
  elements.saveBtn = byId('columnNamesSaveBtn');
  elements.arrayColumnsBtn = byId('arrayColumnsBtn');
}

function normalizeColumnNameMap(value) {
  if (value == null) return {};

  const entries = [];

  if (value instanceof Map) {
    value.forEach((name, key) => {
      entries.push([key, name]);
    });
  } else if (Array.isArray(value)) {
    value.forEach((name, index) => {
      entries.push([index + 1, name]);
    });
  } else if (typeof value === 'object') {
    for (const [rawIndex, name] of Object.entries(value)) {
      entries.push([rawIndex, name]);
    }
  } else {
    return {};
  }

  const normalized = [];
  for (const [rawIndex, rawName] of entries) {
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isInteger(index) || index < 1) continue;
    const text = String(rawName ?? '').trim();
    if (!text) continue;
    normalized.push([index, text]);
  }

  normalized.sort((a, b) => a[0] - b[0]);
  const result = {};
  for (const [index, name] of normalized) {
    result[String(index)] = name;
  }
  return result;
}

function cloneColumnNameMap(value) {
  const normalized = normalizeColumnNameMap(value);
  return Object.fromEntries(Object.entries(normalized));
}

function columnNameEntries(map) {
  const normalized = normalizeColumnNameMap(map);
  return Object.entries(normalized)
    .map(([key, name]) => [Number.parseInt(key, 10), name])
    .filter(([index, name]) => Number.isInteger(index) && index >= 1 && typeof name === 'string')
    .sort((a, b) => a[0] - b[0]);
}

function columnNameMapsEqual(a, b) {
  const mapA = normalizeColumnNameMap(a);
  const mapB = normalizeColumnNameMap(b);
  const keysA = Object.keys(mapA);
  const keysB = Object.keys(mapB);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(key => mapA[key] === mapB[key]);
}

function formatTone(tone) {
  if (tone === 'error') {
    return { tone: 'error', isError: true };
  }
  if (tone === 'info') {
    return { tone: 'info' };
  }
  if (tone === 'success') {
    return { tone: 'success' };
  }
  return { tone: 'muted' };
}

function setPreviewStatus(message, tone = 'muted') {
  if (!elements.preview) return;
  elements.preview.textContent = message;
  if (tone === 'error') {
    elements.preview.className = 'text-sm text-red-600';
  } else if (tone === 'info') {
    elements.preview.className = 'text-sm text-gray-600';
  } else {
    elements.preview.className = 'text-sm text-gray-500';
  }
}

function focusColumnNamesInput() {
  const mode = elements.modeSelect?.value || 'index';
  if (mode === 'index' && elements.baseInput) {
    elements.baseInput.focus();
  } else if (mode === 'single' && elements.indexInput) {
    elements.indexInput.focus();
  } else if (mode === 'list' && elements.listInput) {
    elements.listInput.focus();
  }
}

function evaluateColumnNamesModal() {
  if (!modalState) {
    return {
      overrides: null,
      preview: 'Select an array to rename its columns.',
      valid: false,
      changed: false,
      tone: 'muted',
      successMessage: '',
    };
  }

  const mode = elements.modeSelect?.value || 'index';
  const columnCount = Number.isFinite(modalState.columnCount)
    ? modalState.columnCount
    : null;
  const original = normalizeColumnNameMap(modalState.originalNames);

  if (mode === 'index') {
    const base = elements.baseInput?.value?.trim() ?? '';
    if (!base) {
      return {
        overrides: null,
        preview: 'Enter a base name to continue.',
        valid: false,
        changed: false,
        tone: 'error',
        successMessage: '',
      };
    }
    const overrides = {};
    const limit = columnCount != null && columnCount > 0 ? columnCount : 1;
    for (let index = 1; index <= limit; index += 1) {
      overrides[String(index)] = `${base} ${index}`;
    }
    const normalized = normalizeColumnNameMap(overrides);
    const changed = !columnNameMapsEqual(normalized, original);
    const preview = changed
      ? `Columns will be renamed sequentially (e.g., "${base} 1", "${base} 2").`
      : 'Column names unchanged.';
    return {
      overrides: normalized,
      preview,
      valid: true,
      changed,
      tone: changed ? 'info' : 'muted',
      successMessage: 'Column names updated.',
    };
  }

  if (mode === 'single') {
    const rawIndex = elements.indexInput?.value ?? '';
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isInteger(index) || index < 1) {
      return {
        overrides: null,
        preview: 'Enter a valid column index (1-based).',
        valid: false,
        changed: false,
        tone: 'error',
        successMessage: '',
      };
    }
    const label = elements.valueInput?.value?.trim() ?? '';
    if (!label) {
      return {
        overrides: null,
        preview: 'Enter a column name to continue.',
        valid: false,
        changed: false,
        tone: 'error',
        successMessage: '',
      };
    }
    const overrides = { ...original, [String(index)]: label };
    const normalized = normalizeColumnNameMap(overrides);
    const changed = !columnNameMapsEqual(normalized, original);
    const preview = changed
      ? `Column ${index} will be renamed to "${label}".`
      : 'Column names unchanged.';
    return {
      overrides: normalized,
      preview,
      valid: true,
      changed,
      tone: changed ? 'info' : 'muted',
      successMessage: `Column ${index} updated.`,
    };
  }

  if (mode === 'list') {
    const raw = elements.listInput?.value ?? '';
    const parts = raw
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      return {
        overrides: null,
        preview: 'Enter a comma-separated list of column names.',
        valid: false,
        changed: false,
        tone: 'error',
        successMessage: '',
      };
    }
    const limited = columnCount != null && columnCount > 0 ? parts.slice(0, columnCount) : parts;
    const overrides = {};
    limited.forEach((name, index) => {
      overrides[String(index + 1)] = name;
    });
    const normalized = normalizeColumnNameMap(overrides);
    if (Object.keys(normalized).length === 0) {
      return {
        overrides: null,
        preview: 'Enter at least one non-empty column name.',
        valid: false,
        changed: false,
        tone: 'error',
        successMessage: '',
      };
    }
    const changed = !columnNameMapsEqual(normalized, original);
    const sample = limited.slice(0, 3).join(', ');
    const renamedCount = Object.keys(normalized).length;
    let preview = renamedCount === 1
      ? `First column will be renamed to ${sample ? `"${sample}"` : 'the provided value'}.`
      : `First ${renamedCount} columns will be renamed to: ${sample}${renamedCount > 3 ? ', …' : ''}.`;
    if (columnCount != null && renamedCount < columnCount) {
      preview += ' Remaining columns keep their default names.';
    }
    return {
      overrides: normalized,
      preview,
      valid: true,
      changed,
      tone: changed ? 'info' : 'muted',
      successMessage: 'Column names updated.',
    };
  }

  return {
    overrides: null,
    preview: 'Choose how you want to rename the columns.',
    valid: false,
    changed: false,
    tone: 'muted',
    successMessage: '',
  };
}

function updateModalUI() {
  if (!elements.modal) return;
  const mode = elements.modeSelect?.value || 'index';
  elements.sections.forEach(section => {
    if (!(section instanceof HTMLElement)) return;
    const target = section.dataset.columnNamesSection;
    section.classList.toggle('hidden', target !== mode);
  });

  const evaluation = evaluateColumnNamesModal();
  setPreviewStatus(evaluation.preview, evaluation.tone);

  if (elements.saveBtn) {
    elements.saveBtn.disabled = !(evaluation.valid && evaluation.changed && evaluation.overrides);
  }

  if (elements.resetBtn) {
    const hasOriginal = modalState && Object.keys(modalState.originalNames || {}).length > 0;
    elements.resetBtn.disabled = !hasOriginal || !isEditingVisibility;
  }
}

function closeColumnNamesModal() {
  modalState = null;
  if (elements.form?.reset) {
    elements.form.reset();
  }
  setPreviewStatus('Select an array to rename its columns.');
  if (elements.modal) {
    closeModal(elements.modal);
  }
}

function openColumnNamesModal(detail) {
  if (!detail || !elements.modal) return;

  const {
    projectName,
    arrayId,
    columnCount,
    columnNames,
  } = detail;

  modalState = {
    projectName,
    arrayId,
    columnCount: Number.isFinite(columnCount) ? columnCount : null,
    originalNames: cloneColumnNameMap(columnNames || {}),
  };

  if (elements.modeSelect) {
    const hasOverrides = Object.keys(modalState.originalNames || {}).length > 0;
    elements.modeSelect.value = hasOverrides ? 'list' : 'index';
  }
  if (elements.baseInput) elements.baseInput.value = '';
  if (elements.indexInput) elements.indexInput.value = '';
  if (elements.valueInput) elements.valueInput.value = '';
  if (elements.listInput) {
    const entries = columnNameEntries(modalState.originalNames);
    elements.listInput.value = entries.map(([, name]) => name).join(', ');
  }

  updateModalUI();
  openModal(elements.modal);
  window.setTimeout(() => {
    focusColumnNamesInput();
  }, 0);
}

function emitUpdate(overrides, { progressMessage, successMessage }) {
  if (!modalState) return;
  const detail = {
    projectName: modalState.projectName,
    arrayId: modalState.arrayId,
    overrides,
    progressMessage,
    successMessage,
  };
  document.dispatchEvent(new CustomEvent('column-names:update-request', { detail }));
}

function attachEventListeners() {
  elements.modeSelect?.addEventListener('change', () => {
    updateModalUI();
    window.setTimeout(() => {
      focusColumnNamesInput();
    }, 0);
  });

  [
    elements.baseInput,
    elements.indexInput,
    elements.valueInput,
    elements.listInput,
  ].forEach(input => {
    input?.addEventListener('input', () => {
      updateModalUI();
    });
  });

  elements.cancelBtn?.addEventListener('click', event => {
    event.preventDefault();
    closeColumnNamesModal();
  });

  elements.modalClose?.addEventListener('click', () => {
    closeColumnNamesModal();
  });

  elements.modalBackdrop?.addEventListener('click', () => {
    closeColumnNamesModal();
  });

  elements.resetBtn?.addEventListener('click', event => {
    event.preventDefault();
    if (!modalState) return;
    emitUpdate({}, {
      progressMessage: 'Resetting column names…',
      successMessage: 'Column names reset to defaults.',
    });
  });

  elements.form?.addEventListener('submit', event => {
    event.preventDefault();
    if (!modalState) return;
    const evaluation = evaluateColumnNamesModal();
    if (!(evaluation.valid && evaluation.changed && evaluation.overrides)) {
      return;
    }
    emitUpdate(evaluation.overrides, {
      progressMessage: 'Updating column names…',
      successMessage: evaluation.successMessage || 'Column names updated.',
    });
  });

  elements.arrayColumnsBtn?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('column-names:open-request'));
  });

  document.addEventListener('column-names:open', event => {
    openColumnNamesModal(event.detail || {});
  });

  document.addEventListener('column-names:update-started', event => {
    const { progressMessage } = event.detail || {};
    if (elements.saveBtn) {
      elements.saveBtn.disabled = true;
      elements.saveBtn.textContent = 'Saving…';
    }
    if (elements.resetBtn) {
      elements.resetBtn.disabled = true;
    }
    if (elements.cancelBtn) {
      elements.cancelBtn.disabled = true;
    }
    if (progressMessage) {
      setStatusMessage(elements.preview, progressMessage, formatTone('info'));
    }
  });

  document.addEventListener('column-names:update-complete', event => {
    if (elements.saveBtn) {
      elements.saveBtn.textContent = 'Save';
      elements.saveBtn.disabled = false;
    }
    if (elements.cancelBtn) {
      elements.cancelBtn.disabled = false;
    }
    if (elements.resetBtn) {
      elements.resetBtn.disabled = false;
    }
    updateModalUI();
    if (event.detail?.success && event.detail?.columnNames && modalState) {
      modalState.originalNames = cloneColumnNameMap(event.detail.columnNames);
      closeColumnNamesModal();
    }
  });

  document.addEventListener('visibility:edit-mode-changed', event => {
    isEditingVisibility = Boolean(event.detail?.editing);
    updateModalUI();
  });
}

export function init() {
  if (initialized) return;
  cacheElements();
  if (!elements.modal || !elements.form) {
    console.warn('[Feature:columnNames] Required elements not found.');
    return;
  }
  attachEventListeners();
  setPreviewStatus('Select an array to rename its columns.');
  initialized = true;
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };
