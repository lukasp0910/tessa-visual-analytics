import { deleteProject as apiDeleteProject } from '../api/projects.js';
import { byId } from '../ui/dom.js';
import { showConfirmationDialog } from '../ui/confirm.js';

const FEATURE_NAME = 'dangerousActions';

const elements = {};
let initialized = false;

function cacheElements() {
  elements.deleteProjectBtn = byId('deleteProjectBtn');
  elements.projectSelect = byId('projectSelect');
  elements.projectDetailsBtn = byId('projectDetailsBtn');
  elements.uploadStatus = byId('uploadStatus');
}

function setUploadStatus(message, { isError = false } = {}) {
  if (!elements.uploadStatus) return;
  elements.uploadStatus.textContent = message;
  elements.uploadStatus.classList.toggle('text-red-600', isError);
  elements.uploadStatus.classList.toggle('text-gray-600', !isError);
}

function projectDisplayName(project, fallback = '') {
  if (project && typeof project === 'object') {
    if (typeof project.title === 'string' && project.title.trim()) {
      return project.title.trim();
    }
    const candidates = [
      project.display_name,
      project.displayName,
      project.name,
      project.filename,
      project.file_name,
      project.fileName,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback.trim();
  }
  return '';
}

function handleProjectsUpdated(event) {
  const projects = event.detail?.projects || [];
  const select = elements.projectSelect;
  if (!select) return;
  const selected = select.value;
  const exists = projects.some(project => project?.name === selected);
  elements.deleteProjectBtn.disabled = !exists;
  elements.projectDetailsBtn.disabled = !exists;
}

async function handleDeleteProject() {
  const { deleteProjectBtn, projectSelect, projectDetailsBtn } = elements;
  if (!projectSelect) return;
  const selected = projectSelect.value;
  if (!selected) return;

  const projectLabel = projectDisplayName({ name: selected }, selected) || selected;
  const confirmed = await showConfirmationDialog({
    title: 'Delete project?',
    message: `Delete project "${projectLabel}" and all of its arrays? This cannot be undone.`,
    confirmLabel: 'Delete project',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) {
    return;
  }

  if (deleteProjectBtn) deleteProjectBtn.disabled = true;
  if (projectDetailsBtn) projectDetailsBtn.disabled = true;
  setUploadStatus(`Deleting project: ${projectLabel}…`);

  try {
    const result = await apiDeleteProject(selected);
    const removal = [];
    if (result?.removed_from_disk) removal.push('disk');
    if (result?.removed_from_memory) removal.push('RAM');
    if (result?.removed_directory) removal.push('folder');
    const suffix = removal.length ? ` (${removal.join(' & ')})` : '';
    setUploadStatus(`Deleted project: ${projectLabel}${suffix}`);

    document.dispatchEvent(new CustomEvent('project:deleted', {
      detail: { projectName: selected },
    }));

    document.dispatchEvent(new CustomEvent('projects:refresh-requested', {
      detail: { reason: 'project-deleted', deletedProject: selected },
    }));

    document.dispatchEvent(new CustomEvent('project:selected', {
      detail: { projectName: null, project: null },
    }));
  } catch (error) {
    console.error('[Feature:dangerousActions] Failed to delete project', error);
    setUploadStatus(`Failed to delete "${projectLabel}": ${error?.message ?? 'Unexpected error.'}`, { isError: true });
    if (deleteProjectBtn) deleteProjectBtn.disabled = false;
    if (projectDetailsBtn) projectDetailsBtn.disabled = false;
  }
}

function attachEventListeners() {
  elements.deleteProjectBtn?.addEventListener('click', () => {
    handleDeleteProject().catch(error => {
      console.error('[Feature:dangerousActions] Unexpected error while deleting project', error);
    });
  });

  document.addEventListener('projects:updated', handleProjectsUpdated);
}

export function init() {
  if (initialized) return;
  cacheElements();
  if (!elements.projectSelect || !elements.deleteProjectBtn) {
    console.warn('[Feature:dangerousActions] Required elements not found.');
    return;
  }
  attachEventListeners();
  initialized = true;
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };
