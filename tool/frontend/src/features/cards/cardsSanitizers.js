import { sanitizeCoordinate } from './cardsLayout.js';

export function sanitizeText(value) {
  if (value === null || value === undefined) return '';
  try {
    return String(value).trim();
  } catch (error) {
    return '';
  }
}

export function cloneDeepValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const text = sanitizeText(value);
    return text ? text : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const result = [];
    value.forEach(item => {
      const cloned = cloneDeepValue(item);
      if (cloned !== null) {
        result.push(cloned);
      }
    });
    return result;
  }
  if (typeof value === 'object') {
    const result = {};
    Object.entries(value).forEach(([key, raw]) => {
      const textKey = sanitizeText(key);
      if (!textKey) return;
      const cloned = cloneDeepValue(raw);
      if (cloned === null) return;
      if (Array.isArray(cloned) && cloned.length === 0) return;
      if (typeof cloned === 'object' && !Array.isArray(cloned) && Object.keys(cloned).length === 0) return;
      result[textKey] = cloned;
    });
    return result;
  }
  return null;
}

function sanitizeLineMeasure(value) {
  if (!value || typeof value !== 'object') return null;
  const identifier = sanitizeText(value.id);
  const source = sanitizeText(value.source ?? value.sourceId ?? value.source_id);
  const column = sanitizeText(value.column ?? value.columnId ?? value.column_id);
  const sourceLabel = sanitizeText(value.sourceLabel ?? value.source_label);
  const columnLabel = sanitizeText(value.columnLabel ?? value.column_label);
  // Preserve subject selection (support multiple aliases)
  const subject = sanitizeText(
    value.subject ?? value.subjectId ?? value.subject_id
  );
  const booleanCandidates = [
    value.multiSubject,
    value.multi_subject,
    value.requiresSubject,
    value.subjectRequired,
  ];
  let multiSubject = null;
  for (const candidate of booleanCandidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === 'boolean') {
      multiSubject = candidate;
      break;
    }
    if (typeof candidate === 'number') {
      if (candidate === 1) { multiSubject = true; break; }
      if (candidate === 0) { multiSubject = false; break; }
    }
    if (typeof candidate === 'string') {
      const text = sanitizeText(candidate).toLowerCase();
      if (!text) continue;
      if (['true', '1', 'yes', 'y', 'on'].includes(text)) { multiSubject = true; break; }
      if (['false', '0', 'no', 'n', 'off'].includes(text)) { multiSubject = false; break; }
    }
  }

  const measure = {};
  if (identifier) measure.id = identifier;
  if (source) measure.source = source;
  if (column) measure.column = column;
  if (subject) measure.subject = subject;
  if (multiSubject !== null) measure.multiSubject = multiSubject;
  if (sourceLabel) measure.sourceLabel = sourceLabel;
  if (columnLabel) measure.columnLabel = columnLabel;
  return Object.keys(measure).length ? measure : null;
}

export function sanitizeFieldValues(value, chartType) {
  if (!value || typeof value !== 'object') return null;
  if (chartType === 'line') {
    const result = {};
    const rawMeasures = Array.isArray(value.measures)
      ? value.measures
      : (Array.isArray(value.measurements) ? value.measurements : null);
    if (rawMeasures) {
      const measures = rawMeasures
        .map(entry => sanitizeLineMeasure(entry))
        .filter(Boolean);
      if (measures.length) {
        result.measures = measures;
      }
    }
    const axisValue = sanitizeText(value.x ?? value.axis ?? value.dimension);
    if (axisValue) {
      result.x = axisValue;
    }

    Object.entries(value).forEach(([key, raw]) => {
      if (key === 'measures' || key === 'measurements' || key === 'x' || key === 'axis' || key === 'dimension') {
        return;
      }
      const textKey = sanitizeText(key);
      if (!textKey) return;
      const cloned = cloneDeepValue(raw);
      if (cloned === null) return;
      if (Array.isArray(cloned) && cloned.length === 0) return;
      if (typeof cloned === 'object' && !Array.isArray(cloned) && Object.keys(cloned).length === 0) return;
      result[textKey] = cloned;
    });

    return Object.keys(result).length ? result : null;
  }

  const cloned = cloneDeepValue(value);
  if (!cloned || (typeof cloned === 'object' && !Array.isArray(cloned) && Object.keys(cloned).length === 0)) {
    return null;
  }
  return cloned;
}

export function normalizeConfiguration(value) {
  if (!value || typeof value !== 'object') return null;
  const chartType = sanitizeText(value.chartType ?? value.chart_type);
  const chartTypeLabel = sanitizeText(value.chartTypeLabel ?? value.chart_type_label);
  const dataSourceId = sanitizeText(value.dataSourceId ?? value.data_source_id);
  const dataSourceLabel = sanitizeText(value.dataSourceLabel ?? value.data_source_label);
  const projectName = sanitizeText(value.projectName ?? value.project_name);
  const resolvedDatasetId = sanitizeText(
    value.resolvedDatasetId
      ?? value.resolved_dataset_id
      ?? value.datasetKey
      ?? value.dataset_key,
  );
  const fieldValues = sanitizeFieldValues(value.fieldValues ?? value.field_values, chartType);
  const configuration = {};
  if (chartType) configuration.chartType = chartType;
  if (chartTypeLabel) configuration.chartTypeLabel = chartTypeLabel;
  if (dataSourceId) configuration.dataSourceId = dataSourceId;
  if (dataSourceLabel) configuration.dataSourceLabel = dataSourceLabel;
  if (projectName) configuration.projectName = projectName;
  if (resolvedDatasetId) configuration.resolvedDatasetId = resolvedDatasetId;
  if (fieldValues) configuration.fieldValues = fieldValues;
  return Object.keys(configuration).length ? configuration : null;
}

export function cloneConfiguration(config) {
  const sanitized = normalizeConfiguration(config);
  if (!sanitized) return null;
  const cloned = { ...sanitized };
  if (sanitized.fieldValues) {
    const fieldValuesClone = cloneDeepValue(sanitized.fieldValues);
    if (fieldValuesClone) {
      cloned.fieldValues = fieldValuesClone;
    }
  }
  return cloned;
}

export function cloneConfigurationDetail(detail) {
  if (!detail || typeof detail !== 'object') {
    return null;
  }
  const cloned = { ...detail };
  if (detail.fieldValues && typeof detail.fieldValues === 'object') {
    const fieldValuesClone = cloneDeepValue(detail.fieldValues);
    cloned.fieldValues = fieldValuesClone || {};
  } else if ('fieldValues' in cloned) {
    cloned.fieldValues = {};
  }
  return cloned;
}

export function createConfigurationDetail(cardId, configuration, context = {}) {
  const sanitized = normalizeConfiguration(configuration);
  if (!sanitized) return null;
  const { projectName: defaultProjectName = null, sheetId = null } = context;
  const detail = {
    cardId,
    projectName: sanitized.projectName || defaultProjectName || null,
    sheetId: sheetId ?? null,
    chartType: sanitized.chartType,
    chartTypeLabel: sanitized.chartTypeLabel,
    dataSourceId: sanitized.dataSourceId,
    dataSourceLabel: sanitized.dataSourceLabel,
    fieldValues: sanitized.fieldValues ? cloneDeepValue(sanitized.fieldValues) || {} : {},
  };
  if (sanitized.resolvedDatasetId) {
    detail.resolvedDatasetId = sanitized.resolvedDatasetId;
  }
  return detail;
}

export function summarizeConfiguration(config) {
  if (!config) {
    return null;
  }
  const fieldTitle = typeof config.fieldValues?.title === 'string' && config.fieldValues.title.trim()
    ? config.fieldValues.title.trim()
    : '';
  const title = fieldTitle
    || (typeof config.chartTypeLabel === 'string' && config.chartTypeLabel.trim()
      ? config.chartTypeLabel.trim()
      : (typeof config.chartType === 'string' ? config.chartType : 'Chart'));
  const sourceLabel = typeof config.dataSourceLabel === 'string' && config.dataSourceLabel.trim()
    ? config.dataSourceLabel.trim()
    : (typeof config.dataSourceId === 'string' ? config.dataSourceId : '');
  return { title, sourceLabel };
}

export function sanitizeCards(cards, rowCount, columnCount) {
  if (!Array.isArray(cards)) return [];
  const maxRow = Math.max(0, Math.trunc(rowCount) - 1);
  const maxColumn = Math.max(0, Math.trunc(columnCount) - 1);
  const seen = new Set();
  const result = [];
  cards.forEach(entry => {
    if (!entry || typeof entry !== 'object') return;
    const id = String(entry.id ?? '').trim();
    if (!id || seen.has(id)) return;
    const topLeftSource = entry.topLeft || entry.top_left || {};
    const bottomRightSource = entry.bottomRight || entry.bottom_right || {};
    const topRow = sanitizeCoordinate(topLeftSource.row, maxRow);
    const leftColumn = sanitizeCoordinate(topLeftSource.column, maxColumn);
    let bottomRow = sanitizeCoordinate(bottomRightSource.row, maxRow);
    let rightColumn = sanitizeCoordinate(bottomRightSource.column, maxColumn);
    if (bottomRow < topRow) bottomRow = topRow;
    if (rightColumn < leftColumn) rightColumn = leftColumn;
    const configuration = normalizeConfiguration(entry.configuration || entry.config);
    const card = {
      id,
      topLeft: { row: topRow, column: leftColumn },
      bottomRight: { row: bottomRow, column: rightColumn },
    };
    if (configuration) {
      card.configuration = configuration;
    }
    result.push(card);
    seen.add(id);
  });
  return result;
}

export function parseColumnNameEntries(value) {
  if (!value) return [];
  const entries = [];
  if (Array.isArray(value)) {
    value.forEach((raw, index) => {
      const label = sanitizeText(raw);
      if (!label) return;
      entries.push({ index: index + 1, label });
    });
    return entries.sort((a, b) => a.index - b.index);
  }
  if (value instanceof Map) {
    value.forEach((raw, key) => {
      const label = sanitizeText(raw);
      const index = Number.parseInt(String(key), 10);
      if (!label || !Number.isInteger(index) || index < 1) return;
      entries.push({ index, label });
    });
    return entries.sort((a, b) => a.index - b.index);
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([rawKey, raw]) => {
      const label = sanitizeText(raw);
      const index = Number.parseInt(String(rawKey), 10);
      if (!label || !Number.isInteger(index) || index < 1) return;
      entries.push({ index, label });
    });
    return entries.sort((a, b) => a.index - b.index);
  }
  return entries;
}

export function parseDatasetIdentifier(value) {
  const text = sanitizeText(value);
  if (!text) {
    return { project: null, array: null };
  }
  const separatorIndex = text.indexOf('::');
  if (separatorIndex === -1) {
    return { project: null, array: text };
  }
  const project = sanitizeText(text.slice(0, separatorIndex));
  const array = sanitizeText(text.slice(separatorIndex + 2));
  return {
    project: project || null,
    array: array || null,
  };
}
