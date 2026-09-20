import { requestJson } from '../../api/client.js';
import LineChart from '../../components/charts/LineChart.js';
import ScatterChart from '../../components/charts/ScatterChart.js';
import { ScatterProgressPoller } from './scatterProgressPoller.js';
import { TsneLiveController } from './tsneLiveController.js';
import { sanitizeText, parseDatasetIdentifier } from './cardsSanitizers.js';
import { getSnapshot } from '../../state/store.js';
import { setClusterFilter, subscribeAll as subscribeToClusterFilter } from '../../state/clusterFilter.js';
import {
  getDefaultStageLabel,
  getInitialStage,
  getStageForPercentage,
} from '../../components/charts/reductionStages.js';

const cardVisualizations = new Map();
const chartResponseCache = new Map();
let currentProjectName = null;
const subjectSelectionByProject = new Map();

const UMAP_OPTIMIZING_STAGE_KEY = 'optimizing layout';
const UMAP_OPTIMIZING_SUBSTAGES = [
  { min: 55, label: 'Optimizing layout · coarse placement' },
  { min: 62, label: 'Optimizing layout · refining neighborhoods' },
  { min: 70, label: 'Optimizing layout · balancing clusters' },
  { min: 78, label: 'Optimizing layout · smoothing clusters' },
  { min: 86, label: 'Optimizing layout · fine adjustments' },
  { min: 92, label: 'Optimizing layout · preparing embedding' },
];
const SCATTER_CLUSTER_ENDPOINT = '/api/v1/charts/scatter/cluster';

function normalizeSubjectValue(value) {
  const text = sanitizeText(value);
  if (!text) return null;
  if (text === '0') return null;
  return text;
}

function getProjectByName(projectName) {
  const normalized = sanitizeText(projectName);
  if (!normalized) return null;
  const snapshot = getSnapshot();
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  return projects.find(entry => entry?.name === normalized) || null;
}

function getDefaultSubjectsForProject(projectName) {
  const project = getProjectByName(projectName);
  if (!project) return [];
  const mapping = project.subject_names ?? project.subjectNames ?? {};
  return Object.keys(mapping)
    .map(normalizeSubjectValue)
    .filter(Boolean);
}

function getSubjectLabelForProject(projectName, subjectId) {
  const project = getProjectByName(projectName);
  if (!project) return null;
  const mapping = project.subject_names ?? project.subjectNames ?? {};
  const label = mapping?.[subjectId];
  const normalized = typeof label === 'string' ? label.trim() : '';
  return normalized || null;
}

function getSubjectSelectionForProject(projectName) {
  const normalized = sanitizeText(projectName);
  if (!normalized) return [];
  if (subjectSelectionByProject.has(normalized)) {
    return subjectSelectionByProject.get(normalized) || [];
  }
  const defaults = getDefaultSubjectsForProject(normalized);
  subjectSelectionByProject.set(normalized, defaults);
  return defaults;
}

function setSubjectSelectionForProject(projectName, subjects) {
  const normalized = sanitizeText(projectName);
  if (!normalized) return [];
  const normalizedSubjects = Array.isArray(subjects)
    ? subjects.map(normalizeSubjectValue).filter(Boolean)
    : [];
  subjectSelectionByProject.set(normalized, normalizedSubjects);
  return normalizedSubjects;
}

function applySubjectSelectionToLineCharts(projectName) {
  const normalizedProject = sanitizeText(projectName);
  if (!normalizedProject) return;
  const selection = getSubjectSelectionForProject(normalizedProject);
  cardVisualizations.forEach(record => {
    if (record.type !== 'line' || !record.chart) return;
    const chartProject = sanitizeText(record.chart.options?.projectName);
    if (chartProject && chartProject === normalizedProject) {
      if (typeof record.chart.setSubjectSelection === 'function') {
        record.chart.setSubjectSelection(selection);
      } else {
        record.chart.options.subjects = selection;
        record.chart.refresh?.();
      }
    }
  });
}

function applySubjectSelectionToScatterCharts(projectName) {
  const normalizedProject = sanitizeText(projectName);
  if (!normalizedProject) return;
  const selection = getSubjectSelectionForProject(normalizedProject);
  cardVisualizations.forEach((record, cardId) => {
    if (record.type !== 'scatter') return;
    const chartProject = sanitizeText(record.projectName || record.chart?.options?.projectName);
    if (!chartProject || chartProject !== normalizedProject) return;
    const target = record.target || record.container?.parentNode;
    if (!target || !record.detail || !record.sheetId) return;
    if (record.chart && typeof record.chart.setSubjectSelection === 'function') {
      try {
        record.chart.setSubjectSelection(selection);
      } catch (error) {
        console.warn('[Feature:cards] Failed to apply subject selection to scatter chart', error);
      }
    }
    try {
      ensureScatterChart(target, cardId, record.detail, {
        projectName: normalizedProject,
        sheetId: record.sheetId,
      });
    } catch (error) {
      console.warn('[Feature:cards] Failed to re-render scatter chart after subject change', error);
    }
  });
}

function handleSubjectSelectorChange(event) {
  const detail = event?.detail || {};
  const projectName = sanitizeText(detail.projectName);
  if (!projectName) return;
  const subjects = Array.isArray(detail.subjects) ? detail.subjects : [];
  setSubjectSelectionForProject(projectName, subjects);
  applySubjectSelectionToLineCharts(projectName);
  applySubjectSelectionToScatterCharts(projectName);
}

document.addEventListener('subject-selector:changed', handleSubjectSelectorChange);

async function runScatterClustering(record, detail) {
  if (!record?.chart || record.type !== 'scatter') return;
  const eps = Number(detail?.eps);
  const minSamples = Number(detail?.minSamples);
  if (!Number.isFinite(eps) || eps <= 0 || !Number.isFinite(minSamples) || minSamples < 1) {
    record.chart.setError?.('Invalid clustering parameters.');
    return;
  }

  const payload = typeof record.chart.getClusterPayload === 'function'
    ? record.chart.getClusterPayload()
    : null;
  if (!payload || payload.dimension !== 2 || !Array.isArray(payload.points) || !payload.points.length) {
    record.chart.setError?.('Scatter data not ready for clustering.');
    return;
  }

  record.chart.setLoading?.('Running DBSCAN clustering…');
  try {
    const response = await requestJson(SCATTER_CLUSTER_ENDPOINT, {
      method: 'POST',
      body: {
        algorithm: 'dbscan',
        dimension: payload.dimension,
        points: payload.points,
        rowIndices: payload.rowIndices ?? undefined,
        eps,
        minSamples,
      },
    });

    const applied = typeof record.chart.applyClusterLabels === 'function'
      ? record.chart.applyClusterLabels(response)
      : false;
    if (!applied) {
      record.chart.setError?.('Failed to apply clustering labels.');
    } else if (record.sheetId) {
      try {
        setClusterFilter(record.sheetId, {
          labels: response?.labels,
          rowIndices: response?.rowIndices ?? payload.rowIndices,
          eps,
          minSamples,
          algorithm: 'dbscan',
        });
      } catch (error) {
        console.warn('[Feature:cards] Failed to sync clustering filter state', error);
      }
    }
  } catch (error) {
    console.error('[Feature:cards] Failed to run scatter clustering', error);
    record.chart.setError?.('Failed to run clustering.');
  }
}

function handleScatterClusterUi(event) {
  const detail = event?.detail || {};
  const cardId = detail.cardId;
  if (!cardId) return;
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter') return;
  runScatterClustering(record, detail);
}

document.addEventListener('scatter:cluster-ui', handleScatterClusterUi);

subscribeToClusterFilter(({ sheetId, cluster }) => {
  if (!sheetId) return;
  if (cluster && cluster.labels && cluster.labels.length) return;
  cardVisualizations.forEach(record => {
    if (record.type !== 'scatter') return;
    if (!record.chart || record.sheetId !== sheetId) return;
    if (typeof record.chart.clearClusterLabels === 'function') {
      record.chart.clearClusterLabels();
    }
  });
});

function normalizeStageLabel(label) {
  return typeof label === 'string' ? label.trim().toLowerCase() : '';
}

function getUmapOptimizingSubstageLabel(percentage) {
  if (!Number.isFinite(percentage)) {
    return null;
  }
  for (let i = UMAP_OPTIMIZING_SUBSTAGES.length - 1; i >= 0; i -= 1) {
    if (percentage >= UMAP_OPTIMIZING_SUBSTAGES[i].min) {
      return UMAP_OPTIMIZING_SUBSTAGES[i].label;
    }
  }
  return null;
}

function createProgressSmoother() {
  const state = {
    method: null,
    syntheticPercentage: null,
    stageKey: null,
    lastUpdate: 0,
  };

  function resetState() {
    state.syntheticPercentage = null;
    state.stageKey = null;
    state.lastUpdate = 0;
  }

  return {
    reset() {
      state.method = null;
      resetState();
    },
    transform({ method, percentage, status, stageLabel }) {
      const normalizedMethod = typeof method === 'string' ? method.trim().toLowerCase() : '';
      if (state.method && normalizedMethod && state.method !== normalizedMethod) {
        resetState();
      }
      if (normalizedMethod) {
        state.method = normalizedMethod;
      }

      if (status === 'completed' || status === 'error' || percentage >= 100) {
        resetState();
        return { percentage, stageLabel };
      }

      if (normalizedMethod !== 'umap' || !Number.isFinite(percentage)) {
        if (normalizedMethod !== 'umap') {
          resetState();
        }
        return { percentage, stageLabel };
      }

      const normalizedStage = normalizeStageLabel(stageLabel);
      const isOptimizing = normalizedStage.includes(UMAP_OPTIMIZING_STAGE_KEY);
      if (!isOptimizing) {
        state.stageKey = normalizedStage;
        state.syntheticPercentage = null;
        state.lastUpdate = Date.now();
        return { percentage, stageLabel };
      }

      const now = Date.now();
      const base = Number.isFinite(state.syntheticPercentage)
        ? state.syntheticPercentage
        : Math.max(percentage, 55);
      const elapsedMs = state.stageKey === UMAP_OPTIMIZING_STAGE_KEY && state.lastUpdate
        ? Math.max(0, now - state.lastUpdate)
        : 0;
      const ratePerSecond = 1.5; // gently advance ~1.5% per second while backend is quiet
      const increment = elapsedMs > 0 ? (elapsedMs / 1000) * ratePerSecond : ratePerSecond * 0.5;
      let next = Math.max(percentage, base + increment);
      next = Math.min(95, next);

      state.stageKey = UMAP_OPTIMIZING_STAGE_KEY;
      state.syntheticPercentage = next;
      state.lastUpdate = now;

      const enrichedLabel = getUmapOptimizingSubstageLabel(next);
      return {
        percentage: next,
        stageLabel: enrichedLabel || stageLabel,
        preferStageLabelMessage: Boolean(enrichedLabel),
      };
    },
  };
}

function stopLiveTsne(record, { notifyBackend = false } = {}) {
  if (!record) return;
  if (record.tsneController) {
    try {
      record.tsneController.stop({ notifyBackend });
    } catch (error) {
      console.warn('[Feature:cards] Failed to stop t-SNE controller', error);
    }
    record.tsneController = null;
  }
  // Clear T-SNE controller from chart
  if (record.chart && typeof record.chart.setTsneController === 'function') {
    record.chart.setTsneController(null);
  }
}

function updateTsneOverlay(record, state = {}) {
  if (!record?.chart) return;
  if (typeof record.chart.updateTsneState !== 'function') return;

  const iteration = Number(state.iteration) || 0;
  const maxIterations = Number.isFinite(state.maxIterations) ? Number(state.maxIterations) : null;
  const currentState = typeof state.state === 'string' ? state.state.toLowerCase() : 'running';

  record.chart.updateTsneState({
    iteration,
    maxIterations,
    status: currentState,
  });
}

function handleTsnePayload(record, payload, { projectId, sheetId, cardId }) {
  if (!record?.chart) return;
  stopLiveTsne(record);

  try {
    record.chart.setData(payload);
  } catch (error) {
    console.warn('[Feature:cards] Failed to render t-SNE payload', error);
  }

  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
  if (!sessionId) {
    return;
  }

  // Set sampling to 5% for t-SNE sessions
  if (typeof record.chart.setSamplingPercentage === 'function') {
    record.chart.setSamplingPercentage(5);
  }

  const controller = new TsneLiveController({ sessionId, projectId, sheetId, cardId });
  record.tsneController = controller;
  
  // Set the controller in the chart to create the overlay
  if (record.chart && typeof record.chart.setTsneController === 'function') {
    record.chart.setTsneController(controller);
  }
  
  // Update initial state
  updateTsneOverlay(record, payload || {});

  controller.onUpdate(data => {
    if (!record.chart) return;
    if (Array.isArray(data?.points) && data.points.length) {
      try {
        record.chart.updateLivePoints(data.points);
      } catch (error) {
        console.warn('[Feature:cards] Failed to update t-SNE points', error);
      }
    }
    updateTsneOverlay(record, data || {});
  });

  controller.onStateChange(data => {
    updateTsneOverlay(record, data || {});
    const state = typeof data?.state === 'string' ? data.state.toLowerCase() : '';
    if (state === 'error' && data?.message && record.chart?.setError) {
      record.chart.setError(data.message);
    }
  });

  controller.start();
}

const SCATTER_CHART_ENDPOINT = '/api/v1/charts/scatter';
const ALLOWED_REDUCTIONS = ['pca', 'umap', 'tsne'];

function resolveStageLabel({ method, message, status, percentage, fallbackLabel }) {
  const trimmedMessage = typeof message === 'string' ? message.trim() : '';
  if (trimmedMessage) {
    return trimmedMessage.replace(/\s+\.\.\.$/, '…');
  }

  const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : '';
  if (normalizedStatus === 'completed') {
    return 'Completed';
  }
  if (normalizedStatus === 'error') {
    return 'Failed';
  }

  if (Number.isFinite(percentage)) {
    const stage = getStageForPercentage(method, percentage);
    if (stage?.label) {
      return stage.label;
    }
  }

  if (fallbackLabel) {
    return fallbackLabel;
  }

  return getDefaultStageLabel(method);
}

function stopScatterProgressPoller(record) {
  if (!record) return;

  if (typeof record.progressUnsubscribe === 'function') {
    try {
      record.progressUnsubscribe();
    } catch (error) {
      console.warn('[Feature:cards] Failed to detach scatter progress listener', error);
    }
    record.progressUnsubscribe = null;
  }

  if (record.progressPoller) {
    try {
      record.progressPoller.stop();
      if (typeof record.progressPoller.clearListeners === 'function') {
        record.progressPoller.clearListeners();
      }
    } catch (error) {
      console.warn('[Feature:cards] Failed to stop scatter progress poller', error);
    }
    record.progressPoller = null;
  }

  if (record.progressSmoother && typeof record.progressSmoother.reset === 'function') {
    record.progressSmoother.reset();
  }
}

function startScatterProgressPoller(record, {
  projectId,
  sheetId,
  cardId,
  chart,
  fallbackMessage,
  reductionMethod = null,
}) {
  if (!record || !projectId || !sheetId || !cardId || !chart) {
    return null;
  }

  stopScatterProgressPoller(record);

  if (record?.progressSmoother && typeof record.progressSmoother.reset === 'function') {
    record.progressSmoother.reset();
  }

  const normalizedReduction = typeof reductionMethod === 'string'
    ? reductionMethod.trim().toLowerCase()
    : null;

  const initialStage = getInitialStage(normalizedReduction);
  let defaultMessage = typeof fallbackMessage === 'string' && fallbackMessage.trim()
    ? fallbackMessage.trim()
    : initialStage?.label
      ? `${initialStage.label}…`
      : 'Computing dimensionality reduction…';
  let lastStageLabel = initialStage?.label || getDefaultStageLabel(normalizedReduction);

  const poller = new ScatterProgressPoller({ projectId, sheetId, cardId });
  const unsubscribe = poller.addListener(({ percentage, status, message, method }) => {
    if (!record || record.chart !== chart) {
      return;
    }

    const resolvedMethod = typeof method === 'string' && method.trim()
      ? method.trim().toLowerCase()
      : normalizedReduction;

    if (!message && resolvedMethod && resolvedMethod !== normalizedReduction) {
      const stage = getInitialStage(resolvedMethod);
      if (stage?.label) {
        defaultMessage = `${stage.label}…`;
      }
    }

    const normalizedPercentage = Number.isFinite(percentage)
      ? Math.max(0, Math.min(percentage, 100))
      : null;
    const stageLabel = resolveStageLabel({
      method: resolvedMethod,
      message,
      status,
      percentage: normalizedPercentage,
      fallbackLabel: lastStageLabel,
    });
    const smoother = record?.progressSmoother;
    const smoothingResult = smoother && typeof smoother.transform === 'function'
      ? smoother.transform({
        method: resolvedMethod,
        percentage: normalizedPercentage,
        status,
        stageLabel,
      })
      : null;
    const displayPercentage = Number.isFinite(smoothingResult?.percentage)
      ? smoothingResult.percentage
      : normalizedPercentage;
    const displayStageLabel = smoothingResult?.stageLabel || stageLabel;
    lastStageLabel = displayStageLabel;

    const trimmedMessage = typeof message === 'string' ? message.trim() : '';
    const preferStageLabelMessage = Boolean(smoothingResult?.preferStageLabelMessage);
    const shouldUseMessage = trimmedMessage
      && !preferStageLabelMessage
      && (!displayStageLabel || trimmedMessage.toLowerCase() !== displayStageLabel.toLowerCase());
    const displayMessage = shouldUseMessage
      ? trimmedMessage
      : displayStageLabel || trimmedMessage || defaultMessage;

    const loadingDetails = {
      method: resolvedMethod,
      percentage: displayPercentage,
      status: typeof status === 'string' ? status.toLowerCase() : null,
      stageLabel: displayStageLabel,
    };

    try {
      chart.setLoading(displayMessage, displayPercentage, loadingDetails);
    } catch (error) {
      console.warn('[Feature:cards] Failed to display scatter progress', error);
    }

    if (status === 'completed' || status === 'error' || (Number.isFinite(percentage) && percentage >= 100)) {
      stopScatterProgressPoller(record);
    }
  });

  record.progressPoller = poller;
  record.progressUnsubscribe = unsubscribe;
  poller.start();
  return poller;
}

function ensureProjectContext(projectName) {
  const normalized = typeof projectName === 'string' ? projectName.trim() : '';
  const nextProjectName = normalized || null;

  if (currentProjectName === nextProjectName) {
    return currentProjectName;
  }

  currentProjectName = nextProjectName;
  chartResponseCache.clear();

  const ids = Array.from(cardVisualizations.keys());
  ids.forEach(id => {
    teardownCardVisualization(id);
  });

  return currentProjectName;
}

function fetchLineChartData(path, options = {}) {
  const cacheKey = typeof path === 'string' ? path : JSON.stringify(path);
  if (cacheKey && chartResponseCache.has(cacheKey)) {
    return Promise.resolve(chartResponseCache.get(cacheKey));
  }
  return requestJson(path, options).then(payload => {
    if (cacheKey) {
      chartResponseCache.set(cacheKey, payload);
    }
    return payload;
  });
}

const lineChartFetcher = (path, options = {}) => fetchLineChartData(path, options);

if (typeof LineChart.setFetcher === 'function') {
  LineChart.setFetcher(lineChartFetcher);
} else {
  LineChart.fetcher = lineChartFetcher;
}

function fetchScatterChartData(url, cacheKey = null) {
  const key = cacheKey || url;
  if (key && chartResponseCache.has(key)) {
    return Promise.resolve(chartResponseCache.get(key));
  }
  return requestJson(url).then(payload => {
    try {
      if (key && payload && typeof payload === 'object') {
        const status = typeof payload.status === 'string'
          ? payload.status.toLowerCase()
          : 'ready';
        if (status === 'ready') {
          chartResponseCache.set(key, payload);
        }
      }
    } catch (error) {
      console.warn('[Feature:cards] Failed to cache scatter response', error);
    }
    return payload;
  });
}

function extractLineChartSelection(detail, fallbackProjectName = null) {
  const result = {
    datasetId: null,
    resolvedDatasetId: null,
    measureColumn: null,
    timeColumn: null,
    projectName: null,
    errors: [],
  };

  if (!detail || typeof detail !== 'object') {
    result.errors.push('Configure this card to explore data.');
    return result;
  }

  const fieldValues = detail.fieldValues && typeof detail.fieldValues === 'object'
    ? detail.fieldValues
    : {};
  const measures = Array.isArray(fieldValues.measures) ? fieldValues.measures : [];
  const firstMeasure = measures.find(entry => entry && typeof entry === 'object') || null;

  let projectName = sanitizeText(detail.projectName)
    || sanitizeText(fallbackProjectName);

  const resolvedDatasetCandidate = sanitizeText(
    detail.resolvedDatasetId
      ?? detail.resolved_dataset_id
      ?? fieldValues.resolvedDatasetId
      ?? fieldValues.resolved_dataset_id
      ?? fieldValues.datasetKey
      ?? fieldValues.dataset_key,
  );

  let datasetId = sanitizeText(
    firstMeasure?.source
      ?? firstMeasure?.sourceId
      ?? firstMeasure?.source_id
      ?? fieldValues.source
      ?? fieldValues.sourceId
      ?? fieldValues.source_id
      ?? detail.dataSourceId
      ?? detail.dataSource_id
      ?? detail.dataset
      ?? detail.datasetId
      ?? detail.dataset_id,
  );

  if (datasetId && datasetId.includes('::')) {
    const parts = parseDatasetIdentifier(datasetId);
    if (parts.project && !projectName) {
      projectName = parts.project;
    }
    datasetId = parts.array || datasetId;
  }

  const measureColumn = sanitizeText(
    firstMeasure?.column
      ?? firstMeasure?.columnId
      ?? firstMeasure?.column_id
      ?? fieldValues.measure
      ?? fieldValues.measureColumn
      ?? fieldValues.measure_column
      ?? (Array.isArray(fieldValues.y) ? fieldValues.y[0] : null)
      ?? fieldValues.y,
  );

  if (!measureColumn) {
    result.errors.push('Select at least one measure column for this chart.');
  }

  let resolvedDatasetId = resolvedDatasetCandidate;
  if (resolvedDatasetId && resolvedDatasetId.includes('::')) {
    const parts = parseDatasetIdentifier(resolvedDatasetId);
    if (parts.project && !projectName) {
      projectName = parts.project;
    }
    resolvedDatasetId = parts.project && parts.array
      ? `${parts.project}::${parts.array}`
      : (parts.array || resolvedDatasetId);
    if (!datasetId && parts.array) {
      datasetId = parts.array;
    }
  } else if (!resolvedDatasetId && datasetId && projectName) {
    resolvedDatasetId = `${projectName}::${datasetId}`;
  } else if (!resolvedDatasetId) {
    resolvedDatasetId = datasetId;
  }

  if (!projectName && resolvedDatasetId && resolvedDatasetId.includes('::')) {
    const parts = parseDatasetIdentifier(resolvedDatasetId);
    if (parts.project) {
      projectName = parts.project;
    }
  }

  if (!datasetId) {
    result.errors.push('Choose a dataset for this chart before exploring.');
  }

  return {
    datasetId: datasetId || null,
    resolvedDatasetId: resolvedDatasetId || null,
    measureColumn: measureColumn || null,
    timeColumn: null,
    projectName: projectName || null,
    errors: result.errors,
  };
}

function buildLineChartConfiguration(detail, selection) {
  const base = detail && typeof detail === 'object' ? detail : {};
  const fieldValues = base.fieldValues && typeof base.fieldValues === 'object'
    ? { ...base.fieldValues }
    : {};

  const measures = Array.isArray(fieldValues.measures) ? [...fieldValues.measures] : [];
  if (!measures.length && selection.measureColumn) {
    measures.push({ source: selection.datasetId, column: selection.measureColumn });
  }

  const normalizedMeasures = measures.map(entry => {
    if (!entry || typeof entry !== 'object') {
      return { source: selection.datasetId, column: selection.measureColumn };
    }
    const normalized = { ...entry };
    if (!sanitizeText(normalized.source ?? normalized.sourceId ?? normalized.source_id)) {
      normalized.source = selection.datasetId;
    }
    if (!sanitizeText(normalized.column ?? normalized.columnId ?? normalized.column_id)) {
      normalized.column = selection.measureColumn;
    }
    return normalized;
  });

  fieldValues.measures = normalizedMeasures;
  delete fieldValues.x;
  delete fieldValues.time;
  delete fieldValues.timeColumn;

  const configuration = {
    chartType: base.chartType,
    chartTypeLabel: base.chartTypeLabel,
    dataSourceId: selection.datasetId,
    datasetId: selection.datasetId,
    fieldValues,
  };
  if (selection.projectName) {
    configuration.projectName = selection.projectName;
  }
  if (selection.resolvedDatasetId) {
    configuration.resolvedDatasetId = selection.resolvedDatasetId;
  }
  return configuration;
}

function renderCardMessage(target, messages, tone = 'muted') {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [messages].filter(Boolean);
  const toneClass = tone === 'error'
    ? 'text-red-600'
    : (tone === 'info' ? 'text-blue-600' : 'text-gray-600');
  target.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'flex h-full w-full items-center justify-center text-center p-4';
  const messageContainer = document.createElement('div');
  messageContainer.className = `space-y-2 text-sm ${toneClass}`;
  if (list.length === 0) {
    const fallback = document.createElement('p');
    fallback.textContent = 'Visualization placeholder';
    messageContainer.append(fallback);
  } else {
    list.forEach(entry => {
      const paragraph = document.createElement('p');
      paragraph.textContent = entry;
      messageContainer.append(paragraph);
    });
  }
  wrapper.append(messageContainer);
  target.append(wrapper);
}

function renderCardSummary(target, description) {
  if (!description) {
    renderCardMessage(target, 'Visualization placeholder');
    return;
  }
  target.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'flex h-full w-full flex-col items-center justify-center gap-1 text-center p-4';

  const title = document.createElement('p');
  title.className = 'text-sm font-semibold text-gray-800';
  title.textContent = description.title;
  wrapper.append(title);

  const subtitle = document.createElement('p');
  subtitle.className = 'text-xs text-gray-500';
  subtitle.textContent = description.sourceLabel
    ? `Data: ${description.sourceLabel}`
    : 'Data source not selected';
  wrapper.append(subtitle);

  target.append(wrapper);
}

export function teardownCardVisualization(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record) return;

  stopScatterProgressPoller(record);
  stopLiveTsne(record, { notifyBackend: true });

  try {
    record.chart?.unmount?.();
  } catch (error) {
    console.warn('[Feature:cards] Failed to unmount chart for card', cardId, error);
  }
  if (record.container?.parentNode) {
    record.container.parentNode.removeChild(record.container);
  }
  cardVisualizations.delete(cardId);
}

function ensureLineChart(target, cardId, detail, selection, { sheetId } = {}) {
  const chartConfiguration = buildLineChartConfiguration(detail, selection);
  const subjectSelection = getSubjectSelectionForProject(selection.projectName);
  const configKey = JSON.stringify({
    datasetId: selection.datasetId,
    resolvedDatasetId: selection.resolvedDatasetId,
    projectName: selection.projectName,
    measureColumn: selection.measureColumn,
    fieldValues: chartConfiguration.fieldValues,
    subjects: subjectSelection,
  });

  let record = cardVisualizations.get(cardId);
  if (record && record.type !== 'line') {
    teardownCardVisualization(cardId);
    record = null;
  }
  if (!record) {
    const container = document.createElement('div');
    container.className = 'workspace-card__chart h-full w-full';
    const chart = new LineChart(container, {
      configuration: chartConfiguration,
      datasetId: selection.resolvedDatasetId || selection.datasetId,
      resolvedDatasetId: selection.resolvedDatasetId,
      sourceDatasetId: selection.datasetId,
      measureColumn: selection.measureColumn,
      projectName: selection.projectName,
      sheetId,
      subjects: subjectSelection,
    });
    cardVisualizations.set(cardId, {
      type: 'line',
      container,
      chart,
      configKey,
      projectName: selection.projectName || null,
    });
    target.innerHTML = '';
    target.append(container);
    chart.mount({ configuration: chartConfiguration });
    return;
  }

  record.configKey = record.configKey || '';
  target.innerHTML = '';
  target.append(record.container);
  Object.assign(record.chart.options, {
    datasetId: selection.resolvedDatasetId || selection.datasetId,
    resolvedDatasetId: selection.resolvedDatasetId,
    sourceDatasetId: selection.datasetId,
    measureColumn: selection.measureColumn,
    projectName: selection.projectName,
    sheetId,
    subjects: subjectSelection,
  });
  if (typeof record.chart.setSheetContext === 'function') {
    record.chart.setSheetContext(sheetId);
  }
  if (typeof record.chart.setSubjectSelection === 'function') {
    record.chart.setSubjectSelection(subjectSelection);
  }
  if (typeof LineChart.fetcher === 'function') {
    record.chart.fetcher = LineChart.fetcher;
  }
  record.chart.configuration = chartConfiguration;
  record.projectName = selection.projectName || record.projectName || null;

  if (!record.chart.isMounted) {
    record.chart.mount({ configuration: chartConfiguration });
    record.configKey = configKey;
    return;
  }

  if (record.configKey !== configKey) {
    record.chart.setConfiguration(chartConfiguration);
    record.configKey = configKey;
  } else {
    record.chart.refresh();
  }
}

function normalizeScatterColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns
    .map(entry => {
      if (typeof entry === 'string') {
        return sanitizeText(entry);
      }
      if (!entry || typeof entry !== 'object') {
        return '';
      }
      const identifier = sanitizeText(
        entry.id
          ?? entry.column
          ?? entry.columnId
          ?? entry.column_id
          ?? entry.value
          ?? entry.key,
      );
      return identifier;
    })
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
}

function buildScatterConfiguration(detail) {
  const base = detail && typeof detail === 'object' ? detail : {};
  const fieldValues = base.fieldValues && typeof base.fieldValues === 'object'
    ? base.fieldValues
    : {};

  const datasetId = sanitizeText(
    fieldValues.datasetId
      ?? fieldValues.dataset_id
      ?? base.dataSourceId
      ?? base.dataSource_id
      ?? base.datasetId
      ?? base.dataset_id,
  );

  const resolvedDatasetId = sanitizeText(
    base.resolvedDatasetId
      ?? base.resolved_dataset_id
      ?? fieldValues.resolvedDatasetId
      ?? fieldValues.resolved_dataset_id,
  );

  const dimension = Number(fieldValues.dimension) === 3 ? 3 : 2;
  const reduction = sanitizeText(fieldValues.reduction);
  const columns = normalizeScatterColumns(fieldValues.columns);

  const columnLabels = Array.isArray(fieldValues.columnLabels)
    ? fieldValues.columnLabels.map(label => sanitizeText(label)).filter(Boolean)
    : [];

  const multiSubject = Boolean(
    fieldValues.multiSubject
      ?? fieldValues.multi_subject
      ?? base.multiSubject
      ?? base.multi_subject,
  );

  const safeReduction = ALLOWED_REDUCTIONS.includes(reduction) ? reduction : '';
  const normalizedReduction = columns.length > dimension && !safeReduction ? 'pca' : safeReduction;

  return {
    datasetId,
    resolvedDatasetId,
    dimension,
    reduction: normalizedReduction,
    columns,
    columnLabels,
    multiSubject,
  };
}

function ensureScatterChart(target, cardId, detail, { projectName, sheetId }) {
  const normalizedProject = sanitizeText(projectName);
  const normalizedSheet = sanitizeText(sheetId);

  if (!normalizedProject) {
    teardownCardVisualization(cardId);
    renderCardMessage(target, 'Select a project to explore this scatter plot.');
    return;
  }

  if (!normalizedSheet) {
    teardownCardVisualization(cardId);
    renderCardMessage(target, 'Select a sheet before exploring this scatter plot.');
    return;
  }

  const scatterConfig = buildScatterConfiguration(detail);

  const subjectSelection = getSubjectSelectionForProject(normalizedProject);
  const resolvedSubject = scatterConfig.multiSubject && subjectSelection.length === 1
    ? subjectSelection[0]
    : null;
  const resolvedSubjectLabel = resolvedSubject
    ? getSubjectLabelForProject(normalizedProject, resolvedSubject)
    : null;

  if (!scatterConfig.datasetId) {
    teardownCardVisualization(cardId);
    renderCardMessage(target, 'Choose a data source to view this scatter plot.');
    return;
  }

  if (!scatterConfig.columns.length) {
    teardownCardVisualization(cardId);
    renderCardMessage(target, 'Select at least two columns for the scatter plot.');
    return;
  }

  if (scatterConfig.dimension > scatterConfig.columns.length) {
    teardownCardVisualization(cardId);
    renderCardMessage(
      target,
      `Scatter plot requires ${scatterConfig.dimension} column${scatterConfig.dimension === 1 ? '' : 's'} `
        + 'based on the selected dimensionality.',
    );
    return;
  }

  let record = cardVisualizations.get(cardId);
  if (record && record.type !== 'scatter') {
    teardownCardVisualization(cardId);
    record = null;
  }

  if (!record) {
    const container = document.createElement('div');
    container.className = 'workspace-card__chart h-full w-full';
    const chart = new ScatterChart(container, { sheetId: normalizedSheet, projectName: normalizedProject, subjects: subjectSelection });
    chart.mount();
    if (typeof chart.setSheetContext === 'function') {
      chart.setSheetContext(normalizedSheet);
    }
    record = {
      type: 'scatter',
      container,
      chart,
      configKey: null,
      requestKey: null,
      cachedPayload: null,
      progressPoller: null,
      progressUnsubscribe: null,
      progressSmoother: createProgressSmoother(),
      tsneController: null,
      target,
      detail,
      projectName: normalizedProject,
      sheetId: normalizedSheet,
    };
    cardVisualizations.set(cardId, record);
  }

  if (record.chart) {
    record.chart.options = {
      ...record.chart.options,
      sheetId: normalizedSheet,
      projectName: normalizedProject,
      subjects: subjectSelection,
    };
    if (typeof record.chart.setSubjectSelection === 'function') {
      try {
        record.chart.setSubjectSelection(subjectSelection);
      } catch (error) {
        console.warn('[Feature:cards] Failed to sync subject selection on scatter chart', error);
      }
    }
  }

  record.target = target;
  record.detail = detail;
  record.projectName = normalizedProject;
  record.sheetId = normalizedSheet;

  if (!record.progressSmoother) {
    record.progressSmoother = createProgressSmoother();
  }

  stopLiveTsne(record, { notifyBackend: true });

  const configKey = JSON.stringify({
    datasetId: scatterConfig.datasetId,
    resolvedDatasetId: scatterConfig.resolvedDatasetId,
    columns: scatterConfig.columns,
    dimension: scatterConfig.dimension,
    reduction: scatterConfig.reduction,
    multiSubject: scatterConfig.multiSubject,
    subjects: subjectSelection,
  });

  target.innerHTML = '';
  target.append(record.container);
  if (record.chart && typeof record.chart.setSheetContext === 'function') {
    try {
      record.chart.setSheetContext(normalizedSheet);
    } catch (e) {
      console.warn('[Feature:cards] Failed to set sheet context on scatter chart', e);
    }
  }

  const params = new URLSearchParams({
    project_id: normalizedProject,
    sheet_id: normalizedSheet,
    card_id: cardId,
  });

  scatterConfig.columns.forEach(columnId => {
    if (typeof columnId === 'string') {
      const normalized = columnId.trim();
      if (normalized) {
        params.append('column', normalized);
      }
    }
  });

  if (Number.isFinite(scatterConfig.dimension)) {
    params.set('dimension', String(scatterConfig.dimension));
  }

  if (scatterConfig.reduction) {
    params.set('reduction', scatterConfig.reduction);
  }

  if (scatterConfig.multiSubject) {
    params.set('multi_subject', 'true');
  }

  if (resolvedSubject) {
    params.set('subject', resolvedSubject);
    if (resolvedSubjectLabel) {
      params.set('subject_label', resolvedSubjectLabel);
    }
  }

  if (Array.isArray(scatterConfig.columnLabels)) {
    scatterConfig.columnLabels.forEach(label => {
      if (typeof label === 'string') {
        const normalized = label.trim();
        if (normalized) {
          params.append('column_label', normalized);
        }
      }
    });
  }

  // Add n_neighbors parameter for UMAP if chart has it
  if (scatterConfig.reduction === 'umap' && record.chart) {
    const umapParams = typeof record.chart.getUmapParameters === 'function'
      ? record.chart.getUmapParameters()
      : null;
    if (umapParams && typeof umapParams.neighbours === 'number') {
      params.set('n_neighbors', umapParams.neighbours.toString());
    }
  }

  const url = `${SCATTER_CHART_ENDPOINT}?${params.toString()}`;
  const fetchKey = `${url}::${configKey}`;

  record.configKey = configKey;
  record.requestKey = fetchKey;
  
  // Setup UMAP recompute callback
  if (scatterConfig.reduction === 'umap' && record.chart && typeof record.chart.setUmapRecomputeCallback === 'function') {
    record.chart.setUmapRecomputeCallback((parameters) => {
      // Trigger reload with new parameters
      record.chart.setUmapLoading?.(true);
      ensureScatterChart(target, cardId, detail, { projectName, sheetId });
    });
  }

  // Setup t-SNE restart handler
  if (scatterConfig.reduction === 'tsne' && record.chart && typeof record.chart.setTsneRestartHandler === 'function') {
    // Reset parameters to defaults when first switching to t-SNE
    if (typeof record.chart.resetTsneParameters === 'function') {
      const previousReduction = record.previousReduction || null;
      if (previousReduction !== 'tsne') {
        record.chart.resetTsneParameters();
      }
    }
    
    record.chart.setTsneRestartHandler(async (tsneParams) => {
      // Stop existing t-SNE session
      stopLiveTsne(record);
      
      // Build new URL with custom parameters
      const newParams = new URLSearchParams(params);
      if (typeof tsneParams.perplexity === 'number') {
        newParams.set('perplexity', tsneParams.perplexity.toString());
      }
      if (typeof tsneParams.learningRate === 'number') {
        newParams.set('learning_rate', tsneParams.learningRate.toString());
      }
      
      const newUrl = `${SCATTER_CHART_ENDPOINT}?${newParams.toString()}`;
      record.chart.setLoading('Starting new t-SNE session…');
      
      try {
        const payload = await fetchScatterChartData(newUrl, null); // Don't cache
        if (payload?.status === 'tsne_live') {
          handleTsnePayload(record, payload, {
            projectId: normalizedProject,
            sheetId: normalizedSheet,
            cardId,
          });
        }
      } catch (error) {
        console.error('[Feature:cards] Failed to start new t-SNE session', error);
        record.chart.setError?.('Failed to start new t-SNE session');
      }
    });
  }

  const reductionMethod = typeof scatterConfig.reduction === 'string'
    ? scatterConfig.reduction.toLowerCase()
    : '';
  const needsReduction = Boolean(
    reductionMethod
    && ALLOWED_REDUCTIONS.includes(reductionMethod)
    && scatterConfig.columns.length > scatterConfig.dimension,
  );

  // Track previous reduction method to detect switches
  const previousReduction = record.previousReduction || null;
  record.previousReduction = reductionMethod || null;
  
  // Apply the persisted reduction method on initialization so overlays render after reloads
  setScatterReductionMethod(cardId, reductionMethod || null);

  const isTsneReduction = reductionMethod === 'tsne';
  const needsStandardReduction = needsReduction && !isTsneReduction;
  const reductionMessage = reductionMethod === 'umap'
    ? 'UMAP reduction in progress…'
    : 'PCA reduction in progress…';
  const tsneMessage = 'Preparing live t-SNE session…';
  const hasCachedData = chartResponseCache.has(fetchKey);

  if (hasCachedData) {
    const cached = chartResponseCache.get(fetchKey);
    record.cachedPayload = cached;
    try {
      record.chart.setData(cached);
    } catch (error) {
      console.warn('[Feature:cards] Failed to apply cached scatter data', error);
    }
  } else if (isTsneReduction) {
    record.chart.setLoading(tsneMessage);
  } else if (needsStandardReduction) {
    const initialStage = getInitialStage(reductionMethod);
    const initialLabel = initialStage?.label || getDefaultStageLabel(reductionMethod);
    const initialPercentage = initialStage?.percentage ?? null;
    const initialMessage = initialLabel
      ? `${initialLabel}…`
      : reductionMessage;
    record.chart.setLoading(initialMessage, initialPercentage, {
      method: reductionMethod || null,
      status: 'initializing',
      percentage: initialPercentage,
      stageLabel: initialLabel,
    });
  } else {
    record.chart.setLoading('Loading scatter plot data…');
  }

  if (needsStandardReduction && !hasCachedData) {
    startScatterProgressPoller(record, {
      projectId: normalizedProject,
      sheetId: normalizedSheet,
      cardId,
      chart: record.chart,
      fallbackMessage: reductionMessage,
      reductionMethod,
    });
    
    // Set UMAP controls to loading state
    if (reductionMethod === 'umap' && typeof record.chart.setUmapLoading === 'function') {
      record.chart.setUmapLoading(true);
    }
  } else {
    stopScatterProgressPoller(record);
  }

  fetchScatterChartData(url, fetchKey)
    .then(payload => {
      const current = cardVisualizations.get(cardId);
      if (!current || current.requestKey !== fetchKey) {
        return;
      }
      
      if (isTsneReduction && payload?.status === 'tsne_live') {
        handleTsnePayload(current, payload, {
          projectId: normalizedProject,
          sheetId: normalizedSheet,
          cardId,
        });
        return;
      }

      current.cachedPayload = payload;
      current.chart.setData(payload);
      
      // Re-enable UMAP controls after data loads
      if (reductionMethod === 'umap' && typeof current.chart.setUmapLoading === 'function') {
        current.chart.setUmapLoading(false);
      }
    })
    .catch(error => {
      console.error('[Feature:cards] Failed to load scatter chart data', error);
      const current = cardVisualizations.get(cardId);
      if (!current || current.requestKey !== fetchKey) {
        return;
      }

      stopLiveTsne(current);
      current.chart.setError('Failed to load scatter plot data.');
      
      // Re-enable UMAP controls on error
      if (reductionMethod === 'umap' && typeof current.chart.setUmapLoading === 'function') {
        current.chart.setUmapLoading(false);
      }
    })
    .finally(() => {
      const current = cardVisualizations.get(cardId);
      if (!current || current.requestKey !== fetchKey) {
        return;
      }
      stopScatterProgressPoller(current);
    });
}

function renderCardStateInternal({
  cardId,
  container,
  mode,
  detail,
  description,
  projectName,
  sheetId,
}) {
  if (!container) return;

  const activeProject = ensureProjectContext(projectName);
  const target = container;
  const summary = description || null;

  if (mode !== 'explore') {
    teardownCardVisualization(cardId);
    renderCardSummary(target, summary);
    return;
  }

  if (!detail) {
    teardownCardVisualization(cardId);
    renderCardMessage(target, 'Configure this card to explore data.');
    return;
  }

  const rawChartType = detail.chartType;
  const chartType = typeof rawChartType === 'string' ? rawChartType.trim().toLowerCase() : '';

  if (chartType === 'line') {
    const selection = extractLineChartSelection(detail, activeProject);
    if (selection.errors.length) {
      teardownCardVisualization(cardId);
      renderCardMessage(target, selection.errors, 'error');
      return;
    }

    ensureLineChart(target, cardId, detail, selection, { sheetId });
    return;
  }

  if (chartType === 'scatter') {
    ensureScatterChart(target, cardId, detail, {
      projectName: activeProject,
      sheetId,
    });
    return;
  }

  teardownCardVisualization(cardId);
  const chartLabel = summary?.title || detail.chartType || 'chart';
  renderCardMessage(target, `Explore mode does not yet support ${chartLabel} visualizations.`);
}

export function setupCardVisualization({ cardId, container }) {
  return {
    renderCardState({ mode, detail, description, projectName, sheetId }) {
      renderCardStateInternal({
        cardId,
        container,
        mode,
        detail,
        description,
        projectName,
        sheetId,
      });
    },
    teardown() {
      teardownCardVisualization(cardId);
    },
  };
}

export function teardownAllCardVisualizations() {
  const ids = Array.from(cardVisualizations.keys());
  ids.forEach(id => {
    teardownCardVisualization(id);
  });
  chartResponseCache.clear();
  currentProjectName = null;
}

/**
 * Reset the visualization view state for a given card.
 * Currently implemented for Scatter charts (2D/3D): resets zoom and/or rotation.
 * Returns true when a reset was attempted, false otherwise.
 */
export function resetCardVisualization(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || !record.chart) return false;

  try {
    // Prefer explicit scatter handling
    if (record.type === 'scatter' && typeof record.chart.resetView === 'function') {
      record.chart.resetView();
      return true;
    }
    // Generic fallback if other charts implement resetView later
    if (typeof record.chart.resetView === 'function') {
      record.chart.resetView();
      return true;
    }
  } catch (error) {
    console.warn('[Feature:cards] Failed to reset chart view for card', cardId, error);
  }
  return false;
}

export function getScatterRenderMode(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.getRenderMode === 'function') {
    try {
      return record.chart.getRenderMode() || 'points';
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function setScatterRenderMode(cardId, mode) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.setRenderMode === 'function') {
    try {
      return record.chart.setRenderMode(mode);
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function toggleScatterRenderMode(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.toggleRenderMode === 'function') {
    try {
      return record.chart.toggleRenderMode();
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Get current auto-rotation state for a 3D Scatter chart of the given card.
 * Returns:
 *  - true/false when available
 *  - null when the visualization is not a scatter or not mounted yet
 */
export function getScatterAutoRotationState(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.getAutoRotationEnabled === 'function') {
    try {
      return !!record.chart.getAutoRotationEnabled();
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Enable/disable auto-rotation for a 3D Scatter chart.
 * Returns resulting enabled state (true/false) or null if unavailable.
 */
export function setScatterAutoRotation(cardId, enabled) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.setAutoRotationEnabled === 'function') {
    try {
      return !!record.chart.setAutoRotationEnabled(!!enabled);
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Toggle auto-rotation for a 3D Scatter chart.
 * Returns resulting enabled state (true/false) or null if unavailable.
 */
export function toggleScatterAutoRotation(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.toggleAutoRotation === 'function') {
    try {
      return !!record.chart.toggleAutoRotation();
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Performance Mode helpers for Scatter 3D
 */
export function getScatterPerformanceMode(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.getPerformanceModeEnabled === 'function') {
    try {
      return !!record.chart.getPerformanceModeEnabled();
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function setScatterPerformanceMode(cardId, enabled) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.setPerformanceModeEnabled === 'function') {
    try {
      return !!record.chart.setPerformanceModeEnabled(!!enabled);
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function toggleScatterPerformanceMode(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.togglePerformanceModeEnabled === 'function') {
    try {
      return !!record.chart.togglePerformanceModeEnabled();
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Query if Scatter 3D is currently rotating (auto-spin, inertia, or user drag)
 * When true, the chart already uses reduced-detail rendering.
 */
export function getScatterRotationActive(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.isRotationActive === 'function') {
    try {
      return !!record.chart.isRotationActive();
    } catch (_) {
      return null;
    }
  }
  return null;
}

function coerceFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function findStartIndexForDomain(value, steps, lookup) {
  if (!steps || !steps.length) return null;
  const epsilon = 1e-6;
  if (lookup && typeof lookup.get === 'function') {
    const direct = lookup.get(value);
    if (Number.isInteger(direct) && direct >= 0) {
      return direct;
    }
  }
  for (let index = 0; index < steps.length; index += 1) {
    const stepValue = steps[index];
    if (!Number.isFinite(stepValue)) continue;
    if (stepValue >= value - epsilon) {
      return index;
    }
  }
  return steps.length - 1;
}

function findEndIndexForDomain(value, steps, lookup) {
  if (!steps || !steps.length) return null;
  const epsilon = 1e-6;
  if (lookup && typeof lookup.get === 'function') {
    const direct = lookup.get(value);
    if (Number.isInteger(direct) && direct >= 0) {
      return direct;
    }
  }
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const stepValue = steps[index];
    if (!Number.isFinite(stepValue)) continue;
    if (stepValue <= value + epsilon) {
      return index;
    }
  }
  return 0;
}

export function getLineChartFocusRange(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'line' || !record.chart) {
    return null;
  }

  const chart = record.chart;
  const steps = Array.isArray(chart?.orderedSteps) ? chart.orderedSteps : [];
  if (!steps.length) {
    return null;
  }

  let domain = Array.isArray(chart?.focusDomain) ? chart.focusDomain : null;
  if ((!domain || domain.length !== 2) && chart?.xFocus && typeof chart.xFocus.domain === 'function') {
    const candidate = chart.xFocus.domain();
    if (Array.isArray(candidate) && candidate.length === 2) {
      domain = candidate;
    }
  }

  if (!domain || domain.length !== 2) {
    return null;
  }

  const startRaw = coerceFiniteNumber(domain[0]);
  const endRaw = coerceFiniteNumber(domain[1]);
  if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) {
    return null;
  }

  const startValue = Math.min(startRaw, endRaw);
  const endValue = Math.max(startRaw, endRaw);

  const lookup = chart?.stepIndexLookup instanceof Map ? chart.stepIndexLookup : null;
  let startIndex = findStartIndexForDomain(startValue, steps, lookup);
  let endIndex = findEndIndexForDomain(endValue, steps, lookup);

  if (startIndex == null || endIndex == null) {
    return null;
  }

  startIndex = Math.max(0, Math.trunc(startIndex));
  endIndex = Math.max(0, Math.trunc(endIndex));

  if (endIndex < startIndex) {
    const temp = startIndex;
    startIndex = endIndex;
    endIndex = temp;
  }

  return {
    startIndex,
    endIndex,
    startValue,
    endValue,
  };
}

export function getCardVisualizationDebugInfo() {
  if (process.env.NODE_ENV !== 'development') {
    return null;
  }
  return {
    cacheSize: chartResponseCache.size,
    visualizations: cardVisualizations.size,
    projectName: currentProjectName,
  };
}

export function getCardChart(cardId) {
  const record = cardVisualizations.get(cardId);
  return record?.chart || null;
}

export function getScatterFilteredVisibilityMode(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.getFilteredVisibilityMode === 'function') {
    try {
      return record.chart.getFilteredVisibilityMode();
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function setScatterFilteredVisibilityMode(cardId, mode) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.setFilteredVisibilityMode === 'function') {
    try {
      return record.chart.setFilteredVisibilityMode(mode === 'hide' ? 'hide' : 'grey');
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function toggleScatterFilteredVisibilityMode(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.toggleFilteredVisibilityMode === 'function') {
    try {
      return record.chart.toggleFilteredVisibilityMode();
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * PCA overlay visibility controls (component selection overlay)
 * Defaults to visible when available. Visibility preference persists per chart instance.
 */
export function getScatterPcaOverlayVisible(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.getPcaOverlayVisible === 'function') {
    try {
      return !!record.chart.getPcaOverlayVisible();
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function setScatterPcaOverlayVisible(cardId, visible) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.setPcaOverlayVisible === 'function') {
    try {
      return !!record.chart.setPcaOverlayVisible(visible);
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function toggleScatterPcaOverlayVisible(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  const chart = record.chart;
  const getFn = typeof chart.getPcaOverlayVisible === 'function'
    ? () => chart.getPcaOverlayVisible()
    : null;
  const setFn = typeof chart.setPcaOverlayVisible === 'function'
    ? value => chart.setPcaOverlayVisible(value)
    : null;

  if (!setFn) return null;

  try {
    const current = getFn ? !!getFn() : false;
    return !!setFn(!current);
  } catch (_) {
    return null;
  }
}

/**
 * UMAP overlay visibility controls (parameter overlay)
 * Defaults to visible when available. Visibility preference persists per chart instance.
 */
export function getScatterUmapOverlayVisible(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.getUmapOverlayVisible === 'function') {
    try {
      return !!record.chart.getUmapOverlayVisible();
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function setScatterUmapOverlayVisible(cardId, visible) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.setUmapOverlayVisible === 'function') {
    try {
      return !!record.chart.setUmapOverlayVisible(visible);
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function toggleScatterUmapOverlayVisible(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  const chart = record.chart;
  const getFn = typeof chart.getUmapOverlayVisible === 'function'
    ? () => chart.getUmapOverlayVisible()
    : null;
  const setFn = typeof chart.setUmapOverlayVisible === 'function'
    ? value => chart.setUmapOverlayVisible(value)
    : null;

  if (!setFn) return null;

  try {
    const current = getFn ? !!getFn() : false;
    return !!setFn(!current);
  } catch (_) {
    return null;
  }
}

/**
 * Trigger UMAP overlay creation (called when user selects UMAP method)
 */
export function ensureScatterUmapOverlay(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return;
  if (typeof record.chart._updateUmapOverlay === 'function') {
    try {
      record.chart._updateUmapOverlay();
    } catch (error) {
      console.error('[cardsVisualization] Failed to create UMAP overlay', error);
    }
  }
}

/**
 * Destroy UMAP overlay (called when user switches away from UMAP)
 */
export function destroyScatterUmapOverlay(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return;
  const chart = record.chart;
  if (chart._umapOverlay && typeof chart._umapOverlay.destroy === 'function') {
    try {
      chart._umapOverlay.destroy();
      chart._umapOverlay = null;
    } catch (error) {
      console.error('[cardsVisualization] Failed to destroy UMAP overlay', error);
    }
  }
}

/**
 * T-SNE overlay visibility controls (live session controls)
 * Defaults to visible when available. Visibility preference persists per chart instance.
 */
export function getScatterTsneOverlayVisible(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.getTsneOverlayVisible === 'function') {
    try {
      return !!record.chart.getTsneOverlayVisible();
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function setScatterTsneOverlayVisible(cardId, visible) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.setTsneOverlayVisible === 'function') {
    try {
      return !!record.chart.setTsneOverlayVisible(visible);
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function toggleScatterTsneOverlayVisible(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  const chart = record.chart;
  const getFn = typeof chart.getTsneOverlayVisible === 'function'
    ? () => chart.getTsneOverlayVisible()
    : null;
  const setFn = typeof chart.setTsneOverlayVisible === 'function'
    ? value => chart.setTsneOverlayVisible(value)
    : null;

  if (!setFn) return null;

  try {
    const current = getFn ? !!getFn() : false;
    return !!setFn(!current);
  } catch (_) {
    return null;
  }
}

/**
 * Set reduction method and update overlays
 */
export function setScatterReductionMethod(cardId, method) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return;
  if (typeof record.chart.setReductionMethod === 'function') {
    try {
      record.chart.setReductionMethod(method);
    } catch (error) {
      console.error('[cardsVisualization] Failed to set reduction method', error);
    }
  }
}

/**
 * Selection toolbox visibility controls (in-chart overlay)
 * Default state is hidden on chart load. Visibility is per-card instance.
 */
export function getScatterSelectionToolbarVisible(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.getSelectionToolbarVisible === 'function') {
    try {
      return !!record.chart.getSelectionToolbarVisible();
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function setScatterSelectionToolbarVisible(cardId, visible) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.setSelectionToolbarVisible === 'function') {
    try {
      return !!record.chart.setSelectionToolbarVisible(!!visible);
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function toggleScatterSelectionToolbarVisible(cardId) {
  const record = cardVisualizations.get(cardId);
  if (!record || record.type !== 'scatter' || !record.chart) return null;
  if (typeof record.chart.toggleSelectionToolbarVisibility === 'function') {
    try {
      return !!record.chart.toggleSelectionToolbarVisibility();
    } catch (_) {
      return null;
    }
  }
  return null;
}
