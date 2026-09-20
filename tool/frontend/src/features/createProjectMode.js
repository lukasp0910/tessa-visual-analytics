import { byId } from '../ui/dom.js';
import { openModal, closeModal } from '../ui/modal.js';

const FEATURE_NAME = 'createProjectMode';

const elements = {};
let initialized = false;

function cacheElements() {
  elements.modeModal = byId('createProjectModeModal');
  elements.modeBackdrop = document.querySelector('[data-modal="create-project-mode-backdrop"]');
  elements.modeClose = byId('createProjectModeClose');
  elements.openBtn = byId('createProjectOpenBtn');
  elements.scratchBtn = byId('createProjectModeScratchBtn');
  elements.uploadBtn = byId('createProjectModeUploadBtn');
  elements.createProjectModal = byId('createProjectModal');
  elements.uploadProjectModal = byId('uploadProjectModal');
  elements.uploadProjectFileInput = byId('uploadProjectFileInput');
}

function openModeModal() {
  openModal(elements.modeModal, { focusTarget: elements.scratchBtn });
}

function handleScratch() {
  closeModal(elements.modeModal);
  // Dispatch event for createProject feature
  document.dispatchEvent(new CustomEvent('create-project:open-requested'));
  // Fallback if modal exists
  if (elements.createProjectModal) {
    openModal(elements.createProjectModal);
  }
}

function handleUpload() {
  closeModal(elements.modeModal);
  if (elements.uploadProjectModal) {
    openModal(elements.uploadProjectModal, { focusTarget: elements.uploadProjectFileInput });
  }
}

function attachEvents() {
  elements.openBtn?.addEventListener('click', event => {
    event.preventDefault();
    openModeModal();
  });
  elements.modeClose?.addEventListener('click', () => closeModal(elements.modeModal));
  elements.modeBackdrop?.addEventListener('click', () => closeModal(elements.modeModal));
  elements.scratchBtn?.addEventListener('click', handleScratch);
  elements.uploadBtn?.addEventListener('click', handleUpload);
}

export function init() {
  if (initialized) return;
  cacheElements();
  if (!elements.openBtn || !elements.modeModal) {
    console.warn('[Feature:createProjectMode] Required elements not found.');
    return;
  }
  attachEvents();
  initialized = true;
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };