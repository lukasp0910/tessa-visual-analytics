// Shared performance utilities for scatter chart downsampling/decimation
// Used by both 2D and 3D scatter charts for Performance Mode

export const PERFORMANCE_CONFIG = {
  // Decimation ratios for different modes
  points: {
    sampleStep: 3, // Every 3rd point
  },
  line: {
    sampleStep: 3, // Every 3rd vertex
  },
  // Minimum points to preserve for visibility
  minPoints: 100,
  // Adaptive thresholds
  largeDatasetThreshold: 10000,
};

// Calculate adaptive sample step based on dataset size
export function getAdaptiveSampleStep(totalPoints, mode) {
  if (totalPoints <= PERFORMANCE_CONFIG.minPoints) {
    return 1; // No downsampling for small datasets
  }

  const baseStep = PERFORMANCE_CONFIG[mode]?.sampleStep || 3;

  if (totalPoints <= PERFORMANCE_CONFIG.largeDatasetThreshold) {
    return baseStep;
  }

  // For very large datasets, increase step size
  const scaleFactor = Math.floor(totalPoints / PERFORMANCE_CONFIG.largeDatasetThreshold);
  return Math.min(baseStep * scaleFactor, 10); // Cap at 10 to avoid too much decimation
}

export function getDownsampledIndices(totalPoints, performanceMode) {
  if (!performanceMode || totalPoints <= PERFORMANCE_CONFIG.minPoints) {
    return Array.from({ length: totalPoints }, (_, i) => i);
  }

  const step = getAdaptiveSampleStep(totalPoints, 'points');
  const indices = [];
  for (let i = 0; i < totalPoints; i += step) {
    indices.push(i);
  }
  return indices;
}

export function decimateLinePoints(pointsF32, performanceMode) {
  const totalPoints = pointsF32.length / 2;
  if (!performanceMode || totalPoints <= PERFORMANCE_CONFIG.minPoints) {
    return { points: null, step: 1 }; // No decimation
  }

  const step = getAdaptiveSampleStep(totalPoints, 'line');
  return { points: null, step }; // Return step for caller to use
}

export function shouldAllowTrailGlow(performanceMode) {
  return true; // Always allow trail glow regardless of performance mode
}

// Generate random sample indices based on percentage
export function getRandomSampleIndices(totalPoints, percentage) {
  // Clamp percentage to valid range
  const pct = Math.max(5, Math.min(100, percentage));
  
  // Calculate target count (ensure at least 1 point)
  const targetCount = Math.max(1, Math.round((pct / 100) * totalPoints));
  
  // If showing all or nearly all points, return all indices
  if (targetCount >= totalPoints) {
    return new Set(Array.from({ length: totalPoints }, (_, i) => i));
  }
  
  // Random sampling without replacement using Fisher-Yates shuffle
  const indices = new Set();
  const pool = Array.from({ length: totalPoints }, (_, i) => i);
  
  for (let i = 0; i < targetCount; i++) {
    const randomIndex = Math.floor(Math.random() * (totalPoints - i));
    indices.add(pool[randomIndex]);
    // Swap selected with last unselected
    pool[randomIndex] = pool[totalPoints - i - 1];
  }
  
  return indices;
}