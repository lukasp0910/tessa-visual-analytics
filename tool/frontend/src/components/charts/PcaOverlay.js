// PCA component selector overlay (shows X/Y/Z dropdowns and variance)

export function createPcaOverlay({ container, pcaMetadata, dimension, onComponentChange }) {
  if (!pcaMetadata || !Array.isArray(pcaMetadata.explained_variance)) {
    return null;
  }

  const explainedVariance = pcaMetadata.explained_variance;
  const componentsCount = pcaMetadata.components_count || explainedVariance.length;
  // Always show all available components (backend computes up to 10)
  const maxDisplayComponents = componentsCount;
  const is3D = dimension === 3;

  // Find or create overlay element
  let overlay = container.querySelector('[data-pca-overlay]');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.dataset.pcaOverlay = 'true';
    // Keep overlay in top-left corner with tighter padding so it blocks less of the chart
    // min-height enforced both via utility class and inline style for consistent sizing with UMAP overlay
    overlay.className = 'absolute top-0 left-0 z-10 inline-flex items-center bg-white/90 border border-gray-200 rounded shadow-sm px-1.5 py-0.5 min-h-[1.5rem] pointer-events-auto transition-opacity duration-200';
    overlay.style.minHeight = '1.5rem';
    container.appendChild(overlay);
  }

  // Clear previous content
  overlay.innerHTML = '';

  // Create controls container with tighter spacing
  const controlsContainer = document.createElement('div');
  controlsContainer.className = 'flex items-center gap-1 min-h-[1.5rem]';
  overlay.appendChild(controlsContainer);

  // State for current selections (default: X=1, Y=2, Z=3)
  const state = {
    x: 0,
    y: Math.min(1, maxDisplayComponents - 1),
    z: is3D ? Math.min(2, maxDisplayComponents - 1) : -1,
  };

  // Format variance as percentage with long dash
  function formatVariance(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '0.0%';
    return `${(value * 100).toFixed(1)}%`;
  }
  
  // Format component label with long dash (—)
  function formatComponentLabel(index) {
    const variance = explainedVariance[index];
    return `Component ${index + 1} — ${formatVariance(variance)}`;
  }

  // Calculate total variance for current selection (2D: only X+Y, 3D: X+Y+Z)
  // Only count each unique component once (e.g., if X=1 and Y=1, only count component 1 once)
  function calculateTotalVariance() {
    const uniqueComponents = new Set();
    
    if (state.x >= 0 && state.x < explainedVariance.length) {
      uniqueComponents.add(state.x);
    }
    if (state.y >= 0 && state.y < explainedVariance.length) {
      uniqueComponents.add(state.y);
    }
    // For 3D, include Z component (even though disabled, it's still part of the projection)
    if (is3D && state.z >= 0 && state.z < explainedVariance.length) {
      uniqueComponents.add(state.z);
    }
    
    let total = 0;
    for (const componentIndex of uniqueComponents) {
      total += explainedVariance[componentIndex];
    }
    return total;
  }

  // Create dropdown for a single axis
  function createAxisDropdown(axis, label) {
    const wrapper = document.createElement('div');
    wrapper.className = 'flex items-center gap-1';

    const axisLabel = document.createElement('span');
    axisLabel.className = 'text-xs text-gray-700 font-medium';
    axisLabel.textContent = label;
    wrapper.appendChild(axisLabel);

    const select = document.createElement('select');
    // Compact styling, smaller text - enabled for both 2D and 3D
    select.className = 'text-xs border border-gray-300 rounded px-1 py-0.5 bg-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500';
    select.setAttribute('aria-label', `${label} axis component`);
    select.title = `Select principal component for ${label} axis`;

    // Populate options with all available components (backend computes up to 10)
    for (let i = 0; i < maxDisplayComponents; i++) {
      const option = document.createElement('option');
      option.value = i;
      option.textContent = formatComponentLabel(i);
      if (i === state[axis]) {
        option.selected = true;
      }
      select.appendChild(option);
    }

    // Handle change for both 2D and 3D
    select.addEventListener('change', (e) => {
      const newValue = parseInt(e.target.value, 10);
      if (newValue === state[axis]) return;
      
      state[axis] = newValue;
      updateVarianceDisplay();
      
      if (onComponentChange) {
        onComponentChange({
          x: state.x,
          y: state.y,
          z: state.z,
          totalVariance: calculateTotalVariance(),
        });
      }
    });

    wrapper.appendChild(select);
    return { wrapper, select };
  }

  // Create X, Y dropdowns (always shown)
  const xDropdown = createAxisDropdown('x', 'X');
  const yDropdown = createAxisDropdown('y', 'Y');
  
  controlsContainer.appendChild(xDropdown.wrapper);
  controlsContainer.appendChild(yDropdown.wrapper);

  // Create Z dropdown if 3D (shown but disabled)
  let zDropdown = null;
  if (is3D) {
    zDropdown = createAxisDropdown('z', 'Z');
    controlsContainer.appendChild(zDropdown.wrapper);
  }

  // Create compact variance display with separator
  const varianceDisplay = document.createElement('div');
  varianceDisplay.className = 'flex items-center gap-1 ml-1 pl-1 border-l border-gray-300';
  controlsContainer.appendChild(varianceDisplay);

  const varianceLabel = document.createElement('span');
  varianceLabel.className = 'text-xs text-gray-600';
  varianceLabel.textContent = 'Total:';
  varianceDisplay.appendChild(varianceLabel);

  const varianceValue = document.createElement('span');
  varianceValue.className = 'text-xs font-semibold text-blue-600';
  varianceValue.setAttribute('title', 'Sum of explained variance for selected components');
  varianceDisplay.appendChild(varianceValue);

  // Update variance display
  function updateVarianceDisplay() {
    const total = calculateTotalVariance();
    varianceValue.textContent = formatVariance(total);
  }

  // Initial update
  updateVarianceDisplay();

  // Return API
  return {
    destroy() {
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    },
    
    show() {
      if (overlay) {
        overlay.classList.remove('hidden');
      }
    },
    
    hide() {
      if (overlay) {
        overlay.classList.add('hidden');
      }
    },
    
    update(newMetadata) {
      // If metadata changes, rebuild the overlay
      if (newMetadata && newMetadata !== pcaMetadata) {
        this.destroy();
        return createPcaOverlay({
          container,
          pcaMetadata: newMetadata,
          dimension,
          onComponentChange,
        });
      }
      return this;
    },
    
    getSelection() {
      return {
        x: state.x,
        y: state.y,
        z: state.z,
        totalVariance: calculateTotalVariance(),
      };
    },
    
    setSelection({ x, y, z }) {
      let changed = false;
      
      if (typeof x === 'number' && x >= 0 && x < maxDisplayComponents && x !== state.x) {
        state.x = x;
        xDropdown.select.value = x;
        changed = true;
      }
      
      if (typeof y === 'number' && y >= 0 && y < maxDisplayComponents && y !== state.y) {
        state.y = y;
        yDropdown.select.value = y;
        changed = true;
      }
      
      if (is3D && typeof z === 'number' && z >= 0 && z < maxDisplayComponents && z !== state.z) {
        state.z = z;
        zDropdown.select.value = z;
        changed = true;
      }
      
      if (changed) {
        updateVarianceDisplay();
        if (onComponentChange) {
          onComponentChange({
            x: state.x,
            y: state.y,
            z: state.z,
            totalVariance: calculateTotalVariance(),
          });
        }
      }
    },
  };
}
