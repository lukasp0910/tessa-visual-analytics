// Polls backend for dimensionality reduction progress updates

import { requestJson } from '../../api/client.js';

export class ScatterProgressPoller {
  constructor({ projectId, sheetId, cardId, pollInterval = 500 }) {
    this.projectId = projectId;
    this.sheetId = sheetId;
    this.cardId = cardId;
    this.pollInterval = pollInterval;
    this.isPolling = false;
    this.timerId = null;
    this.listeners = new Set();
    this.hasReceivedUpdate = false;
  }

  start() {
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;
    this.hasReceivedUpdate = false;
    this._poll();
  }

  stop() {
    this.isPolling = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  addListener(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Listener must be a function');
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  removeListener(listener) {
    this.listeners.delete(listener);
  }

  clearListeners() {
    this.listeners.clear();
  }

  async _poll() {
    if (!this.isPolling) {
      return;
    }

    try {
      const params = new URLSearchParams({
        project_id: this.projectId,
        sheet_id: this.sheetId,
        card_id: this.cardId,
      });

      const url = `/api/v1/charts/scatter/progress?${params.toString()}`;
      const data = await requestJson(url);

      if (!this.isPolling) {
        return;
      }

      const percentage = typeof data.percentage === 'number' ? data.percentage : 0;
      const status = typeof data.status === 'string' ? data.status : 'running';
      const message = typeof data.message === 'string' ? data.message : 'Processing…';
      const method = typeof data.method === 'string' ? data.method : null;

      this.hasReceivedUpdate = true;
      this._notifyListeners({ percentage, status, message, method });

      if (percentage >= 100 || status === 'completed' || status === 'error') {
        this.stop();
        return;
      }

      this.timerId = setTimeout(() => this._poll(), this.pollInterval);
    } catch (error) {
      if (!this.isPolling) {
        return;
      }

      // 404 means job not found (either not started yet or already completed)
      if (error?.status === 404 || error?.statusCode === 404) {
        if (this.hasReceivedUpdate) {
          this._notifyListeners({
            percentage: 100,
            status: 'completed',
            message: 'Dimensionality reduction completed',
          });
          this.stop();
          return;
        }

        if (this.isPolling) {
          this.timerId = setTimeout(() => this._poll(), this.pollInterval);
        }
        return;
      }

      console.warn('[ScatterProgressPoller] Progress check failed, will retry', error);

      if (this.isPolling) {
        this.timerId = setTimeout(() => this._poll(), this.pollInterval);
      }
    }
  }

  _notifyListeners(data) {
    this.listeners.forEach(listener => {
      try {
        listener(data);
      } catch (error) {
        console.error('[ScatterProgressPoller] Listener error', error);
      }
    });
  }
}

export default ScatterProgressPoller;
