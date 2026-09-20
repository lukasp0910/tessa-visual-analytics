import { clearChildren, safeText, toggleHidden } from './dom.js';

function ensureElement(element) {
  return element ?? null;
}

export function createTableRenderer({ headElement, bodyElement, emptyStateElement } = {}) {
  const head = ensureElement(headElement);
  const body = ensureElement(bodyElement);
  const emptyState = ensureElement(emptyStateElement);

  function render(columns = [], rows = [], { emptyMessage = 'No rows to display.' } = {}) {
    if (typeof document === 'undefined') {
      console.warn('[ui:table] render called without DOM availability.');
      return;
    }
    if (head) {
      clearChildren(head);
      const headerRow = document.createElement('tr');
      columns.forEach(column => {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = safeText(column);
        headerRow.appendChild(th);
      });
      head.appendChild(headerRow);
    }

    if (!rows.length && emptyState) {
      emptyState.textContent = emptyMessage;
      toggleHidden(emptyState, false);
    } else if (emptyState) {
      toggleHidden(emptyState, true);
    }

    if (!body) return;

    clearChildren(body);
    if (!rows.length) {
      if (!head && body) {
        const emptyRow = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = Math.max(columns.length, 1);
        cell.textContent = emptyMessage;
        emptyRow.appendChild(cell);
        body.appendChild(emptyRow);
      }
      return;
    }

    rows.forEach(row => {
      const tr = document.createElement('tr');
      row.forEach(value => {
        const td = document.createElement('td');
        td.textContent = safeText(value);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  function clear() {
    if (head) clearChildren(head);
    if (body) clearChildren(body);
    if (emptyState) toggleHidden(emptyState, false);
  }

  return { render, clear };
}

export function createColumnTooltipController() {
  const tooltips = new Set();

  function register(tooltip) {
    if (!tooltip) return () => {};
    tooltips.add(tooltip);
    return () => {
      tooltips.delete(tooltip);
    };
  }

  function hideAll() {
    tooltips.forEach(tooltip => {
      tooltip.classList.add('hidden');
      if (tooltip.dataset) {
        tooltip.dataset.visible = 'false';
      }
    });
  }

  return { register, hideAll };
}

export const table = {
  createTableRenderer,
  createColumnTooltipController,
};

export default table;
