import { byId, qsa } from '../ui/dom.js';
import { closeModal, openModal } from '../ui/modal.js';

const FEATURE_NAME = 'dataGuidelines';

const elements = {
  modal: null,
  closeBtn: null,
  dismissBtn: null,
  backdrop: null,
  triggers: [],
};

let initialized = false;

function cacheElements() {
  elements.modal = byId('dataGuidelinesModal');
  elements.closeBtn = byId('dataGuidelinesCloseBtn');
  elements.dismissBtn = byId('dataGuidelinesDismissBtn');
  elements.backdrop = document.querySelector('[data-modal="data-guidelines-backdrop"]');
  elements.triggers = qsa('[data-action="open-data-guidelines"]');
}

function handleOpen(event) {
  if (event) {
    event.preventDefault();
  }
  if (!elements.modal) return;
  const focusTarget = elements.dismissBtn || elements.closeBtn || elements.modal;
  openModal(elements.modal, { focusTarget });
}

function handleClose(event) {
  if (event) {
    event.preventDefault();
  }
  if (!elements.modal) return;
  closeModal(elements.modal);
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    handleClose(event);
  }
}

function attachEventListeners() {
  if (!elements.modal) return;

  elements.triggers.forEach(trigger => {
    trigger?.addEventListener('click', handleOpen);
  });

  elements.closeBtn?.addEventListener('click', handleClose);
  elements.dismissBtn?.addEventListener('click', handleClose);
  elements.backdrop?.addEventListener('click', handleClose);
  elements.modal?.addEventListener('keydown', handleKeydown);
}

export function init() {
  if (initialized) return;
  cacheElements();

  if (!elements.modal) {
    console.warn('[Feature:dataGuidelines] Modal element not found.');
    return;
  }

  attachEventListeners();
  initialized = true;
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };
