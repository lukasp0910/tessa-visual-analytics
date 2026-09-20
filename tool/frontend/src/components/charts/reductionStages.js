// Defines progress stages for dimensionality reduction methods

const DEFAULT_REDUCTION_STAGES = [
  { label: 'Initializing reduction', percentage: 5 },
  { label: 'Processing reduction', percentage: 55 },
  { label: 'Finalizing reduction', percentage: 100 },
];

const REDUCTION_STAGE_DEFINITIONS = {
  pca: [
    { label: 'Initializing PCA', percentage: 5 },
    { label: 'Centering data', percentage: 15 },
    { label: 'Running SVD', percentage: 35 },
    { label: 'Projecting components', percentage: 70 },
    { label: 'Computing principal components', percentage: 85 },
    { label: 'PCA completed', percentage: 100 },
  ],
  umap: [
    { label: 'Initializing UMAP', percentage: 5 },
    { label: 'Building neighbors graph', percentage: 10 },
    { label: 'Constructing high-dimensional graph', percentage: 20 },
    { label: 'Graph ready', percentage: 40 },
    { label: 'Optimizing layout', percentage: 55 },
    { label: 'Layout optimized', percentage: 70 },
    { label: 'Finalizing embedding', percentage: 85 },
    { label: 'Preparing coordinates', percentage: 90 },
    { label: 'UMAP completed', percentage: 100 },
  ],
  // t-SNE runs live and streams updates (these stages are fallback estimates)
  tsne: [
    { label: 'Initializing t-SNE', percentage: 5 },
    { label: 'Preparing initial layout', percentage: 20 },
    { label: 'Optimizing embedding', percentage: 50 },
    { label: 'Refining coordinates', percentage: 80 },
    { label: 't-SNE completed', percentage: 100 },
  ],
};

function normalizeMethod(method) {
  return typeof method === 'string' ? method.trim().toLowerCase() : '';
}

export function getReductionStages(method) {
  const normalized = normalizeMethod(method);
  return REDUCTION_STAGE_DEFINITIONS[normalized] || DEFAULT_REDUCTION_STAGES;
}

export function getInitialStage(method) {
  const stages = getReductionStages(method);
  return stages.length ? stages[0] : null;
}

export function getStageForPercentage(method, percentage) {
  const stages = getReductionStages(method);
  if (!Number.isFinite(percentage) || !stages.length) {
    return stages[0] || null;
  }
  const clamped = Math.max(0, Math.min(percentage, 100));
  let current = stages[0];
  for (const stage of stages) {
    if (clamped >= stage.percentage) {
      current = stage;
    } else {
      break;
    }
  }
  return current;
}

export function getDefaultStageLabel(method) {
  const stage = getInitialStage(method);
  if (stage) return stage.label;
  return DEFAULT_REDUCTION_STAGES[0]?.label || 'Processing reduction';
}

