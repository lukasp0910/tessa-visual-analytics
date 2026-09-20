const SCATTER_CHART_TYPE = 'scatter';
const REDUCTION_METHODS = [
  { value: 'pca', label: 'PCA' },
  { value: 'umap', label: 'UMAP' },
  { value: 'tsne', label: 't-SNE' },
];

function ensureScatterChartState(state) {
  if (!state.scatterChart || typeof state.scatterChart !== 'object') {
    state.scatterChart = {
      values: { columns: [], dimension: 2, reduction: '' },
      lastDataSourceId: '',
      availableColumns: [],
      multiSubject: false,
      renderToken: 0,
    };
    return;
  }

  if (!state.scatterChart.values || typeof state.scatterChart.values !== 'object') {
    state.scatterChart.values = { columns: [], dimension: 2, reduction: '' };
  }
  if (!Array.isArray(state.scatterChart.values.columns)) {
    state.scatterChart.values.columns = [];
  }
  if (state.scatterChart.values.dimension !== 2 && state.scatterChart.values.dimension !== 3) {
    state.scatterChart.values.dimension = 2;
  }
  if (typeof state.scatterChart.values.reduction !== 'string') {
    state.scatterChart.values.reduction = '';
  }
  if (!Array.isArray(state.scatterChart.availableColumns)) {
    state.scatterChart.availableColumns = [];
  }
  if (typeof state.scatterChart.lastDataSourceId !== 'string') {
    state.scatterChart.lastDataSourceId = '';
  }
  if (typeof state.scatterChart.renderToken !== 'number') {
    state.scatterChart.renderToken = 0;
  }
  if (typeof state.scatterChart.multiSubject !== 'boolean') {
    state.scatterChart.multiSubject = false;
  }
}

function normalizeColumns(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(entry => {
      if (typeof entry === 'string' && entry.trim()) {
        return entry.trim();
      }
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        return String(entry);
      }
      if (entry && typeof entry === 'object') {
        if (typeof entry.id === 'string' && entry.id.trim()) {
          return entry.id.trim();
        }
        if (typeof entry.column === 'string' && entry.column.trim()) {
          return entry.column.trim();
        }
      }
      return null;
    })
    .filter(Boolean);
}

function normalizeDimension(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return parsed === 3 ? 3 : 2;
}

function normalizeReduction(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.trim().toLowerCase();
  return REDUCTION_METHODS.some(method => method.value === normalized) ? normalized : '';
}

function commitScatterValues(state, values, { multiSubject = false } = {}) {
  ensureScatterChartState(state);
  const normalized = {
    columns: normalizeColumns(values.columns),
    dimension: normalizeDimension(values.dimension),
    reduction: normalizeReduction(values.reduction),
  };
  if (normalized.columns.length > normalized.dimension && !normalized.reduction) {
    normalized.reduction = 'pca';
  }
  if (normalized.columns.length <= normalized.dimension) {
    normalized.reduction = '';
  }
  state.scatterChart.values = normalized;

  const nextFormValues = state.formValues && typeof state.formValues === 'object'
    ? { ...state.formValues }
    : {};
  nextFormValues.columns = [...normalized.columns];
    nextFormValues.dimension = normalized.dimension;
    nextFormValues.reduction = normalized.reduction;
  state.formValues = nextFormValues;
  return normalized;
}

function buildFieldGroup() {
  const wrapper = document.createElement('div');
  wrapper.className = 'space-y-2';
  return wrapper;
}

export function registerScatterChart(core) {
  if (!core || typeof core !== 'object') {
    throw new Error('registerScatterChart requires a core integration object.');
  }

  const {
    state,
    elements,
    clearChildren,
    cloneColumnEntries,
    loadColumns,
    setModalStatus,
    registerChartModule,
    getSelectedChartType,
    getSelectedDataSourceId,
  } = core;

  ensureScatterChartState(state);

  function isScatterChartType(candidate) {
    if (!candidate) return false;
    if (typeof candidate === 'string') {
      return candidate.trim().toLowerCase() === SCATTER_CHART_TYPE;
    }
    if (candidate && typeof candidate.name === 'string') {
      return candidate.name.trim().toLowerCase() === SCATTER_CHART_TYPE;
    }
    return false;
  }

  function hideScatterLayout() {
    if (elements.standardSection) {
      elements.standardSection.classList.add('hidden');
    }
  }

  function showScatterLayout() {
    if (elements.standardSection) {
      elements.standardSection.classList.remove('hidden');
    }
    if (elements.lineSection) {
      elements.lineSection.classList.add('hidden');
    }
    if (elements.dataSourceGroup) {
      elements.dataSourceGroup.classList.remove('hidden');
    }
  }

  async function renderControls(context = {}) {
    const chartType = context.chartType || getSelectedChartType();
    if (!isScatterChartType(chartType)) {
      hideScatterLayout();
      return;
    }

    showScatterLayout();
    ensureScatterChartState(state);

    const container = elements.fieldContainer;
    if (!container) {
      return;
    }

    const token = (state.scatterChart.renderToken || 0) + 1;
    state.scatterChart.renderToken = token;

    clearChildren(container);

    const projectName = context.projectName || state.context?.projectName || '';
    const dataSourceId = context.dataSourceId || getSelectedDataSourceId();
    const preserved = state.formValues && typeof state.formValues === 'object' ? state.formValues : {};

    const scatterValues = {
      columns: normalizeColumns(state.scatterChart.values?.columns),
      dimension: normalizeDimension(state.scatterChart.values?.dimension ?? 2),
      reduction: normalizeReduction(state.scatterChart.values?.reduction ?? ''),
    };

    if (Array.isArray(preserved.columns)) {
      scatterValues.columns = normalizeColumns(preserved.columns);
    }
    if (typeof preserved.dimension !== 'undefined') {
      scatterValues.dimension = normalizeDimension(preserved.dimension);
    }
    if (typeof preserved.reduction !== 'undefined') {
      scatterValues.reduction = normalizeReduction(preserved.reduction);
    }

    const previousDataSource = state.scatterChart.lastDataSourceId || '';
    const dataSourceChanged = previousDataSource !== (dataSourceId || '');
    state.scatterChart.lastDataSourceId = dataSourceId || '';

    if (dataSourceChanged) {
      scatterValues.columns = [];
      scatterValues.reduction = '';
    }

    if (!projectName || !dataSourceId) {
      state.scatterChart.availableColumns = [];
      state.scatterChart.multiSubject = false;
      commitScatterValues(state, scatterValues, { multiSubject: false });

      const notice = document.createElement('p');
      notice.className = 'text-sm text-gray-500';
      notice.textContent = 'Select a data source to configure the scatter plot.';
      container.append(notice);
      return;
    }

    let columnEntries = [];
    let usedCache = false;
    if (
      !dataSourceChanged
      && Array.isArray(state.scatterChart.availableColumns)
      && state.scatterChart.availableColumns.length
    ) {
      columnEntries = state.scatterChart.availableColumns;
      usedCache = true;
    } else {
      try {
        columnEntries = await loadColumns(projectName, dataSourceId);
      } catch (error) {
        if (token !== state.scatterChart.renderToken) {
          return;
        }
        setModalStatus('Unable to load column metadata for this data source.', 'error');
        const errorMessage = document.createElement('p');
        errorMessage.className = 'text-sm text-red-600';
        errorMessage.textContent = 'Unable to load columns for the selected array.';
        container.append(errorMessage);
        state.scatterChart.availableColumns = [];
        state.scatterChart.multiSubject = false;
        commitScatterValues(state, scatterValues, { multiSubject: false });
        return;
      }
    }

    if (token !== state.scatterChart.renderToken) {
      return;
    }

    const clonedColumns = cloneColumnEntries(columnEntries);
    state.scatterChart.availableColumns = clonedColumns;

    const availableIds = clonedColumns.map(column => String(column.id ?? '')).filter(Boolean);
    scatterValues.columns = scatterValues.columns.filter(id => availableIds.includes(id));

    const subjectMode = state.projectMetadata?.subjectMode || 'single';
    const subjectArrays = Array.isArray(state.projectMetadata?.subjectArrays)
      ? state.projectMetadata.subjectArrays
      : [];
    const multiSubject = subjectMode === 'multi' && subjectArrays.includes(dataSourceId);
    state.scatterChart.multiSubject = multiSubject;

    if (!scatterValues.columns.length) {
      if (multiSubject && clonedColumns.length > 1) {
        scatterValues.columns = clonedColumns.slice(1).map(column => column.id);
      } else {
        scatterValues.columns = clonedColumns.map(column => column.id);
      }
    }
    if (!scatterValues.columns.length && clonedColumns.length) {
      scatterValues.columns = [clonedColumns[0].id];
    }

    scatterValues.dimension = scatterValues.dimension === 3 ? 3 : 2;
    if (scatterValues.columns.length && scatterValues.dimension > scatterValues.columns.length) {
      const maxDimension = Math.min(scatterValues.columns.length, 3);
      scatterValues.dimension = maxDimension >= 2 ? Math.min(scatterValues.dimension, maxDimension) : 2;
    }

    scatterValues.reduction = normalizeReduction(scatterValues.reduction);
    if (scatterValues.columns.length > scatterValues.dimension && !scatterValues.reduction) {
      scatterValues.reduction = 'pca';
    }
    if (scatterValues.columns.length <= scatterValues.dimension) {
      scatterValues.reduction = '';
    }

    const committedValues = commitScatterValues(state, scatterValues, { multiSubject });

    if (!clonedColumns.length) {
      const emptyMessage = document.createElement('p');
      emptyMessage.className = 'text-sm text-gray-500';
      emptyMessage.textContent = 'The selected array does not expose any columns.';
      container.append(emptyMessage);
      return;
    }

    // Column selection with enhanced UI
    const columnGroup = buildFieldGroup();
    const columnLabel = document.createElement('label');
    columnLabel.className = 'block text-sm font-medium text-gray-800';
    columnLabel.setAttribute('for', 'cardChartField-scatterColumns');
    columnLabel.textContent = 'Columns';
    columnGroup.append(columnLabel);

    // Search input
    const searchContainer = document.createElement('div');
    searchContainer.className = 'relative mt-1';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'cardChartField-scatterColumnsSearch';
    searchInput.placeholder = 'Search columns...';
    searchInput.className = 'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 pr-10 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500';
    searchInput.disabled = state.controlsDisabled;
    searchInput.setAttribute('aria-label', 'Search columns');

    const searchIcon = document.createElement('div');
    searchIcon.className = 'absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none';
    searchIcon.innerHTML = '<svg class="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>';
    searchContainer.append(searchInput);
    searchContainer.append(searchIcon);
    columnGroup.append(searchContainer);

    // Action buttons and counter
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'flex items-center justify-between mt-2';

    const counter = document.createElement('span');
    counter.className = 'text-sm text-gray-600';
    counter.setAttribute('aria-live', 'polite');
    counter.textContent = `${committedValues.columns.length} of ${clonedColumns.length} selected`;

    actionsContainer.append(counter);
    columnGroup.append(actionsContainer);

    // Collapsible columns list container
    const collapsibleContainer = document.createElement('div');
    collapsibleContainer.className = 'mt-2';

    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'flex items-center justify-between w-full px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500';
    toggleButton.setAttribute('aria-expanded', 'true');
    toggleButton.setAttribute('aria-controls', 'column-list-container');

    const toggleText = document.createElement('span');
    toggleText.textContent = 'Column List';

    const toggleIcon = document.createElement('svg');
    toggleIcon.className = 'w-4 h-4 transition-transform duration-200';
    toggleIcon.setAttribute('fill', 'none');
    toggleIcon.setAttribute('viewBox', '0 0 24 24');
    toggleIcon.setAttribute('stroke', 'currentColor');
    toggleIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />';

    toggleButton.append(toggleText);
    toggleButton.append(toggleIcon);

    const listContainer = document.createElement('div');
    listContainer.id = 'column-list-container';
    listContainer.className = 'mt-2 border border-gray-300 rounded-md max-h-60 overflow-y-auto';
    listContainer.setAttribute('role', 'listbox');
    listContainer.setAttribute('aria-label', 'Column selection list');
    listContainer.setAttribute('aria-multiselectable', 'true');

    collapsibleContainer.append(toggleButton);
    collapsibleContainer.append(listContainer);

    // Function to get filtered columns
    const getFilteredColumns = (filterText = '') => {
      return clonedColumns.filter(column => {
        const label = (column.label || column.id).toLowerCase();
        return label.includes(filterText.toLowerCase());
      });
    };

    // Function to render filtered columns
    const renderColumnList = (filterText = '') => {
      listContainer.innerHTML = '';

      const filteredColumns = getFilteredColumns(filterText);

      if (filteredColumns.length === 0) {
        const noResults = document.createElement('div');
        noResults.className = 'p-3 text-sm text-gray-500 text-center';
        noResults.textContent = 'No columns match your search.';
        listContainer.append(noResults);
        return;
      }

      filteredColumns.forEach(column => {
        if (!column || typeof column.id !== 'string') return;

        const item = document.createElement('div');
        item.className = 'flex items-center p-2 hover:bg-gray-50 focus-within:bg-gray-50';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', committedValues.columns.includes(column.id));

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `column-${column.id}`;
        checkbox.value = column.id;
        checkbox.checked = committedValues.columns.includes(column.id);
        checkbox.className = 'h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded';
        checkbox.disabled = state.controlsDisabled;
        checkbox.setAttribute('aria-label', `Select column ${column.label || column.id}`);

        const label = document.createElement('label');
        label.htmlFor = `column-${column.id}`;
        label.className = 'ml-2 block text-sm text-gray-900 cursor-pointer flex-1';
        label.textContent = column.label || column.id;

        item.append(checkbox);
        item.append(label);
        listContainer.append(item);

        // Handle checkbox change
        checkbox.addEventListener('change', () => {
          const selected = committedValues.columns.includes(column.id)
            ? committedValues.columns.filter(id => id !== column.id)
            : [...committedValues.columns, column.id];

          commitScatterValues(state, {
            ...state.scatterChart.values,
            columns: selected,
          }, { multiSubject });

          // Update counter
          counter.textContent = `${selected.length} of ${clonedColumns.length} selected`;

          // Update aria-selected
          item.setAttribute('aria-selected', selected.includes(column.id));

          // Re-render if needed for reduction logic
          renderControls({ projectName, dataSourceId }).catch(() => {});
        });
      });
    };

    // Toggle functionality
    let isExpanded = true;
    const toggleList = () => {
      isExpanded = !isExpanded;
      listContainer.classList.toggle('hidden', !isExpanded);
      toggleButton.setAttribute('aria-expanded', isExpanded.toString());
      toggleIcon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(-180deg)';
    };

    toggleButton.addEventListener('click', toggleList);

    // Initial render
    renderColumnList();

    // Search functionality
    let searchTimeout;
    searchInput.addEventListener('input', (event) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        renderColumnList(event.target.value);
      }, 150);
    });

    // Keyboard navigation
    listContainer.addEventListener('keydown', (event) => {
      const items = listContainer.querySelectorAll('[role="option"]');
      const currentIndex = Array.from(items).findIndex(item => item === document.activeElement);

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          if (currentIndex < items.length - 1) {
            items[currentIndex + 1].focus();
          }
          break;
        case 'ArrowUp':
          event.preventDefault();
          if (currentIndex > 0) {
            items[currentIndex - 1].focus();
          }
          break;
        case 'Home':
          event.preventDefault();
          if (items.length > 0) {
            items[0].focus();
          }
          break;
        case 'End':
          event.preventDefault();
          if (items.length > 0) {
            items[items.length - 1].focus();
          }
          break;
        case ' ':
        case 'Enter':
          event.preventDefault();
          const checkbox = document.activeElement.querySelector('input[type="checkbox"]');
          if (checkbox) {
            checkbox.click();
          }
          break;
      }
    });

    columnGroup.append(collapsibleContainer);

    const columnDescription = document.createElement('p');
    columnDescription.className = 'text-xs text-gray-500 mt-2';
    columnDescription.textContent = 'Select the columns that should be projected in the scatter plot.';
    columnGroup.append(columnDescription);
    container.append(columnGroup);

  }

  function collectValues() {
    ensureScatterChartState(state);
    const multiSubject = Boolean(state.scatterChart.multiSubject);
    const values = commitScatterValues(state, state.scatterChart.values || {}, { multiSubject });
    const errors = [];

    if (!values.columns.length) {
      errors.push('Select at least one column for the scatter plot.');
    }

    if (![2, 3].includes(values.dimension)) {
      errors.push('Select a valid dimensionality for the scatter plot.');
    } else if (values.columns.length < values.dimension) {
      errors.push(`Scatter plots require at least ${values.dimension} selected columns.`);
    }

    if (values.columns.length > values.dimension && !values.reduction) {
      errors.push('Choose a dimensionality reduction method.');
    }

    const payload = {
      columns: [...values.columns],
      dimension: values.dimension,
    };

    if (values.reduction) {
      payload.reduction = values.reduction;
    }

    const columnLabels = values.columns
      .map(id => state.scatterChart.availableColumns.find(column => column.id === id))
      .filter(Boolean)
      .map(column => column.label)
      .filter(label => typeof label === 'string' && label.trim())
      .map(label => label.trim());
    if (columnLabels.length) {
      payload.columnLabels = columnLabels;
    }

    payload.multiSubject = multiSubject;

    return { values: payload, errors };
  }

  function initializeScatterFromConfig(context = {}) {
    const configuration = context.configuration || state.currentConfig || null;
    if (!configuration || configuration.chartType !== SCATTER_CHART_TYPE) {
      return;
    }
    const fieldValues = configuration.fieldValues || {};
    const normalized = {
      columns: normalizeColumns(fieldValues.columns),
      dimension: normalizeDimension(fieldValues.dimension),
      reduction: normalizeReduction(fieldValues.reduction),
    };
    commitScatterValues(state, normalized, { multiSubject: Boolean(fieldValues.multiSubject) });
    state.scatterChart.multiSubject = Boolean(fieldValues.multiSubject);
    state.scatterChart.lastDataSourceId = typeof configuration.dataSourceId === 'string'
      ? configuration.dataSourceId.trim()
      : '';
  }

  const module = {
    id: SCATTER_CHART_TYPE,
    attach(context = {}) {
      const chartType = context.chartType || getSelectedChartType();
      if (!isScatterChartType(chartType)) {
        return;
      }
      renderControls(context).catch(() => {});
    },
    detach() {
      ensureScatterChartState(state);
    },
    async populateFields(context = {}) {
      await renderControls(context);
      return true;
    },
    collectConfig() {
      return collectValues();
    },
    handleDataSourceChange() {
      return false;
    },
    initializeFromConfig(context = {}) {
      initializeScatterFromConfig(context);
    },
    onControlsDisabledChange(context = {}) {
      const chartType = context.chartType || getSelectedChartType();
      if (!isScatterChartType(chartType)) {
        return;
      }
      renderControls(context).catch(() => {});
    },
    reset() {
      state.scatterChart = {
        values: { columns: [], dimension: 2, reduction: '' },
        lastDataSourceId: '',
        availableColumns: [],
        multiSubject: false,
        renderToken: 0,
      };
    },
  };

  if (typeof registerChartModule === 'function') {
    registerChartModule(SCATTER_CHART_TYPE, module);
  }

  return module;
}

export const constants = {
  SCATTER_CHART_TYPE,
  REDUCTION_METHODS,
};
