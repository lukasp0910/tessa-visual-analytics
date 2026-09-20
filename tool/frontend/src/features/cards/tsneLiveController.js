// Controls live t-SNE iterations with backend polling

import { requestJson } from '../../api/client.js';

export class TsneLiveController {
  constructor({ sessionId, projectId, sheetId, cardId, pollInterval = 400 } = {}) {
    this.sessionId = sessionId;
    this.projectId = projectId;
    this.sheetId = sheetId;
    this.cardId = cardId;
    this.pollInterval = pollInterval;

    this._listeners = new Set();
    this._stateListeners = new Set();
    this._timerId = null;
    this._active = false;
    this._terminalState = false;
    this.lastIteration = 0;
    this.maxIterations = null;
    this.currentState = 'running';
  }

  start() {
    if (this._active || !this.sessionId) return;
    this._active = true;
    this._terminalState = false;
    this._schedulePoll(0);
  }

  stop({ notifyBackend = false } = {}) {
    this._active = false;
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
    if (notifyBackend && this.sessionId && !this._terminalState) {
      this.sendAction('stop').catch(() => {});
    }
  }

  onUpdate(listener) {
    if (typeof listener === 'function') {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }
    return () => {};
  }

  onStateChange(listener) {
    if (typeof listener === 'function') {
      this._stateListeners.add(listener);
      return () => this._stateListeners.delete(listener);
    }
    return () => {};
  }

  async sendAction(action) {
    if (!this.sessionId || !action) return;
    try {
      const payload = await requestJson('/api/v1/charts/scatter/tsne/control', {
        method: 'POST',
        body: {
          project_id: this.projectId,
          sheet_id: this.sheetId,
          card_id: this.cardId,
          session_id: this.sessionId,
          action,
        },
      });
      this._applyState(payload);
    } catch (error) {
      console.warn('[Feature:cards] Failed to send t-SNE control command', error);
    }
  }

  _schedulePoll(delay) {
    if (!this._active) return;
    this._timerId = setTimeout(() => this._poll(), delay);
  }

  async _poll() {
    if (!this._active || !this.sessionId) return;
    try {
      const params = new URLSearchParams({
        project_id: this.projectId,
        sheet_id: this.sheetId,
        card_id: this.cardId,
        session_id: this.sessionId,
      });
      if (Number.isFinite(this.lastIteration)) {
        params.set('since_iteration', String(this.lastIteration));
      }
      const payload = await requestJson(`/api/v1/charts/scatter/tsne/state?${params.toString()}`);
      this._applyState(payload);
      if (Array.isArray(payload?.points) && payload.points.length) {
        this._notifyListeners(payload);
      }
      if (!this._active) return;
      const state = (this.currentState || '').toLowerCase();
      if (['completed', 'stopped', 'error'].includes(state)) {
        this._terminalState = true;
        this._active = false;
        return;
      }
      this._schedulePoll(this.pollInterval);
    } catch (error) {
      if (!this._active) return;
      console.warn('[Feature:cards] Failed to fetch t-SNE state', error);
      this._schedulePoll(this.pollInterval * 2);
    }
  }

  _applyState(payload) {
    if (!payload) return;
    if (typeof payload.iteration === 'number') {
      this.lastIteration = payload.iteration;
    }
    if (typeof payload.maxIterations === 'number') {
      this.maxIterations = payload.maxIterations;
    }
    if (typeof payload.state === 'string') {
      this.currentState = payload.state;
    }
    this._notifyState(payload);

    const state = typeof this.currentState === 'string' ? this.currentState.toLowerCase() : '';
    
    // Stop polling on terminal states
    if (['completed', 'stopped', 'error'].includes(state)) {
      this._terminalState = true;
      if (this._timerId) {
        clearTimeout(this._timerId);
        this._timerId = null;
      }
      this._active = false;
    }
    // Resume polling when running
    else if (state === 'running' && this._active && !this._timerId) {
      this._schedulePoll(this.pollInterval);
    }
  }

  _notifyListeners(payload) {
    this._listeners.forEach(listener => {
      try {
        listener(payload);
      } catch (error) {
        console.error('[Feature:cards] t-SNE listener failed', error);
      }
    });
  }

  _notifyState(payload) {
    this._stateListeners.forEach(listener => {
      try {
        listener(payload);
      } catch (error) {
        console.error('[Feature:cards] t-SNE state listener failed', error);
      }
    });
  }
}

export default TsneLiveController;
