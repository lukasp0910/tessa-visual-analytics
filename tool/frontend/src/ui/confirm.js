import { byId } from './dom.js';
import { closeModal, openModal } from './modal.js';

const CONFIRM_BUTTON_TONES = {
  danger:
    'rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50',
  primary:
    'rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50',
};

const elements = {};
let initialized = false;
let activeConfirmation = null;

function cacheElements() {
  elements.confirmModal = byId('confirmModal');
  elements.confirmModalBackdrop = document.querySelector('[data-modal="confirm-backdrop"]');
  elements.confirmModalTitle = byId('confirmModalTitle');
  elements.confirmModalMessage = byId('confirmModalMessage');
  elements.confirmModalConfirmBtn = byId('confirmModalConfirmBtn');
  elements.confirmModalCancelBtn = byId('confirmModalCancelBtn');
  elements.confirmModalCloseBtn = byId('confirmModalClose');
}

function applyConfirmationTone(tone) {
  if (!elements.confirmModalConfirmBtn) return;
  const classes = CONFIRM_BUTTON_TONES[tone] || CONFIRM_BUTTON_TONES.primary;
  elements.confirmModalConfirmBtn.className = classes;
}

function resetConfirmationDialog() {
  if (elements.confirmModalTitle) elements.confirmModalTitle.textContent = '';
  if (elements.confirmModalMessage) elements.confirmModalMessage.textContent = '';
  if (elements.confirmModalConfirmBtn) {
    elements.confirmModalConfirmBtn.textContent = 'Confirm';
    elements.confirmModalConfirmBtn.disabled = false;
  }
  if (elements.confirmModalCancelBtn) {
    elements.confirmModalCancelBtn.textContent = 'Cancel';
    elements.confirmModalCancelBtn.disabled = false;
  }
}

function finalizeConfirmation(result) {
  if (!activeConfirmation) {
    closeModal(elements.confirmModal);
    return false;
  }
  const { resolve } = activeConfirmation;
  activeConfirmation = null;
  closeModal(elements.confirmModal);
  resetConfirmationDialog();
  resolve(result);
  return true;
}

function cancelConfirmation() {
  return finalizeConfirmation(false);
}

function attachConfirmationListeners() {
  elements.confirmModalConfirmBtn?.addEventListener('click', () => {
    finalizeConfirmation(true);
  });

  elements.confirmModalCancelBtn?.addEventListener('click', event => {
    event.preventDefault();
    cancelConfirmation();
  });

  elements.confirmModalCloseBtn?.addEventListener('click', () => {
    cancelConfirmation();
  });

  elements.confirmModalBackdrop?.addEventListener('click', () => {
    cancelConfirmation();
  });
}

export function initConfirmationModal() {
  if (initialized) return;
  cacheElements();
  if (!elements.confirmModal || !elements.confirmModalConfirmBtn || !elements.confirmModalCancelBtn) {
    console.warn('[ui:confirm] Confirmation modal elements not found. Falling back to native dialogs.');
    initialized = true;
    return;
  }
  attachConfirmationListeners();
  initialized = true;
}

export function showConfirmationDialog({
  title = 'Confirm action',
  message = 'Are you sure you want to continue?',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
} = {}) {
  if (!initialized) {
    initConfirmationModal();
  }

  if (!elements.confirmModal || !elements.confirmModalConfirmBtn || !elements.confirmModalCancelBtn) {
    const promptMessage = [title, message].filter(Boolean).join('\n\n');
    const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(promptMessage)
      : true;
    return Promise.resolve(confirmed);
  }

  if (activeConfirmation) {
    finalizeConfirmation(false);
  }

  applyConfirmationTone(tone);
  if (elements.confirmModalTitle) elements.confirmModalTitle.textContent = title;
  if (elements.confirmModalMessage) elements.confirmModalMessage.textContent = message;
  elements.confirmModalConfirmBtn.textContent = confirmLabel;
  elements.confirmModalCancelBtn.textContent = cancelLabel;

  return new Promise(resolve => {
    activeConfirmation = { resolve };
    openModal(elements.confirmModal, { focusTarget: elements.confirmModalConfirmBtn });
  });
}

export default {
  initConfirmationModal,
  showConfirmationDialog,
};
