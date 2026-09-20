import {
  clamp,
  updateCardElementPosition,
} from './cardsLayout.js';
import {
  isEditMode,
  getProjectName,
  getSheetId,
  getRowCount,
  getColumnCount,
  getCards,
  setActiveCard,
  persistCards,
  getCardSnapshot,
  restoreCardSnapshot,
  updateCardPosition,
  findCardIndex,
} from './cardsState.js';

function cardsOverlap(cardA, cardB) {
  if (!cardA || !cardB) return false;
  const rowsOverlap = cardA.topLeft.row <= cardB.bottomRight.row
    && cardA.bottomRight.row >= cardB.topLeft.row;
  const columnsOverlap = cardA.topLeft.column <= cardB.bottomRight.column
    && cardA.bottomRight.column >= cardB.topLeft.column;
  return rowsOverlap && columnsOverlap;
}

function computeGridMetrics(getGridElement) {
  const grid = typeof getGridElement === 'function' ? getGridElement() : null;
  if (!grid) return null;
  const rect = grid.getBoundingClientRect();
  const rows = Math.max(getRowCount(), 1);
  const columns = Math.max(getColumnCount(), 1);
  const rowHeight = rect.height / rows;
  const columnWidth = rect.width / columns;
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return null;
  if (!Number.isFinite(columnWidth) || columnWidth <= 0) return null;
  return { rect, rows, columns, rowHeight, columnWidth };
}

export function createCardsInteractions(options = {}) {
  const {
    getGridElement,
    getCardElement,
    onSelectionChange,
    onPersist,
  } = options;

  const persist = typeof onPersist === 'function' ? onPersist : persistCards;

  const activeInteractions = new Map();

  function startInteraction({ event, cardId, type, element, handle = null }) {
    if (!cardId || !element || !Number.isFinite(event.pointerId)) return;
    if (!isEditMode()) return;
    if (!getProjectName() || !getSheetId()) return;

    const metrics = computeGridMetrics(getGridElement);
    if (!metrics) return;

    const cardIndex = findCardIndex(cardId);
    if (cardIndex < 0) return;

    const startCard = getCardSnapshot(cardId);
    if (!startCard) return;

    const interaction = {
      cardId,
      cardIndex,
      type,
      handle,
      pointerId: event.pointerId,
      element,
      metrics,
      startPointer: { x: event.clientX, y: event.clientY },
      startCard,
      changed: false,
    };

    activeInteractions.set(event.pointerId, interaction);
    try {
      element.setPointerCapture(event.pointerId);
    } catch (error) {
      // ignore capture failures in browsers that do not support it
    }
    element.classList.add('is-interacting');
    event.preventDefault();
  }

  function applyMoveInteraction(interaction, event) {
    const { metrics, startPointer, startCard, cardId } = interaction;
    const spanRows = startCard.bottomRight.row - startCard.topLeft.row + 1;
    const spanColumns = startCard.bottomRight.column - startCard.topLeft.column + 1;
    const maxRowStart = Math.max(0, getRowCount() - spanRows);
    const maxColumnStart = Math.max(0, getColumnCount() - spanColumns);

    const deltaRows = Math.round((event.clientY - startPointer.y) / metrics.rowHeight);
    const deltaColumns = Math.round((event.clientX - startPointer.x) / metrics.columnWidth);

    const nextTopRow = clamp(startCard.topLeft.row + deltaRows, 0, maxRowStart);
    const nextLeftColumn = clamp(startCard.topLeft.column + deltaColumns, 0, maxColumnStart);
    const nextBottomRow = nextTopRow + spanRows - 1;
    const nextRightColumn = nextLeftColumn + spanColumns - 1;

    const currentCard = updateCardPosition(cardId, {
      topLeft: { row: nextTopRow, column: nextLeftColumn },
      bottomRight: { row: nextBottomRow, column: nextRightColumn },
    });
    if (!currentCard) {
      return false;
    }

    const element = typeof getCardElement === 'function' ? getCardElement(cardId) : null;
    if (element) {
      updateCardElementPosition(element, currentCard, getRowCount(), getColumnCount());
    }
    return true;
  }

  function applyResizeInteraction(interaction, event) {
    const { metrics, startPointer, startCard, cardId, handle } = interaction;
    const deltaRows = Math.round((event.clientY - startPointer.y) / metrics.rowHeight);
    const deltaColumns = Math.round((event.clientX - startPointer.x) / metrics.columnWidth);

    let nextTop = startCard.topLeft.row;
    let nextLeft = startCard.topLeft.column;
    let nextBottom = startCard.bottomRight.row;
    let nextRight = startCard.bottomRight.column;

    if (handle?.includes('n')) {
      nextTop = clamp(startCard.topLeft.row + deltaRows, 0, nextBottom);
    }
    if (handle?.includes('s')) {
      const maxRowIndex = Math.max(0, getRowCount() - 1);
      nextBottom = clamp(startCard.bottomRight.row + deltaRows, nextTop, maxRowIndex);
    }
    if (handle?.includes('w')) {
      nextLeft = clamp(startCard.topLeft.column + deltaColumns, 0, nextRight);
    }
    if (handle?.includes('e')) {
      const maxColumnIndex = Math.max(0, getColumnCount() - 1);
      nextRight = clamp(startCard.bottomRight.column + deltaColumns, nextLeft, maxColumnIndex);
    }

    if (
      startCard.topLeft.row === nextTop
      && startCard.topLeft.column === nextLeft
      && startCard.bottomRight.row === nextBottom
      && startCard.bottomRight.column === nextRight
    ) {
      return false;
    }

    const currentCard = updateCardPosition(cardId, {
      topLeft: { row: nextTop, column: nextLeft },
      bottomRight: { row: nextBottom, column: nextRight },
    });
    if (!currentCard) {
      return false;
    }

    const element = typeof getCardElement === 'function' ? getCardElement(cardId) : null;
    if (element) {
      updateCardElementPosition(element, currentCard, getRowCount(), getColumnCount());
    }
    return true;
  }

  function finishInteraction(interaction, { cancelled } = { cancelled: false }) {
    const { pointerId, element, startCard, cardId } = interaction;
    if (element?.hasPointerCapture?.(pointerId)) {
      try {
        element.releasePointerCapture(pointerId);
      } catch (error) {
        // ignore release failures
      }
    }
    element?.classList?.remove('is-interacting');
    activeInteractions.delete(pointerId);

    if (cancelled) {
      const restored = restoreCardSnapshot(cardId, startCard);
      if (restored) {
        const node = typeof getCardElement === 'function' ? getCardElement(cardId) : null;
        if (node) {
          updateCardElementPosition(node, restored, getRowCount(), getColumnCount());
        }
      }
      return;
    }

    const selectionChanged = setActiveCard(cardId, { persist: true });
    if (selectionChanged && typeof onSelectionChange === 'function') {
      onSelectionChange(cardId);
    }

    if (!interaction.changed) {
      return;
    }

    const currentCard = getCards()[interaction.cardIndex];
    if (!currentCard) {
      restoreCardSnapshot(cardId, startCard);
      return;
    }

    const hasOverlap = getCards().some((card, index) => index !== interaction.cardIndex && cardsOverlap(currentCard, card));
    if (hasOverlap) {
      const restored = restoreCardSnapshot(cardId, startCard);
      if (restored) {
        const node = typeof getCardElement === 'function' ? getCardElement(cardId) : null;
        if (node) {
          updateCardElementPosition(node, restored, getRowCount(), getColumnCount());
        }
      }
      return;
    }

    persist();
  }

  function handlePointerMove(event) {
    const interaction = activeInteractions.get(event.pointerId);
    if (!interaction) return;

    let changed = false;
    if (interaction.type === 'move') {
      changed = applyMoveInteraction(interaction, event);
    } else if (interaction.type === 'resize') {
      changed = applyResizeInteraction(interaction, event);
    }

    if (changed) {
      interaction.changed = true;
    }
  }

  function handlePointerUp(event) {
    const interaction = activeInteractions.get(event.pointerId);
    if (!interaction) return;
    finishInteraction(interaction, { cancelled: false });
  }

  function handlePointerCancel(event) {
    const interaction = activeInteractions.get(event.pointerId);
    if (!interaction) return;
    finishInteraction(interaction, { cancelled: true });
  }

  function cancelAllInteractions({ revert = false } = {}) {
    Array.from(activeInteractions.values()).forEach(interaction => {
      finishInteraction(interaction, { cancelled: revert });
    });
    activeInteractions.clear();
  }

  function handleMovePointerDown(event, cardId) {
    if (!cardId) return;
    const cardElement = event.currentTarget?.parentElement;
    if (!cardElement || cardElement.dataset.cardId !== cardId) return;
    startInteraction({
      event,
      cardId,
      type: 'move',
      element: cardElement,
    });
  }

  function handleResizePointerDown(event, cardId, handle) {
    if (!cardId) return;
    const cardElement = event.currentTarget?.closest('[data-card-id]');
    if (!cardElement || cardElement.dataset.cardId !== cardId) return;
    startInteraction({
      event,
      cardId,
      type: 'resize',
      element: cardElement,
      handle,
    });
  }

  return {
    handleMovePointerDown,
    handleResizePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    cancelAllInteractions,
  };
}

export default createCardsInteractions;
