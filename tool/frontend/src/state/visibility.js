const DEFAULT_VISIBILITY = {
  visible: true,
};

export function createVisibilityDraft(project) {
  if (!project) {
    return { project: null, arrays: {} };
  }
  const arrays = {};
  if (Array.isArray(project.arrays)) {
    project.arrays.forEach(array => {
      const key = array?.id ?? array?.name;
      if (!key) return;
      arrays[key] = {
        name: array.name ?? key,
        id: array.id ?? key,
        visible: array.visible ?? DEFAULT_VISIBILITY.visible,
      };
    });
  }
  return {
    project: project.name ?? null,
    arrays,
  };
}

export function applyVisibilityChange(draft, arrayId, changes) {
  if (!draft || !arrayId) return draft;
  const next = draft.arrays[arrayId] || { id: arrayId, ...DEFAULT_VISIBILITY };
  draft.arrays[arrayId] = {
    ...next,
    ...changes,
  };
  return draft;
}

export function buildVisibilityPayload(draft) {
  if (!draft || !draft.project) {
    return null;
  }
  const entries = Object.entries(draft.arrays).map(([id, value]) => ({
    id,
    visible: value?.visible ?? DEFAULT_VISIBILITY.visible,
  }));
  return {
    project: draft.project,
    arrays: entries,
  };
}

export function resetVisibilityDraft() {
  return { project: null, arrays: {} };
}

export const visibilityHelpers = {
  createVisibilityDraft,
  applyVisibilityChange,
  buildVisibilityPayload,
  resetVisibilityDraft,
};

export default visibilityHelpers;
