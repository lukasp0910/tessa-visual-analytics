const openModals = new Set();

function setModalState(element, isOpen) {
  if (!element) return;
  element.classList.toggle('hidden', !isOpen);
  if (element.setAttribute) {
    element.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  }
  if (element.dataset) {
    element.dataset.open = isOpen ? 'true' : 'false';
  }
  if (isOpen) {
    openModals.add(element);
  } else {
    openModals.delete(element);
  }
}

export function openModal(element, { focusTarget } = {}) {
  if (!element) return;
  setModalState(element, true);
  const target = focusTarget || element.querySelector('[data-modal-autofocus]');
  if (target && typeof target.focus === 'function') {
    const schedule = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (fn => setTimeout(fn, 0));
    schedule(() => {
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    });
  }
}

export function closeModal(element) {
  if (!element) return;
  setModalState(element, false);
}

export function isModalOpen(element) {
  if (!element) return false;
  if (openModals.has(element)) return true;
  if (element.dataset && element.dataset.open) {
    return element.dataset.open === 'true';
  }
  return !element.classList.contains('hidden');
}

export function getOpenModalCount() {
  return openModals.size;
}

export function closeAllModals() {
  [...openModals].forEach(modal => closeModal(modal));
}

export function showConfirmation({
  title = 'Are you sure?',
  message = 'Confirm your action.',
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
} = {}) {
  const promptMessage = [title, message].filter(Boolean).join('\n\n');
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    const confirmed = window.confirm(promptMessage);
    return Promise.resolve(confirmed);
  }
  if (typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function') {
    const confirmed = globalThis.confirm(promptMessage);
    return Promise.resolve(confirmed);
  }
  console.warn('[ui:modal] Confirmation fallback used.', { confirmLabel, cancelLabel });
  return Promise.resolve(true);
}

export const modal = {
  openModal,
  closeModal,
  isModalOpen,
  getOpenModalCount,
  closeAllModals,
  showConfirmation,
};

export default modal;
