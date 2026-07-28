import type { StartMigrationPayload } from '../types/transfer';
import { API_URL } from '../config/api';

export const migrationApi = {
  async startMigration(payload: StartMigrationPayload) {
    const res = await fetch(`${API_URL}/api/migrations/start`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      let message = 'Migration failed to start';
      try {
        const errorData = await res.json();
        message = errorData.error || message;
      } catch {
        // Fallback
      }
      throw new Error(message);
    }

    return res.json();
  },

  async startDiscovery(sourceId: string, sessionId: string) {
    const res = await fetch(`${API_URL}/api/discovery/start`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemsParam: `${sourceId}:folder`, sessionId })
    });
    if (!res.ok) {
      let message = 'Failed to start discovery';
      try {
        const data = await res.json();
        message = data.error || message;
      } catch (e) {}
      throw new Error(message);
    }
    return res.json();
  },

  async getCurrent() {
    const res = await fetch(`${API_URL}/api/migrations/current`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch current migration state');
    return res.json();
  },

  async resume(jobId: string) {
    const res = await fetch(`${API_URL}/api/migrations/${jobId}/resume`, {
      method: 'POST',
      credentials: 'include'
    });
    if (!res.ok) throw new Error('Failed to resume migration');
    return res.json();
  },

  async discard(jobId: string) {
    const res = await fetch(`${API_URL}/api/migrations/${jobId}/cancel`, {
      method: 'POST',
      credentials: 'include'
    });
    if (!res.ok) throw new Error('Failed to discard migration');
    return res.json();
  }
};
