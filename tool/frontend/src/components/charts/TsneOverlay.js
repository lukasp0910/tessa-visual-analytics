// T-SNE live iteration controls overlay

export function createTsneOverlay({ container, controller, onStop, onRun, initialParams }) {
  // Find or create overlay element
  let overlay = container.querySelector('[data-tsne-overlay]');
  const isNewOverlay = !overlay;
  
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.dataset.tsneOverlay = 'true';
    // Match PCA/UMAP overlay styling: top-left corner with tighter padding
    // Inline-flex layout + min-height keeps box size matched with other overlays
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

  // State for current iteration and status
  const state = {
    iteration: 0,
    maxIterations: null,
    status: 'running',
  };

  // Parameter state - use provided initial values or defaults
  const params = {
    perplexity: typeof initialParams?.perplexity === 'number' ? initialParams.perplexity : 50,
    learningRate: typeof initialParams?.learningRate === 'number' ? initialParams.learningRate : 500,
  };

  // Create iteration counter display
  const iterationWrapper = document.createElement('div');
  iterationWrapper.className = 'flex items-center gap-1';

  const iterationLabel = document.createElement('span');
  iterationLabel.className = 'text-xs text-gray-700 font-medium';
  iterationLabel.textContent = 'Iteration:';
  iterationWrapper.appendChild(iterationLabel);

  const iterationValue = document.createElement('span');
  iterationValue.className = 'text-xs font-semibold text-gray-900 min-w-[3rem]';
  iterationValue.textContent = '0';
  iterationValue.setAttribute('title', 'Current iteration / Maximum iterations');
  iterationWrapper.appendChild(iterationValue);

  controlsContainer.appendChild(iterationWrapper);

  // Create state indicator
  const stateIndicator = document.createElement('span');
  stateIndicator.className = 'rounded bg-gray-200 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-gray-600';
  stateIndicator.textContent = 'RUNNING';
  stateIndicator.setAttribute('title', 'Current t-SNE status');
  controlsContainer.appendChild(stateIndicator);

  // Create button container (will hold Stop button OR Run button)
  const buttonContainer = document.createElement('div');
  buttonContainer.className = 'flex items-center gap-1 ml-1';
  controlsContainer.appendChild(buttonContainer);

  // Create Stop button
  const stopButton = document.createElement('button');
  stopButton.type = 'button';
  stopButton.className = 'px-2 py-0.5 text-[0.65rem] font-medium text-gray-700 border border-gray-300 rounded hover:bg-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors disabled:cursor-not-allowed disabled:opacity-60';
  stopButton.textContent = 'Stop';
  stopButton.setAttribute('aria-label', 'Stop t-SNE computation');
  stopButton.title = 'Stop t-SNE computation';

  stopButton.addEventListener('click', (e) => {
    e.preventDefault();
    if (onStop) {
      onStop();
    }
  });

  buttonContainer.appendChild(stopButton);

  // Create parameters container (will hold sliders + Run button when not running)
  const parametersContainer = document.createElement('div');
  parametersContainer.className = 'flex items-center gap-2 ml-1';
  parametersContainer.style.display = 'none'; // Hidden initially
  controlsContainer.appendChild(parametersContainer);

  // Create Perplexity slider
  const perplexityWrapper = document.createElement('div');
  perplexityWrapper.className = 'flex items-center gap-1';

  const perplexityLabel = document.createElement('label');
  perplexityLabel.className = 'text-xs text-gray-700';
  perplexityLabel.textContent = 'Perplexity:';
  perplexityWrapper.appendChild(perplexityLabel);

  const perplexityInput = document.createElement('input');
  perplexityInput.type = 'range';
  perplexityInput.min = '5';
  perplexityInput.max = '100';
  perplexityInput.step = '1';
  perplexityInput.value = String(params.perplexity);
  perplexityInput.className = 'w-20 h-1';
  perplexityInput.title = 'Controls neighborhood size. Typical range for large datasets: 30–100. Higher = more global structure, lower = more local detail.';
  perplexityWrapper.appendChild(perplexityInput);

  const perplexityValue = document.createElement('span');
  perplexityValue.className = 'text-xs font-semibold text-gray-900 min-w-[2rem] text-center';
  perplexityValue.textContent = String(params.perplexity);
  perplexityWrapper.appendChild(perplexityValue);

  perplexityInput.addEventListener('input', (e) => {
    params.perplexity = parseInt(e.target.value, 10);
    perplexityValue.textContent = String(params.perplexity);
  });

  parametersContainer.appendChild(perplexityWrapper);

  // Create Learning Rate slider
  const learningRateWrapper = document.createElement('div');
  learningRateWrapper.className = 'flex items-center gap-1';

  const learningRateLabel = document.createElement('label');
  learningRateLabel.className = 'text-xs text-gray-700';
  learningRateLabel.textContent = 'Learning rate:';
  learningRateWrapper.appendChild(learningRateLabel);

  const learningRateInput = document.createElement('input');
  learningRateInput.type = 'range';
  learningRateInput.min = '50';
  learningRateInput.max = '2000';
  learningRateInput.step = '50';
  learningRateInput.value = String(params.learningRate);
  learningRateInput.className = 'w-20 h-1';
  learningRateInput.title = 'Optimization step size. Typical values for large datasets: 200–2000. Increase if embedding collapses; decrease if results look unstable.';
  learningRateWrapper.appendChild(learningRateInput);

  const learningRateValue = document.createElement('span');
  learningRateValue.className = 'text-xs font-semibold text-gray-900 min-w-[2rem] text-center';
  learningRateValue.textContent = String(params.learningRate);
  learningRateWrapper.appendChild(learningRateValue);

  learningRateInput.addEventListener('input', (e) => {
    params.learningRate = parseInt(e.target.value, 10);
    learningRateValue.textContent = String(params.learningRate);
  });

  parametersContainer.appendChild(learningRateWrapper);

  // Create Run button
  const runButton = document.createElement('button');
  runButton.type = 'button';
  runButton.className = 'px-2 py-0.5 text-[0.65rem] font-medium text-white bg-blue-600 border border-blue-700 rounded hover:bg-blue-700 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors disabled:cursor-not-allowed disabled:opacity-60';
  runButton.textContent = 'Run';
  runButton.setAttribute('aria-label', 'Run t-SNE with new parameters');
  runButton.title = 'Run t-SNE with current parameters';

  runButton.addEventListener('click', (e) => {
    e.preventDefault();
    if (onRun) {
      onRun({
        perplexity: params.perplexity,
        learningRate: params.learningRate,
      });
    }
  });

  parametersContainer.appendChild(runButton);

  // Update display based on current state
  function updateDisplay() {
    // Update iteration display
    const maxIter = state.maxIterations;
    iterationValue.textContent = maxIter 
      ? `${state.iteration} / ${maxIter}`
      : `${state.iteration}`;

    // Update state indicator
    const currentStatus = state.status.toLowerCase();
    
    // Map status to display text
    let statusText = state.status.toUpperCase();
    if (currentStatus === 'completed') {
      statusText = 'FINISHED';
    }
    stateIndicator.textContent = statusText;
    
    // Update state indicator color based on status
    stateIndicator.className = 'rounded px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide';
    if (currentStatus === 'running') {
      stateIndicator.classList.add('bg-green-100', 'text-green-700');
    } else if (currentStatus === 'stopped') {
      stateIndicator.classList.add('bg-yellow-100', 'text-yellow-700');
    } else if (currentStatus === 'completed') {
      stateIndicator.classList.add('bg-blue-100', 'text-blue-700');
    } else if (currentStatus === 'error') {
      stateIndicator.classList.add('bg-red-100', 'text-red-700');
    } else {
      stateIndicator.classList.add('bg-gray-200', 'text-gray-600');
    }

    // Update UI visibility based on state
    const isRunning = currentStatus === 'running';
    const terminal = ['completed', 'stopped', 'error'].includes(currentStatus);
    
    // Show Stop button only when running
    if (isRunning) {
      buttonContainer.style.display = 'flex';
      parametersContainer.style.display = 'none';
      stopButton.disabled = !Boolean(controller);
    } 
    // Show parameters + Run button when stopped, finished, or error
    else if (terminal) {
      buttonContainer.style.display = 'none';
      parametersContainer.style.display = 'flex';
    }
    // Default: show stop button
    else {
      buttonContainer.style.display = 'flex';
      parametersContainer.style.display = 'none';
      stopButton.disabled = true;
    }
  }

  // Initial update
  updateDisplay();

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
    
    updateState({ iteration, maxIterations, status }) {
      let changed = false;
      
      if (typeof iteration === 'number' && iteration !== state.iteration) {
        state.iteration = iteration;
        changed = true;
      }
      
      if (typeof maxIterations === 'number' && maxIterations !== state.maxIterations) {
        state.maxIterations = maxIterations;
        changed = true;
      }
      
      if (typeof status === 'string' && status !== state.status) {
        state.status = status;
        changed = true;
      }
      
      if (changed) {
        updateDisplay();
      }
    },
    
    getState() {
      return {
        iteration: state.iteration,
        maxIterations: state.maxIterations,
        status: state.status,
      };
    },
    
    getParameters() {
      return {
        perplexity: params.perplexity,
        learningRate: params.learningRate,
      };
    },
  };
}
