// UMAP parameter controls overlay

export function createUmapOverlay({ container, neighbours = 15, onRun }) {
  // Find or create overlay element
  let overlay = container.querySelector('[data-umap-overlay]');
  const isNewOverlay = !overlay;
  
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.dataset.umapOverlay = 'true';
    // Match PCA overlay styling: top-left corner with tighter padding
    // Inline-flex layout + min-height keeps box size matched with PCA overlay
    overlay.className = 'absolute top-0 left-0 z-10 inline-flex items-center bg-white/90 border border-gray-200 rounded shadow-sm px-1.5 py-0.5 min-h-[1.5rem] pointer-events-auto transition-opacity duration-200';
    overlay.style.minHeight = '1.5rem';
    
    // Prevent all pointer events from bubbling to chart (set once on creation)
    const stopPropagation = (e) => e.stopPropagation();
    overlay.addEventListener('pointerdown', stopPropagation);
    overlay.addEventListener('pointermove', stopPropagation);
    overlay.addEventListener('pointerup', stopPropagation);
    overlay.addEventListener('pointercancel', stopPropagation);
    overlay.addEventListener('dblclick', stopPropagation);
    overlay.addEventListener('wheel', stopPropagation, { passive: false });
    overlay.addEventListener('mousedown', stopPropagation);
    overlay.addEventListener('mousemove', stopPropagation);
    overlay.addEventListener('mouseup', stopPropagation);
    overlay.addEventListener('click', stopPropagation);
    
    container.appendChild(overlay);
  }

  // Clear previous content
  overlay.innerHTML = '';

  // Create controls container with tighter spacing
  const controlsContainer = document.createElement('div');
  controlsContainer.className = 'flex items-center gap-2 min-h-[1.5rem]';
  overlay.appendChild(controlsContainer);

  // State for current neighbours value
  const state = {
    neighbours: Math.max(5, Math.min(50, neighbours)),
  };

  // Create slider control for Neighbours
  const sliderWrapper = document.createElement('div');
  sliderWrapper.className = 'flex items-center gap-1';

  const sliderLabel = document.createElement('span');
  sliderLabel.className = 'text-xs text-gray-700 font-medium';
  sliderLabel.textContent = 'Neighbours:';
  sliderWrapper.appendChild(sliderLabel);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '5';
  slider.max = '50';
  slider.step = '1';
  slider.value = state.neighbours.toString();
  slider.className = 'w-24 h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500';
  slider.setAttribute('aria-label', 'Number of neighbours for UMAP');
  slider.title = 'Number of neighbours (5-50)';
  sliderWrapper.appendChild(slider);

  const valueDisplay = document.createElement('span');
  valueDisplay.className = 'text-xs font-medium text-gray-700 min-w-[1.5rem] text-center';
  valueDisplay.textContent = state.neighbours.toString();
  sliderWrapper.appendChild(valueDisplay);

  // Update value display when slider changes
  slider.addEventListener('input', (e) => {
    const newValue = parseInt(e.target.value, 10);
    state.neighbours = newValue;
    valueDisplay.textContent = newValue.toString();
  });

  controlsContainer.appendChild(sliderWrapper);

  // Create Run button
  const runButton = document.createElement('button');
  runButton.type = 'button';
  runButton.className = 'px-2 py-0.5 text-xs font-medium text-white bg-blue-500 rounded hover:bg-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors cursor-pointer';
  runButton.textContent = 'Run';
  runButton.setAttribute('aria-label', 'Run UMAP reduction');
  runButton.title = 'Run UMAP dimensionality reduction';

  runButton.addEventListener('click', (e) => {
    e.preventDefault();
    if (onRun) {
      onRun({
        neighbours: state.neighbours,
      });
    }
  });

  controlsContainer.appendChild(runButton);

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
    
    getParameters() {
      return {
        neighbours: state.neighbours,
      };
    },
    
    setParameters({ neighbours }) {
      if (typeof neighbours === 'number' && neighbours >= 5 && neighbours <= 50 && neighbours !== state.neighbours) {
        state.neighbours = neighbours;
        slider.value = neighbours.toString();
        valueDisplay.textContent = neighbours.toString();
      }
    },
    
    setLoading(isLoading) {
      const loading = !!isLoading;
      slider.disabled = loading;
      runButton.disabled = loading;
      
      if (loading) {
        slider.style.opacity = '0.5';
        slider.style.cursor = 'not-allowed';
        runButton.style.opacity = '0.5';
        runButton.style.cursor = 'not-allowed';
        runButton.textContent = 'Computing...';
      } else {
        slider.style.opacity = '';
        slider.style.cursor = 'pointer';
        runButton.style.opacity = '';
        runButton.style.cursor = 'pointer';
        runButton.textContent = 'Run';
      }
    },
  };
}
