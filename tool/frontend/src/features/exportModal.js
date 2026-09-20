import { listProjects } from '../api/projects.js';
import { byId } from '../ui/dom.js';

const FEATURE_NAME = 'exportModal';

const state = {
  initialized: false,
  selectedProject: null,
  projects: [],
};

const elements = {};

function cacheElements() {
  elements.exportBtn = byId('exportBtn');
  elements.modal = byId('exportModal');
  elements.backdrop = byId('exportBackdrop');
  elements.closeBtn = byId('exportModalClose');
  elements.cancelBtn = byId('exportCancelBtn');
  elements.downloadBtn = byId('exportDownloadBtn');
  elements.projectList = byId('exportProjectList');
  elements.status = byId('exportStatus');
}

function openModal() {
  if (!elements.modal) return;
  elements.modal.classList.remove('hidden');
  elements.modal.setAttribute('aria-hidden', 'false');
  loadProjectList();
}

function closeModal() {
  if (!elements.modal) return;
  elements.modal.classList.add('hidden');
  elements.modal.setAttribute('aria-hidden', 'true');
  state.selectedProject = null;
  if (elements.downloadBtn) {
    elements.downloadBtn.disabled = true;
  }
}

function setStatus(message) {
  if (!elements.status) return;
  elements.status.textContent = message;
}

async function loadProjectList() {
  if (!elements.projectList) return;
  
  setStatus('Loading projects...');
  elements.projectList.innerHTML = '';
  
  try {
    const response = await listProjects();
    const projects = Array.isArray(response) ? response : [];
    state.projects = projects;
    
    if (projects.length === 0) {
      setStatus('No projects available to export.');
      return;
    }
    
    renderProjectList(projects);
    setStatus(`${projects.length} project${projects.length !== 1 ? 's' : ''} available.`);
  } catch (error) {
    console.error('[Feature:exportModal] Failed to load projects', error);
    setStatus('Failed to load projects. Please try again.');
  }
}

function renderProjectList(projects) {
  if (!elements.projectList) return;
  
  elements.projectList.innerHTML = '';
  
  projects.forEach(project => {
    const projectName = project.name || project.filename || 'Unnamed Project';
    const displayName = project.title || project.display_name || projectName;
    
    const item = document.createElement('label');
    item.className = 'flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 transition hover:bg-gray-50 cursor-pointer';
    
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'exportProject';
    radio.value = projectName;
    radio.className = 'h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500';
    radio.addEventListener('change', () => handleProjectSelection(projectName));
    
    const labelWrapper = document.createElement('div');
    labelWrapper.className = 'flex-1';
    
    const title = document.createElement('div');
    title.className = 'text-sm font-medium text-gray-900';
    title.textContent = displayName;
    
    labelWrapper.appendChild(title);
    
    if (project.description) {
      const description = document.createElement('div');
      description.className = 'text-xs text-gray-500 mt-1';
      description.textContent = project.description;
      labelWrapper.appendChild(description);
    }
    
    item.appendChild(radio);
    item.appendChild(labelWrapper);
    elements.projectList.appendChild(item);
  });
}

function handleProjectSelection(projectName) {
  state.selectedProject = projectName;
  if (elements.downloadBtn) {
    elements.downloadBtn.disabled = false;
  }
}

async function handleDownload() {
  if (!state.selectedProject) return;
  
  const projectName = encodeURIComponent(state.selectedProject);
  const downloadUrl = `http://127.0.0.1:8000/api/v1/projects/${projectName}/export`;
  
  setStatus('Preparing download...');
  
  try {
    const response = await fetch(downloadUrl);
    
    if (!response.ok) {
      throw new Error(`Download failed: ${response.statusText}`);
    }
    
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    
    // Trigger download via temp link
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `${state.selectedProject.replace('.npz', '')}.zip`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Cleanup blob URL
    setTimeout(() => {
      window.URL.revokeObjectURL(blobUrl);
    }, 100);
    
    setStatus('Download started.');
    
    // Close modal after delay
    setTimeout(() => {
      closeModal();
    }, 1000);
  } catch (error) {
    console.error('[Feature:exportModal] Download failed', error);
    setStatus(`Download failed: ${error.message}`);
  }
}

function attachEventListeners() {
  elements.exportBtn?.addEventListener('click', openModal);
  elements.closeBtn?.addEventListener('click', closeModal);
  elements.cancelBtn?.addEventListener('click', closeModal);
  elements.downloadBtn?.addEventListener('click', handleDownload);
  elements.backdrop?.addEventListener('click', closeModal);
  
  // Close modal on Escape key
  elements.modal?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModal();
    }
  });
}

export function init() {
  if (state.initialized) return;
  cacheElements();
  
  if (!elements.exportBtn) {
    console.warn('[Feature:exportModal] Export button not found.');
    return;
  }
  
  state.initialized = true;
  attachEventListeners();
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };
