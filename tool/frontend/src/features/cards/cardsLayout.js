export const DEFAULT_ROW_COUNT = 12;
export const DEFAULT_COLUMN_COUNT = 12;
export const DEFAULT_CARD_ROWS = 3;
export const DEFAULT_CARD_COLUMNS = 4;

export function clamp(value, min, max) {
  const lower = Number.isFinite(min) ? min : 0;
  const upper = Number.isFinite(max) ? max : lower;
  if (upper < lower) return lower;
  return Math.min(Math.max(value, lower), upper);
}

export function sanitizeDimension(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

export function sanitizeCoordinate(value, limit) {
  const maxIndex = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
  let candidate = 0;

  if (typeof value === 'number' && Number.isFinite(value)) {
    candidate = Math.trunc(value);
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (text) {
      const parsed = Number.parseInt(text, 10);
      if (Number.isInteger(parsed)) {
        candidate = parsed;
      }
    }
  } else if (value != null) {
    const text = String(value).trim();
    if (text) {
      const parsed = Number.parseInt(text, 10);
      if (Number.isInteger(parsed)) {
        candidate = parsed;
      }
    }
  }

  if (!Number.isInteger(candidate)) {
    candidate = 0;
  }

  return clamp(candidate, 0, maxIndex);
}

export function normalizeGridSize(rowCount, columnCount, fallback = {}) {
  const fallbackRows = Number.isInteger(fallback.rows)
    ? fallback.rows
    : DEFAULT_ROW_COUNT;
  const fallbackColumns = Number.isInteger(fallback.columns)
    ? fallback.columns
    : DEFAULT_COLUMN_COUNT;

  return {
    rows: sanitizeDimension(rowCount, fallbackRows),
    columns: sanitizeDimension(columnCount, fallbackColumns),
  };
}

export function measureCardPlacement(card, rows, columns) {
  if (!card) return null;
  const totalRows = Math.max(1, Math.trunc(rows) || 0);
  const totalColumns = Math.max(1, Math.trunc(columns) || 0);
  const topRow = clamp(card?.topLeft?.row ?? 0, 0, totalRows - 1);
  const leftColumn = clamp(card?.topLeft?.column ?? 0, 0, totalColumns - 1);
  const bottomRow = clamp(card?.bottomRight?.row ?? topRow, topRow, totalRows - 1);
  const rightColumn = clamp(card?.bottomRight?.column ?? leftColumn, leftColumn, totalColumns - 1);
  const rowSpan = Math.max(1, bottomRow - topRow + 1);
  const columnSpan = Math.max(1, rightColumn - leftColumn + 1);

  return {
    topRow,
    leftColumn,
    bottomRow,
    rightColumn,
    rowSpan,
    columnSpan,
    top: (topRow / totalRows) * 100,
    left: (leftColumn / totalColumns) * 100,
    height: (rowSpan / totalRows) * 100,
    width: (columnSpan / totalColumns) * 100,
  };
}

export function updateCardElementPosition(element, card, rows, columns) {
  if (!element) return;
  const placement = measureCardPlacement(card, rows, columns);
  if (!placement) return;

  element.style.setProperty('--card-top', `${placement.top}%`);
  element.style.setProperty('--card-left', `${placement.left}%`);
  element.style.setProperty('--card-height', `${placement.height}%`);
  element.style.setProperty('--card-width', `${placement.width}%`);
}

function buildOccupancyGrid(cards, rows, columns) {
  const grid = Array.from({ length: rows }, () => new Array(columns).fill(false));
  cards.forEach(card => {
    if (!card || !card.topLeft || !card.bottomRight) return;
    const top = Math.max(0, Math.min(rows - 1, card.topLeft.row));
    const left = Math.max(0, Math.min(columns - 1, card.topLeft.column));
    const bottom = Math.max(0, Math.min(rows - 1, card.bottomRight.row));
    const right = Math.max(0, Math.min(columns - 1, card.bottomRight.column));
    for (let row = top; row <= bottom; row += 1) {
      const rowArray = grid[row];
      for (let column = left; column <= right; column += 1) {
        rowArray[column] = true;
      }
    }
  });
  return grid;
}

export function findLargestEmptyRectangle(cards, rows, columns) {
  if (rows <= 0 || columns <= 0) return null;
  const occupancy = buildOccupancyGrid(cards, rows, columns);
  const heights = new Array(columns).fill(0);
  let maxArea = 0;
  let best = null;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      heights[column] = occupancy[row][column] ? 0 : heights[column] + 1;
    }

    const stack = [];
    for (let column = 0; column <= columns; column += 1) {
      const currentHeight = column < columns ? heights[column] : 0;
      let startIndex = column;
      while (stack.length > 0 && stack[stack.length - 1].height > currentHeight) {
        const { index, height } = stack.pop();
        const width = column - index;
        const area = height * width;
        if (area > 0) {
          const topRow = row - height + 1;
          const leftColumn = index;
          if (
            area > maxArea
            || (
              area === maxArea
              && best
              && (topRow < best.topRow
                || (topRow === best.topRow && leftColumn < best.leftColumn))
            )
          ) {
            maxArea = area;
            best = { topRow, leftColumn, height, width };
          }
        }
        startIndex = index;
      }

      if (currentHeight > 0) {
        if (stack.length === 0 || stack[stack.length - 1].height < currentHeight) {
          stack.push({ index: startIndex, height: currentHeight });
        } else {
          stack[stack.length - 1].index = Math.min(stack[stack.length - 1].index, startIndex);
          stack[stack.length - 1].height = currentHeight;
        }
      }
    }
  }

  return best;
}
