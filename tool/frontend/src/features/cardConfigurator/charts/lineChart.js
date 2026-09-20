// Line chart configuration module for card configurator
// Manages multiple measures (Y-axes) against a shared dimension (X-axis)

const LINE_CHART_TYPE = 'line';
const MAX_LINE_MEASURES = 5;

function ensureLineChartState(state) {
  if (!state.lineChart || typeof state.lineChart !== 'object') {
    state.lineChart = { measures: [] };
  } else if (!Array.isArray(state.lineChart.measures)) {
    state.lineChart.measures = [];
  }
}

export function registerLineChart(core) {
  if (!core || typeof core !== 'object') {
    throw new Error('registerLineChart requires a core integration object.');
  }

  const {
    state,
    elements,
    clearChildren,
    cloneColumnEntries,
    getColumnsCacheKey,
    loadColumns,
    setModalStatus,
    describeDataSource,
    generateMeasureId,
    registerChartModule,
    getSelectedChartType,
    getDataSourceEntry,
  } = core;

  ensureLineChartState(state);

  function isLineChartType(candidate) {
    if (!candidate) return false;
    const name = typeof candidate === 'string'
      ? candidate
      : (candidate && typeof candidate.name === 'string' ? candidate.name : '');
    if (!name) return false;
    return name.toLowerCase() === LINE_CHART_TYPE;
  }

  function hideLayout() {
    if (elements.lineSection) {
      elements.lineSection.classList.add('hidden');
    }
    if (elements.standardSection) {
      elements.standardSection.classList.remove('hidden');
    }
    if (elements.dataSourceGroup) {
      elements.dataSourceGroup.classList.remove('hidden');
    }
  }

  function showLayout() {
    if (elements.dataSourceGroup) {
      elements.dataSourceGroup.classList.add('hidden');
    }
    if (elements.standardSection) {
      elements.standardSection.classList.add('hidden');
    }
    if (elements.lineSection) {
      elements.lineSection.classList.remove('hidden');
    }
  }

  function resetState() {
    state.lineChart = { measures: [] };
    if (elements.measureList) {
      clearChildren(elements.measureList);
    }
    if (elements.addMeasureBtn) {
      elements.addMeasureBtn.disabled = Boolean(state.controlsDisabled);
    }
  }

  function createMeasure(initial = {}) {
    const measure = {
      id: generateMeasureId(),
      sourceId: '',
      columnId: '',
      columnLabel: '',
      multiSubject: false,
      availableColumns: [],
      loading: false,
      requestToken: 0,
    };

    if (initial && typeof initial === 'object') {
      if (typeof initial.id === 'string' && initial.id.trim()) {
        measure.id = initial.id.trim();
      }
      const sourceId = typeof initial.sourceId === 'string' && initial.sourceId.trim()
        ? initial.sourceId.trim()
        : (typeof initial.source === 'string' && initial.source.trim() ? initial.source.trim() : '');
      measure.sourceId = sourceId;

      const columnId = typeof initial.columnId === 'string' && initial.columnId.trim()
        ? initial.columnId.trim()
        : (typeof initial.column === 'string' && initial.column.trim() ? initial.column.trim() : '');
      measure.columnId = columnId;

      const columnLabel = typeof initial.columnLabel === 'string' && initial.columnLabel.trim()
        ? initial.columnLabel.trim()
        : (typeof initial.column_label === 'string' && initial.column_label.trim()
          ? initial.column_label.trim()
          : '');
      measure.columnLabel = columnLabel;

      if (typeof initial.multiSubject === 'boolean') {
        measure.multiSubject = initial.multiSubject;
      } else if (typeof initial.multi_subject === 'boolean') {
        measure.multiSubject = initial.multi_subject;
      } else if (typeof initial.requiresSubject === 'boolean') {
        measure.multiSubject = initial.requiresSubject;
      } else if (typeof initial.subjectRequired === 'boolean') {
        measure.multiSubject = initial.subjectRequired;
      }

      if (Array.isArray(initial.availableColumns)) {
        measure.availableColumns = [...initial.availableColumns];
      } else if (Array.isArray(initial.columns)) {
        measure.availableColumns = [...initial.columns];
      }
    }

    return measure;
  }

  function normalizeMeasure(entry) {
    if (!entry || typeof entry !== 'object') {
      return createMeasure();
    }

    if (typeof entry.id !== 'string' || !entry.id.trim()) {
      entry.id = generateMeasureId();
    } else {
      entry.id = entry.id.trim();
    }

    if (typeof entry.sourceId !== 'string' || !entry.sourceId.trim()) {
      const fallbackSource = typeof entry.source === 'string' && entry.source.trim() ? entry.source.trim() : '';
      entry.sourceId = fallbackSource;
    } else {
      entry.sourceId = entry.sourceId.trim();
    }

    if (typeof entry.columnId !== 'string' || !entry.columnId.trim()) {
      const fallbackColumn = typeof entry.column === 'string' && entry.column.trim() ? entry.column.trim() : '';
      entry.columnId = fallbackColumn;
    } else {
      entry.columnId = entry.columnId.trim();
    }

    if (typeof entry.columnLabel !== 'string' || !entry.columnLabel.trim()) {
      const fallbackLabel = typeof entry.column_label === 'string' && entry.column_label.trim()
        ? entry.column_label.trim()
        : '';
      entry.columnLabel = fallbackLabel;
    } else {
      entry.columnLabel = entry.columnLabel.trim();
    }

    const normalizedColumns = cloneColumnEntries(
      Array.isArray(entry.availableColumns) && entry.availableColumns.length
        ? entry.availableColumns
        : entry.columns,
    );
    entry.availableColumns = normalizedColumns;

    if (typeof entry.multiSubject !== 'boolean') {
      if (typeof entry.multi_subject === 'boolean') {
        entry.multiSubject = entry.multi_subject;
      } else if (typeof entry.requiresSubject === 'boolean') {
        entry.multiSubject = entry.requiresSubject;
      } else if (typeof entry.subjectRequired === 'boolean') {
        entry.multiSubject = entry.subjectRequired;
      } else {
        entry.multiSubject = false;
      }
    }
    entry.multiSubject = Boolean(entry.multiSubject);

    if (entry.columnId) {
      const matched = normalizedColumns.find(column => column.id === entry.columnId);
      if (matched) {
        entry.columnLabel = matched.label;
      }
    }

    entry.loading = Boolean(entry.loading);
    entry.requestToken = Number.isInteger(entry.requestToken) ? entry.requestToken : 0;

    return entry;
  }

  function ensureMeasures() {
    ensureLineChartState(state);
    if (!state.lineChart.measures.length) {
      state.lineChart.measures.push(createMeasure());
    }
  }

  function resetMeasureSelection(measure) {
    if (!measure) return;
    measure.sourceId = '';
    measure.columnId = '';
    measure.columnLabel = '';
    measure.multiSubject = false;
    measure.availableColumns = [];
    measure.loading = false;
    measure.requestToken = 0;
  }

  function applyCachedColumnsToMeasure(projectName, measure) {
    if (!measure || !measure.sourceId) {
      measure.availableColumns = [];
      return false;
    }

    const cacheKey = getColumnsCacheKey(projectName, measure.sourceId);
    if (!state.columnCache.has(cacheKey)) {
      return false;
    }

    const cached = state.columnCache.get(cacheKey) || [];
    const normalized = cloneColumnEntries(cached);
    measure.availableColumns = normalized;
    measure.loading = false;
    if (measure.columnId) {
      const matched = normalized.find(column => column.id === measure.columnId);
      if (matched) {
        measure.columnLabel = matched.label;
      } else {
        measure.columnId = '';
        measure.columnLabel = '';
      }
    } else {
      measure.columnLabel = '';
    }
    return true;
  }

  function requestColumnsForMeasure(projectName, measure) {
    if (!measure || !measure.sourceId || measure.loading) {
      return;
    }

    const token = (Number.isInteger(measure.requestToken) ? measure.requestToken : 0) + 1;
    measure.requestToken = token;
    measure.loading = true;
    measure.availableColumns = [];

    loadColumns(projectName, measure.sourceId)
      .then(columns => {
        const normalized = cloneColumnEntries(columns);
        state.columnCache.set(getColumnsCacheKey(projectName, measure.sourceId), normalized);
        if (measure.requestToken !== token) {
          return;
        }
        measure.availableColumns = cloneColumnEntries(normalized);
        if (measure.columnId) {
          const matched = measure.availableColumns.find(column => column.id === measure.columnId);
          if (matched) {
            measure.columnLabel = matched.label;
          } else {
            measure.columnId = '';
            measure.columnLabel = '';
          }
        } else {
          measure.columnLabel = '';
        }
      })
      .catch(error => {
        console.error('[Feature:cardConfigurator] Failed to load columns for', measure.sourceId, error);
        if (measure.requestToken !== token) {
          return;
        }
        measure.availableColumns = [];
        measure.columnId = '';
        measure.columnLabel = '';
        setModalStatus('Unable to load column metadata for this data source.', 'error');
      })
      .finally(() => {
        if (measure.requestToken !== token) {
          return;
        }
        measure.loading = false;
        renderControls();
      });
  }

  function buildMeasureElement(measure, index, sources, disableAll, projectName) {
    const wrapper = document.createElement('div');
    wrapper.className = 'space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm';
    wrapper.dataset.measureId = measure.id;

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-2';

    const title = document.createElement('h4');
    title.className = 'text-sm font-semibold text-gray-800';
    title.textContent = `Measure ${index + 1}`;
    header.append(title);

    if (state.lineChart.measures.length > 1) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'text-sm font-medium text-red-600 transition hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2';
      removeBtn.textContent = 'Remove';
      removeBtn.disabled = disableAll;
      removeBtn.addEventListener('click', () => handleRemoveMeasure(measure.id));
      header.append(removeBtn);
    }

    wrapper.append(header);

    const grid = document.createElement('div');
    grid.className = 'grid gap-3 sm:grid-cols-3';

    const sourceGroup = document.createElement('div');
    sourceGroup.className = 'space-y-1.5';
    const sourceLabel = document.createElement('label');
    sourceLabel.className = 'block text-xs font-medium text-gray-600';
    sourceLabel.textContent = 'Data source';
    sourceGroup.append(sourceLabel);

    const sourceSelect = document.createElement('select');
    sourceSelect.className = 'mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500';
    sourceSelect.dataset.measureSource = measure.id;
    sourceSelect.disabled = disableAll || !sources.length;

    const sourcePlaceholder = document.createElement('option');
    sourcePlaceholder.value = '';
    sourcePlaceholder.textContent = sources.length ? 'Select an array' : 'No aligned arrays available';
    sourcePlaceholder.disabled = true;
    sourcePlaceholder.selected = !measure.sourceId;
    sourceSelect.append(sourcePlaceholder);

    sources.forEach(entry => {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = describeDataSource(entry);
      if (entry.id === measure.sourceId) {
        option.selected = true;
      }
      sourceSelect.append(option);
    });

    sourceSelect.addEventListener('change', event => {
      if (disableAll) return;
      handleMeasureSourceChange(measure.id, event.target.value);
    });

    sourceGroup.append(sourceSelect);
    grid.append(sourceGroup);

    const columnGroup = document.createElement('div');
    columnGroup.className = 'space-y-1.5';
    const columnLabel = document.createElement('label');
    columnLabel.className = 'block text-xs font-medium text-gray-600';
    columnLabel.textContent = 'Column';
    columnGroup.append(columnLabel);

    const columnSelect = document.createElement('select');
    columnSelect.className = 'mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500';
    columnSelect.dataset.measureColumn = measure.id;

    if (!measure.sourceId) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Select a data source first';
      option.disabled = true;
      option.selected = true;
      columnSelect.append(option);
      columnSelect.disabled = true;
    } else if (measure.loading) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Loading columns…';
      option.disabled = true;
      option.selected = true;
      columnSelect.append(option);
      columnSelect.disabled = true;
    } else if (!measure.availableColumns.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No columns available';
      option.disabled = true;
      option.selected = true;
      columnSelect.append(option);
      columnSelect.disabled = true;
    } else {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select a column';
      placeholder.disabled = true;
      placeholder.selected = !measure.columnId;
      columnSelect.append(placeholder);
      measure.availableColumns.forEach(column => {
        if (!column || typeof column.id !== 'string') return;
        const option = document.createElement('option');
        option.value = column.id;
        option.textContent = column.label;
        if (column.id === measure.columnId) {
          option.selected = true;
        }
        columnSelect.append(option);
      });
      columnSelect.disabled = disableAll;
    }

    columnSelect.addEventListener('change', event => {
      if (columnSelect.disabled) return;
      handleMeasureColumnChange(measure.id, event.target.value);
    });

    columnGroup.append(columnSelect);
    grid.append(columnGroup);

    wrapper.append(grid);
    return wrapper;
  }

  function renderControls() {
    const chartType = getSelectedChartType();
    if (!isLineChartType(chartType)) {
      hideLayout();
      return;
    }

    showLayout();

    const projectName = state.context?.projectName || '';

    if (elements.lineDimensionSelect) {
      elements.lineDimensionSelect.innerHTML = '';
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Time axis';
      option.selected = true;
      elements.lineDimensionSelect.append(option);
      elements.lineDimensionSelect.disabled = true;
    }

    const sources = state.dataSourceCache.get(projectName || '') || [];
    const alignedSources = Array.isArray(sources) ? [...sources] : [];

    ensureMeasures();

    if (elements.measureList) {
      clearChildren(elements.measureList);
    }

    const disableAll = state.controlsDisabled || !alignedSources.length;

    if (elements.addMeasureBtn) {
      elements.addMeasureBtn.disabled = disableAll
        || state.lineChart.measures.length >= MAX_LINE_MEASURES;
    }

    if (!alignedSources.length) {
      if (elements.measureList) {
        const notice = document.createElement('p');
        notice.className = 'text-sm text-gray-500';
        notice.textContent = 'No data sources available for the selected project.';
        elements.measureList.append(notice);
      }
      return;
    }

    for (let index = 0; index < state.lineChart.measures.length; index += 1) {
      const measure = normalizeMeasure(state.lineChart.measures[index]);
      state.lineChart.measures[index] = measure;

      const sourceIsAligned = alignedSources.some(source => source.id === measure.sourceId);
      if (!sourceIsAligned) {
        resetMeasureSelection(measure);
      }

      if (measure.sourceId) {
        const hasCachedColumns = applyCachedColumnsToMeasure(projectName, measure);
        if (!hasCachedColumns && !measure.loading) {
          requestColumnsForMeasure(projectName, measure);
        }
      } else {
        measure.availableColumns = [];
        measure.loading = false;
        measure.requestToken = 0;
      }

      const element = buildMeasureElement(measure, index, alignedSources, disableAll, projectName);
      elements.measureList?.append(element);
    }
  }

  function handleMeasureSourceChange(measureId, nextSourceId) {
    if (!Array.isArray(state.lineChart.measures)) return;
    const measure = state.lineChart.measures.find(entry => entry?.id === measureId);
    if (!measure) return;
    const value = typeof nextSourceId === 'string' ? nextSourceId : '';
    if (measure.sourceId === value) return;

    const nextToken = Number.isInteger(measure.requestToken) ? measure.requestToken + 1 : 0;
    measure.requestToken = nextToken;
    measure.sourceId = value;
    measure.columnId = '';
    measure.columnLabel = '';
    measure.availableColumns = [];
    measure.loading = false;

    renderControls();
  }

  function handleMeasureColumnChange(measureId, nextColumnId) {
    if (!Array.isArray(state.lineChart.measures)) return;
    const measure = state.lineChart.measures.find(entry => entry?.id === measureId);
    if (!measure) return;
    const nextId = typeof nextColumnId === 'string' ? nextColumnId : '';
    measure.columnId = nextId;
    const matched = measure.availableColumns.find(column => column.id === nextId);
    measure.columnLabel = matched ? matched.label : '';
  }

  function addMeasure() {
    if (!Array.isArray(state.lineChart.measures)) {
      state.lineChart.measures = [];
    }
    if (state.lineChart.measures.length >= MAX_LINE_MEASURES) {
      return;
    }
    state.lineChart.measures.push(createMeasure());
    renderControls();
  }

  function handleRemoveMeasure(measureId) {
    if (!Array.isArray(state.lineChart.measures)) return;
    if (state.lineChart.measures.length <= 1) return;
    const index = state.lineChart.measures.findIndex(entry => entry?.id === measureId);
    if (index < 0) return;
    state.lineChart.measures.splice(index, 1);
    renderControls();
  }

  function collectValues() {
    const values = {};
    const errors = [];
    const measures = Array.isArray(state.lineChart.measures) ? state.lineChart.measures : [];
    const normalized = [];

    measures.forEach((measure, index) => {
      if (!measure || typeof measure !== 'object') {
        errors.push(`Measure ${index + 1} requires a data source.`);
        errors.push(`Measure ${index + 1} requires a column.`);
        return;
      }
      const sourceId = typeof measure.sourceId === 'string' ? measure.sourceId.trim() : '';
      const columnId = typeof measure.columnId === 'string' ? measure.columnId.trim() : '';
      if (!sourceId) {
        errors.push(`Measure ${index + 1} requires a data source.`);
      }
      if (!columnId) {
        errors.push(`Measure ${index + 1} requires a column.`);
      }
      if (sourceId && columnId) {
        const matchedColumn = Array.isArray(measure.availableColumns)
          ? measure.availableColumns.find(column => column.id === columnId)
          : null;
        const columnLabel = matchedColumn
          ? matchedColumn.label
          : (typeof measure.columnLabel === 'string' && measure.columnLabel.trim() ? measure.columnLabel.trim() : '');
        normalized.push({
          id: measure.id,
          source: sourceId,
          sourceId,
          column: columnId,
          columnId,
          multiSubject: false,
          multi_subject: false,
          ...(columnLabel ? { columnLabel, column_label: columnLabel } : {}),
        });
      }
    });

    if (!normalized.length && errors.length === 0) {
      errors.push('Add at least one measure to configure the line chart.');
    }

    values.measures = normalized;
    return { values, errors };
  }

  function initializeLineModuleFromConfig() {
    const measures = [];
    const fieldValues = state.currentConfig?.fieldValues || {};

    if (Array.isArray(fieldValues.measures) && fieldValues.measures.length) {
      fieldValues.measures.forEach(entry => {
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const sourceId = typeof entry.source === 'string' && entry.source.trim()
          ? entry.source.trim()
          : (typeof entry.source_id === 'string' && entry.source_id.trim()
            ? entry.source_id.trim()
            : (typeof entry.sourceId === 'string' ? entry.sourceId.trim() : ''));
        const columnId = typeof entry.column === 'string' && entry.column.trim()
          ? entry.column.trim()
          : (typeof entry.column_id === 'string' && entry.column_id.trim()
            ? entry.column_id.trim()
            : (typeof entry.columnId === 'string' ? entry.columnId.trim() : ''));
        const columnLabel = typeof entry.columnLabel === 'string' && entry.columnLabel.trim()
          ? entry.columnLabel.trim()
          : (typeof entry.column_label === 'string' && entry.column_label.trim()
            ? entry.column_label.trim()
            : '');
        const identifier = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : '';
          measures.push({ id: identifier, sourceId, columnId, columnLabel });
      });
    } else if (Array.isArray(fieldValues.y) && fieldValues.y.length) {
      const defaultSource = typeof state.currentConfig?.dataSourceId === 'string'
        ? state.currentConfig.dataSourceId
        : '';
      fieldValues.y.forEach(value => {
        if (typeof value !== 'string' || !value.trim()) {
          return;
        }
        measures.push({ sourceId: defaultSource, columnId: value.trim(), columnLabel: '' });
      });
    } else if (typeof fieldValues.y === 'string' && fieldValues.y.trim()) {
      const defaultSource = typeof state.currentConfig?.dataSourceId === 'string'
        ? state.currentConfig.dataSourceId
        : '';
      measures.push({ sourceId: defaultSource, columnId: fieldValues.y.trim(), columnLabel: '' });
    }

    if (!measures.length) {
      measures.push({});
    }

    state.lineChart = {
      measures: measures.map(entry => {
        const measure = normalizeMeasure(createMeasure(entry));
        measure.loading = false;
        measure.requestToken = 0;
        return measure;
      }),
    };
  }

  function handleLineDataSourceChange() {
    const chartType = getSelectedChartType();
    if (isLineChartType(chartType)) {
      return true;
    }
    return false;
  }

  function handleControlsDisabledChange() {
    renderControls();
  }

  function prepareSubmission({ values, projectName }) {
    const measures = Array.isArray(values.measures) ? values.measures : [];
    const enrichedMeasures = measures.map(measure => {
      const sourceId = typeof measure?.source === 'string'
        ? measure.source
        : (typeof measure?.sourceId === 'string' ? measure.sourceId : '');
      const columnId = typeof measure?.column === 'string'
        ? measure.column
        : (typeof measure?.columnId === 'string' ? measure.columnId : '');
      const entry = getDataSourceEntry(projectName, sourceId);
      const cacheKey = getColumnsCacheKey(projectName, sourceId);
      const columns = state.columnCache.get(cacheKey) || [];
      const columnEntry = Array.isArray(columns)
        ? columns.find(column => column?.id === columnId)
        : null;
      const columnLabel = columnEntry
        ? columnEntry.label
        : (typeof measure?.columnLabel === 'string' && measure.columnLabel.trim()
          ? measure.columnLabel.trim()
          : columnId);
      const identifier = typeof measure?.id === 'string' && measure.id ? measure.id : generateMeasureId();
      return {
        ...measure,
        id: identifier,
        source: sourceId,
        sourceId,
        column: columnId,
        columnId,
        multiSubject: Boolean(measure?.multiSubject),
        multi_subject: Boolean(measure?.multiSubject),
        source_label: entry ? describeDataSource(entry) : sourceId,
        columnLabel,
        column_label: columnLabel,
      };
    });
    values.measures = enrichedMeasures;

    const uniqueSources = Array.from(new Set(enrichedMeasures.map(entry => entry.source).filter(Boolean)));
    if (uniqueSources.length === 1) {
      const sourceId = uniqueSources[0];
      const entry = getDataSourceEntry(projectName, sourceId);
      return {
        dataSourceId: sourceId,
        dataSourceLabel: entry ? describeDataSource(entry) : sourceId,
      };
    }
    if (uniqueSources.length > 1) {
      return {
        dataSourceId: 'multiple',
        dataSourceLabel: `${uniqueSources.length} data sources`,
      };
    }
    return {
      dataSourceId: '',
      dataSourceLabel: 'No data source selected',
    };
  }

  const module = {
    id: LINE_CHART_TYPE,
    attach(context = {}) {
      const chartType = context.chartType || getSelectedChartType();
      if (!isLineChartType(chartType)) {
        return;
      }
      renderControls();
    },
    detach(context = {}) {
      hideLayout();
      if (context.reason === 'unregister') {
        resetState();
      }
    },
    populateFields() {
      renderControls();
      return true;
    },
    collectConfig(context = {}) {
      const { values, errors } = collectValues();
      if (errors.length) {
        return { values, errors };
      }
      const projectName = context.projectName || state.context?.projectName || '';
      const outcome = prepareSubmission({ values, projectName }) || {};
      const submissionErrors = Array.isArray(outcome.errors) ? outcome.errors : [];
      if (submissionErrors.length) {
        return { values, errors: submissionErrors };
      }
      return {
        values,
        errors: [],
        dataSourceId: typeof outcome.dataSourceId === 'string' ? outcome.dataSourceId : '',
        dataSourceLabel: typeof outcome.dataSourceLabel === 'string' ? outcome.dataSourceLabel : '',
      };
    },
    handleDataSourceChange(context = {}) {
      return handleLineDataSourceChange();
    },
    handleAddMeasure() {
      addMeasure();
    },
    initializeFromConfig(context = {}) {
      initializeLineModuleFromConfig();
    },
    onControlsDisabledChange() {
      handleControlsDisabledChange();
    },
    reset() {
      resetState();
    },
  };

  if (typeof registerChartModule === 'function') {
    registerChartModule(LINE_CHART_TYPE, module);
  }

  return module;
}

export const constants = {
  LINE_CHART_TYPE,
  MAX_LINE_MEASURES,
};
