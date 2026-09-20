import { listSheets, setActiveCardPreference, updateSheet } from '../../api/sheets.js';
import { getSnapshot, subscribe } from '../../state/store.js';
import {
  DEFAULT_ROW_COUNT,
  DEFAULT_COLUMN_COUNT,
  normalizeGridSize,
} from './cardsLayout.js';
import {
  sanitizeCards,
  createConfigurationDetail,
  cloneConfigurationDetail,
  cloneConfiguration,
  normalizeConfiguration,
} from './cardsSanitizers.js';

export const FEATURE_NAME = 'cards';

const state = {
  initialized: false,
  mode: 'explore',
  projectName: null,
  sheetId: null,
  rowCount: DEFAULT_ROW_COUNT,
  columnCount: DEFAULT_COLUMN_COUNT,
  cards: [],
  activeCardId: null,
  persistedActiveCardId: null,
  persistPending: false,
  persistQueued: false,
  activeCardPersistPending: false,
  activeCardPersistQueued: false,
};

const cardConfigurations = new Map();
let nextCardIndex = 1;
let storeUnsubscribe = null;
let storeListener = null;

function logDebug(message, ...args) {
  console.debug(`[Feature:${FEATURE_NAME}] ${message}`, ...args);
}

function sanitizeActiveCardId(cardId, cards) {
  const normalized = typeof cardId === 'string' ? cardId.trim() : '';
  if (!normalized) return null;
  if (!Array.isArray(cards)) return null;
  return cards.some(card => card?.id === normalized) ? normalized : null;
}

function cloneCard(card) {
  if (!card || typeof card !== 'object') {
    return null;
  }
  const cloned = {
    id: card.id,
    topLeft: {
      row: Number.isInteger(card?.topLeft?.row) ? card.topLeft.row : 0,
      column: Number.isInteger(card?.topLeft?.column) ? card.topLeft.column : 0,
    },
    bottomRight: {
      row: Number.isInteger(card?.bottomRight?.row) ? card.bottomRight.row : 0,
      column: Number.isInteger(card?.bottomRight?.column) ? card.bottomRight.column : 0,
    },
  };
  const configuration = cloneConfiguration(card.configuration);
  if (configuration) {
    cloned.configuration = configuration;
  }
  return cloned;
}

function updateCardIndex(cards = state.cards) {
  let maxIndex = 0;
  cards.forEach(card => {
    const match = card.id && String(card.id).match(/card-(\d+)/i);
    if (!match) return;
    const value = Number.parseInt(match[1], 10);
    if (Number.isInteger(value) && value > maxIndex) {
      maxIndex = value;
    }
  });
  nextCardIndex = Math.max(maxIndex + 1, cards.length + 1);
}

function syncCardConfigurationsFromState() {
  const seen = new Set();
  const context = { projectName: state.projectName, sheetId: state.sheetId };
  state.cards.forEach(card => {
    if (!card || !card.id) return;
    seen.add(card.id);
    if (!card.configuration) return;
    const detail = createConfigurationDetail(card.id, card.configuration, context);
    if (detail) {
      cardConfigurations.set(card.id, detail);
    }
  });
  Array.from(cardConfigurations.keys()).forEach(key => {
    if (!seen.has(key)) {
      cardConfigurations.delete(key);
    }
  });
}

function handleStoreSnapshot(snapshot) {
  const mode = snapshot?.ui?.interactionMode || 'explore';
  const modeChanged = mode !== state.mode;
  if (modeChanged) {
    state.mode = mode;
  }
  if (typeof storeListener === 'function') {
    try {
      storeListener({ snapshot, mode, modeChanged });
    } catch (error) {
      logDebug('store listener failed', error);
    }
  }
}

export function initCardsState(options = {}) {
  if (storeUnsubscribe) {
    return;
  }
  storeListener = typeof options.onStoreSnapshot === 'function' ? options.onStoreSnapshot : null;
  storeUnsubscribe = subscribe(handleStoreSnapshot);
  handleStoreSnapshot(getSnapshot());
}

export function teardownCardsState() {
  if (storeUnsubscribe) {
    storeUnsubscribe();
    storeUnsubscribe = null;
  }
  storeListener = null;
}

export function isInitialized() {
  return state.initialized;
}

export function setInitialized(value) {
  state.initialized = Boolean(value);
}

export function getMode() {
  return state.mode;
}

export function isEditMode() {
  return state.mode === 'edit';
}

export function getProjectName() {
  return state.projectName;
}

export function getSheetId() {
  return state.sheetId;
}

export function getRowCount() {
  return state.rowCount;
}

export function getColumnCount() {
  return state.columnCount;
}

export function getCards() {
  return state.cards;
}

export function getActiveCardId() {
  return state.activeCardId;
}

export function isPersistPending() {
  return state.persistPending;
}

export function isActiveCardPersistPending() {
  return state.activeCardPersistPending;
}

export function generateCardId() {
  let candidate = '';
  do {
    candidate = `card-${nextCardIndex}`;
    nextCardIndex += 1;
  } while (state.cards.some(card => card.id === candidate));
  return candidate;
}

export function findCardIndex(cardId) {
  if (!cardId) return -1;
  return state.cards.findIndex(card => card?.id === cardId);
}

export function getCardAt(index) {
  return index >= 0 ? state.cards[index] || null : null;
}

export function replaceCardAt(index, card) {
  if (index < 0) return null;
  const clone = cloneCard(card);
  if (!clone) return null;
  state.cards[index] = clone;
  return state.cards[index];
}

export function removeCardAt(index) {
  if (index < 0) return null;
  const [removed] = state.cards.splice(index, 1);
  if (removed?.id) {
    cardConfigurations.delete(removed.id);
  }
  updateCardIndex(state.cards);
  return removed || null;
}

export function appendCard(card) {
  const clone = cloneCard(card);
  if (!clone) return null;
  state.cards.push(clone);
  updateCardIndex(state.cards);
  return state.cards[state.cards.length - 1];
}

export function resetCardsState() {
  state.cards = [];
  state.activeCardId = null;
  state.persistedActiveCardId = null;
  state.persistPending = false;
  state.persistQueued = false;
  state.activeCardPersistPending = false;
  state.activeCardPersistQueued = false;
  cardConfigurations.clear();
  updateCardIndex();
}

export function applySheetSelection(detail = {}) {
  const previousProject = state.projectName;
  const nextProjectName = typeof detail.projectName === 'string' && detail.projectName.trim()
    ? detail.projectName.trim()
    : previousProject;
  const projectChanged = nextProjectName !== previousProject;
  state.projectName = nextProjectName;
  state.sheetId = typeof detail.sheetId === 'string' && detail.sheetId.trim()
    ? detail.sheetId.trim()
    : null;

  if (!detail.sheet || !state.sheetId) {
    state.rowCount = DEFAULT_ROW_COUNT;
    state.columnCount = DEFAULT_COLUMN_COUNT;
    resetCardsState();
    return { hasSheet: false, projectChanged };
  }

  const sheet = detail.sheet && typeof detail.sheet === 'object' ? detail.sheet : null;
  if (!sheet) {
    resetCardsState();
    state.rowCount = DEFAULT_ROW_COUNT;
    state.columnCount = DEFAULT_COLUMN_COUNT;
    return { hasSheet: false, projectChanged };
  }

  const { rows, columns } = normalizeGridSize(sheet.rowCount, sheet.columnCount, {
    rows: DEFAULT_ROW_COUNT,
    columns: DEFAULT_COLUMN_COUNT,
  });
  state.rowCount = rows;
  state.columnCount = columns;
  state.cards = sanitizeCards(sheet.cards, rows, columns);
  syncCardConfigurationsFromState();
  const activeCardId = sanitizeActiveCardId(
    sheet.lastActiveCardId ?? sheet.last_active_card_id,
    state.cards,
  );
  state.activeCardId = activeCardId;
  state.persistedActiveCardId = activeCardId;
  state.activeCardPersistPending = false;
  state.activeCardPersistQueued = false;
  updateCardIndex(state.cards);
  return { hasSheet: true, projectChanged };
}

export function applySheetDeletion({ projectName, sheetId }) {
  const normalizedSheetId = typeof sheetId === 'string' ? sheetId.trim() : '';
  if (!normalizedSheetId) {
    return { cleared: false };
  }
  const normalizedProject = typeof projectName === 'string' ? projectName.trim() : '';
  if (state.sheetId && state.sheetId === normalizedSheetId) {
    if (!normalizedProject || !state.projectName || normalizedProject === state.projectName) {
      state.sheetId = null;
      state.rowCount = DEFAULT_ROW_COUNT;
      state.columnCount = DEFAULT_COLUMN_COUNT;
      resetCardsState();
      return { cleared: true };
    }
  }
  return { cleared: false };
}

export function getCardConfiguration(cardId) {
  const detail = cardConfigurations.get(cardId);
  return detail ? cloneConfigurationDetail(detail) : null;
}

export function setCardConfiguration(cardId, detail) {
  const normalizedId = typeof cardId === 'string' ? cardId.trim() : '';
  if (!normalizedId) return null;
  const configuration = normalizeConfiguration(detail || {});
  const context = {
    projectName: typeof detail?.projectName === 'string' && detail.projectName.trim()
      ? detail.projectName.trim()
      : state.projectName,
    sheetId: typeof detail?.sheetId === 'string' && detail.sheetId.trim()
      ? detail.sheetId.trim()
      : state.sheetId,
  };
  if (!configuration) {
    cardConfigurations.delete(normalizedId);
    const existingCard = state.cards.find(entry => entry?.id === normalizedId);
    if (existingCard && existingCard.configuration) {
      delete existingCard.configuration;
    }
    return null;
  }
  const normalized = createConfigurationDetail(
    normalizedId,
    configuration,
    context,
  );
  cardConfigurations.set(normalizedId, normalized);
  const existingCard = state.cards.find(entry => entry?.id === normalizedId);
  if (existingCard) {
    existingCard.configuration = cloneConfiguration(configuration) || configuration;
  }
  return cloneConfigurationDetail(normalized);
}

export function deleteCardConfiguration(cardId) {
  cardConfigurations.delete(cardId);
}

export async function ensureCardConfiguration(cardId, options = {}) {
  const normalizedId = typeof cardId === 'string' ? cardId.trim() : '';
  if (!normalizedId) return null;
  const refresh = Boolean(options.refresh);

  if (!refresh) {
    const existing = cardConfigurations.get(normalizedId);
    if (existing) {
      return cloneConfigurationDetail(existing);
    }
  }

  const card = state.cards.find(entry => entry?.id === normalizedId && entry.configuration);
  if (card?.configuration) {
    const detail = createConfigurationDetail(normalizedId, card.configuration, {
      projectName: state.projectName,
      sheetId: state.sheetId,
    });
    if (detail) {
      cardConfigurations.set(normalizedId, detail);
      return cloneConfigurationDetail(detail);
    }
  }

  if (!state.projectName) {
    return null;
  }

  try {
    const response = await listSheets(state.projectName);
    const sheets = Array.isArray(response?.sheets) ? response.sheets : [];
    const sheet = sheets.find(entry => entry?.id === state.sheetId) || null;
    if (!sheet) {
      return cardConfigurations.get(normalizedId)
        ? cloneConfigurationDetail(cardConfigurations.get(normalizedId))
        : null;
    }
    const sanitizedCards = sanitizeCards(sheet.cards, state.rowCount, state.columnCount);
    const match = sanitizedCards.find(entry => entry?.id === normalizedId) || null;
    if (match?.configuration) {
      const detail = createConfigurationDetail(normalizedId, match.configuration, {
        projectName: state.projectName,
        sheetId: state.sheetId,
      });
      if (detail) {
        cardConfigurations.set(normalizedId, detail);
        return cloneConfigurationDetail(detail);
      }
    }
  } catch (error) {
    console.error(`[Feature:${FEATURE_NAME}] Failed to load card configuration`, error);
  }

  const existing = cardConfigurations.get(normalizedId);
  return existing ? cloneConfigurationDetail(existing) : null;
}

export function setActiveCard(cardId, { persist = false } = {}) {
  let normalized = null;
  if (typeof cardId === 'string') {
    normalized = sanitizeActiveCardId(cardId, state.cards);
  } else if (cardId != null) {
    normalized = sanitizeActiveCardId(String(cardId), state.cards);
  }
  if (cardId == null) {
    normalized = null;
  }
  const hasChanged = state.activeCardId !== normalized;
  if (hasChanged) {
    state.activeCardId = normalized;
    dispatchCardsUpdated('select');
  }
  if (persist && state.activeCardId !== state.persistedActiveCardId) {
    persistActiveCardSelection();
  }
  return hasChanged;
}

export function serializeCards() {
  return state.cards.map(card => cloneCard(card));
}

export function dispatchCardsUpdated(reason = 'update') {
  if (!state.sheetId) return;
  document.dispatchEvent(
    new CustomEvent('sheet:cards-updated', {
      detail: {
        projectName: state.projectName,
        sheetId: state.sheetId,
        cards: serializeCards(),
        activeCardId: state.activeCardId,
        reason,
      },
    }),
  );
}

export async function persistActiveCardSelection() {
  if (!isEditMode()) return { persisted: false };
  if (!state.projectName || !state.sheetId) return { persisted: false };
  if (state.activeCardId === state.persistedActiveCardId) {
    return { persisted: false };
  }
  if (state.activeCardPersistPending) {
    state.activeCardPersistQueued = true;
    return { persisted: false, queued: true };
  }

  state.activeCardPersistPending = true;
  let result = { persisted: false };
  try {
    const response = await setActiveCardPreference(
      state.projectName,
      state.sheetId,
      state.activeCardId,
    );
    const sheets = Array.isArray(response?.sheets) ? response.sheets : [];
    const updatedSheet = sheets.find(sheet => sheet?.id === state.sheetId) || null;
    if (updatedSheet) {
      const sanitizedCards = sanitizeCards(updatedSheet.cards, state.rowCount, state.columnCount);
      state.cards = sanitizedCards;
      syncCardConfigurationsFromState();
      const activeCard = sanitizeActiveCardId(updatedSheet.lastActiveCardId, sanitizedCards);
      state.persistedActiveCardId = activeCard;
      state.activeCardId = activeCard;
      updateCardIndex(state.cards);
      dispatchCardsUpdated('select');
      result = { persisted: true, updated: true };
    } else {
      state.persistedActiveCardId = state.activeCardId;
      dispatchCardsUpdated('select');
      result = { persisted: true, updated: false };
    }
  } catch (error) {
    console.error(`[Feature:${FEATURE_NAME}] Failed to persist active card`, error);
    result = { persisted: false, error };
  } finally {
    state.activeCardPersistPending = false;
    if (state.activeCardPersistQueued) {
      state.activeCardPersistQueued = false;
      await persistActiveCardSelection();
    }
  }
  return result;
}

export async function persistCards() {
  if (!isEditMode()) return { persisted: false };
  if (!state.projectName || !state.sheetId) return { persisted: false };
  if (state.persistPending) {
    state.persistQueued = true;
    return { persisted: false, queued: true };
  }

  state.persistPending = true;
  let result = { persisted: false };
  try {
    const payload = { cards: serializeCards() };
    const response = await updateSheet(state.projectName, state.sheetId, payload);
    const sheets = Array.isArray(response?.sheets) ? response.sheets : [];
    const updatedSheet = sheets.find(sheet => sheet?.id === state.sheetId) || null;
    if (updatedSheet) {
      const normalized = normalizeGridSize(updatedSheet.rowCount, updatedSheet.columnCount, {
        rows: state.rowCount,
        columns: state.columnCount,
      });
      state.rowCount = normalized.rows;
      state.columnCount = normalized.columns;
      state.cards = sanitizeCards(updatedSheet.cards, state.rowCount, state.columnCount);
      syncCardConfigurationsFromState();
      const activeCard = sanitizeActiveCardId(updatedSheet.lastActiveCardId, state.cards);
      state.activeCardId = activeCard;
      state.persistedActiveCardId = activeCard;
      updateCardIndex(state.cards);
      result = { persisted: true, updated: true };
    } else {
      state.persistedActiveCardId = state.activeCardId;
      result = { persisted: true, updated: false };
    }
    dispatchCardsUpdated('persist');
  } catch (error) {
    console.error(`[Feature:${FEATURE_NAME}] Failed to persist cards`, error);
    result = { persisted: false, error };
  } finally {
    state.persistPending = false;
    const shouldRepeat = state.persistQueued;
    state.persistQueued = false;
    if (shouldRepeat) {
      result = await persistCards();
    }
  }
  return result;
}

export function markCardsDirty() {
  state.persistQueued = true;
}

export function getCardSnapshot(cardId) {
  const card = state.cards.find(entry => entry?.id === cardId);
  return card ? cloneCard(card) : null;
}

export function restoreCardSnapshot(cardId, snapshot) {
  const index = findCardIndex(cardId);
  if (index < 0) return null;
  const clone = cloneCard(snapshot);
  if (!clone) return null;
  state.cards[index] = clone;
  return state.cards[index];
}

export function updateCardPosition(cardId, nextPosition) {
  const index = findCardIndex(cardId);
  if (index < 0) return null;
  const card = state.cards[index];
  if (!card) return null;
  const topLeft = nextPosition?.topLeft || {};
  const bottomRight = nextPosition?.bottomRight || {};
  card.topLeft.row = Number.isInteger(topLeft.row) ? topLeft.row : card.topLeft.row;
  card.topLeft.column = Number.isInteger(topLeft.column) ? topLeft.column : card.topLeft.column;
  card.bottomRight.row = Number.isInteger(bottomRight.row) ? bottomRight.row : card.bottomRight.row;
  card.bottomRight.column = Number.isInteger(bottomRight.column) ? bottomRight.column : card.bottomRight.column;
  return card;
}

export function getCardCount() {
  return state.cards.length;
}

export function getCardConfigurationsMap() {
  return cardConfigurations;
}

export default {
  FEATURE_NAME,
  initCardsState,
  teardownCardsState,
  isInitialized,
  setInitialized,
  getMode,
  isEditMode,
  getProjectName,
  getSheetId,
  getRowCount,
  getColumnCount,
  getCards,
  getActiveCardId,
  isPersistPending,
  isActiveCardPersistPending,
  generateCardId,
  findCardIndex,
  getCardAt,
  replaceCardAt,
  removeCardAt,
  appendCard,
  resetCardsState,
  applySheetSelection,
  applySheetDeletion,
  getCardConfiguration,
  setCardConfiguration,
  deleteCardConfiguration,
  ensureCardConfiguration,
  setActiveCard,
  serializeCards,
  dispatchCardsUpdated,
  persistActiveCardSelection,
  persistCards,
  markCardsDirty,
  getCardSnapshot,
  restoreCardSnapshot,
  updateCardPosition,
  getCardCount,
  getCardConfigurationsMap,
};
