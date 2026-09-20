import { renameArray } from '../api/projects.js';
import { byId, setStatusMessage } from '../ui/dom.js';
import { closeModal, openModal } from '../ui/modal.js';

const FEATURE_NAME = 'arrayRename';

let initialized = false;
let modalState = null;

const elements = {};

function cacheElements() {
  elements.modal = byId('arrayRenameModal');
  elements.modalClose = byId('arrayRenameModalClose');
  elements.modalBackdrop = document.querySelector('[data-modal="array-rename-backdrop"]');
  elements.form = byId('arrayRenameForm');
  elements.input = byId('arrayRenameInput');
  elements.status = byId('arrayRenameStatus');
  elements.cancelBtn = byId('arrayRenameCancelBtn');
  elements.saveBtn = byId('arrayRenameSaveBtn');
}

function formatTone(tone) {
  if (tone === 'error') {
    return { tone: 'error', isError: true };
  }
  if (tone === 'success') {
    return { tone: 'success' };
  }
  return { tone: tone || 'info' };
}

function setRenameStatus(message, tone = 'muted') {
  if (!elements.status) return;
  setStatusMessage(elements.status, message, formatTone(tone));
}

function resetModalState() {
  modalState = null;
  if (elements.form?.dataset) {
    delete elements.form.dataset.renaming;
  }
  if (elements.form?.reset) {
    elements.form.reset();
  }
  if (elements.status) {
    setRenameStatus('', 'muted');
  }
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function canCloseModal() {
  return elements.form?.dataset?.renaming !== 'true';
}

function closeRenameModal({ resetForm = false, force = false } = {}) {
  if (!elements.modal) return;
  if (!force && !canCloseModal()) {
    return;
  }
  if (resetForm) {
    resetModalState();
  }
  closeModal(elements.modal);
  if (!resetForm) {
    // ensure state cleared even if form not reset explicitly
    modalState = null;
  }
}

function applyOpenState(detail) {
  if (!detail?.projectName || !detail?.arrayId) {
    console.warn('[Feature:arrayRename] Missing project or array information');
    return;
  }

  const existing = detail.existingNames instanceof Set
    ? new Set(Array.from(detail.existingNames))
    : new Set((detail.existingNames || []).map(name => name?.toString?.().toLowerCase?.() ?? '').filter(Boolean));

  const currentName = normalizeName(detail.currentName || detail.displayName || detail.arrayId);
  if (currentName) {
    existing.delete(currentName.toLowerCase());
  }

  modalState = {
    projectName: detail.projectName,
    arrayId: detail.arrayId,
    displayName: detail.displayName || detail.currentName || detail.arrayId,
    currentName,
    existingNames: existing,
  };

  if (elements.input) {
    elements.input.value = currentName || '';
    elements.input.placeholder = modalState.displayName || currentName || '';
    elements.input.disabled = false;
  }
  if (elements.saveBtn) {
    elements.saveBtn.disabled = false;
    elements.saveBtn.textContent = 'Save';
  }
  if (elements.cancelBtn) {
    elements.cancelBtn.disabled = false;
  }
  setRenameStatus('Enter a new name to rename this array.', 'muted');

  openModal(elements.modal, { focusTarget: elements.input });
  try {
    elements.input?.focus({ preventScroll: true });
    elements.input?.select?.();
  } catch {
    elements.input?.focus();
  }
}

function handleInputChange() {
  if (!modalState || !elements.input) return;
  const nextName = normalizeName(elements.input.value);
  if (!nextName) {
    setRenameStatus('Name cannot be empty.', 'error');
    return;
  }
  if (nextName === modalState.currentName) {
    setRenameStatus('Enter a different name to continue.', 'info');
    return;
  }
  if (modalState.existingNames.has(nextName.toLowerCase())) {
    setRenameStatus('Another array already uses that name.', 'error');
    return;
  }
  setRenameStatus('This name is available.', 'success');
}

function mapRenameError(error) {
  if (!error || typeof error !== 'object') {
    return 'Rename failed. Please try again.';
  }
  const message = error.message;
  if (message === 'HTTP 409') {
    return 'Rename failed: another array already uses that name.';
  }
  if (message === 'HTTP 404') {
    return 'Rename failed: Project or array not found.';
  }
  return `Rename failed: ${message || 'Unexpected error.'}`;
}

async function handleSubmit(event) {
  event.preventDefault();
  if (!modalState || !elements.form || !elements.input) return;
  if (elements.form.dataset?.renaming === 'true') return;

  const rawValue = elements.input.value ?? '';
  const normalized = normalizeName(rawValue);
  const { currentName, displayName, projectName, arrayId } = modalState;

  if (!normalized) {
    setRenameStatus('Enter a name to continue.', 'error');
    elements.input.focus();
    return;
  }
  if (normalized === currentName) {
    setRenameStatus('Enter a different name to continue.', 'error');
    elements.input.focus();
    elements.input.select?.();
    return;
  }
  if (modalState.existingNames.has(normalized.toLowerCase())) {
    setRenameStatus('Another array already uses that name.', 'error');
    elements.input.focus();
    elements.input.select?.();
    return;
  }

  const originalSaveLabel = elements.saveBtn?.textContent ?? 'Save';

  if (elements.form.dataset) {
    elements.form.dataset.renaming = 'true';
  }
  if (elements.saveBtn) {
    elements.saveBtn.disabled = true;
    elements.saveBtn.textContent = 'Renaming…';
  }
  if (elements.cancelBtn) {
    elements.cancelBtn.disabled = true;
  }
  if (elements.input) {
    elements.input.disabled = true;
  }

  const label = displayName || currentName || arrayId;
  setRenameStatus(`Renaming "${label}"…`, 'info');

  document.dispatchEvent(new CustomEvent('array:rename-started', {
    detail: { projectName, arrayId, nextName: normalized },
  }));

  try {
    const response = await renameArray(projectName, arrayId, normalized);
    const nextName = response?.array?.name ?? normalized;
    setRenameStatus(`Array renamed to "${nextName}".`, 'success');

    document.dispatchEvent(new CustomEvent('array:renamed', {
      detail: { projectName, arrayId, nextName, response },
    }));

    closeRenameModal({ resetForm: true, force: true });
  } catch (error) {
    console.error('[Feature:arrayRename] Rename failed', error);
    setRenameStatus(mapRenameError(error), 'error');
    document.dispatchEvent(new CustomEvent('array:rename-error', {
      detail: { projectName, arrayId, error },
    }));

    if (elements.input) {
      elements.input.disabled = false;
      try {
        elements.input.focus({ preventScroll: true });
        elements.input.select?.();
      } catch {
        elements.input.focus();
      }
    }
    if (elements.cancelBtn) {
      elements.cancelBtn.disabled = false;
    }
    if (elements.saveBtn) {
      elements.saveBtn.disabled = false;
      elements.saveBtn.textContent = originalSaveLabel;
    }
    if (elements.form.dataset) {
      delete elements.form.dataset.renaming;
    }
    return;
  }

  if (elements.form.dataset) {
    delete elements.form.dataset.renaming;
  }
  if (elements.saveBtn) {
    elements.saveBtn.textContent = originalSaveLabel;
  }
}

function registerListeners() {
  elements.form?.addEventListener('submit', handleSubmit);
  elements.input?.addEventListener('input', handleInputChange);
  elements.cancelBtn?.addEventListener('click', event => {
    event.preventDefault();
    closeRenameModal({ resetForm: true });
  });
  elements.modalClose?.addEventListener('click', () => {
    closeRenameModal({ resetForm: true });
  });
  elements.modalBackdrop?.addEventListener('click', () => {
    closeRenameModal({ resetForm: true });
  });

  document.addEventListener('array:rename-request', event => {
    const { detail } = event || {};
    applyOpenState(detail);
  });

  document.addEventListener('modal:close-all', () => {
    closeRenameModal({ resetForm: true, force: true });
  });
}

export function init() {
  if (initialized) return;
  initialized = true;

  cacheElements();
  resetModalState();
  registerListeners();

  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export const __test__ = {
  normalizeName,
  mapRenameError,
};
