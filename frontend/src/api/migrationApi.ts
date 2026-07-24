import type { DriveItem } from '../types/drive';
import type { TransferOptionsState } from '../types/transfer';

export interface StartMigrationPayload {
  sourceSelection: DriveItem[];
  destinationFolder: DriveItem;
  options: TransferOptionsState;
}

export const migrationApi = {
  async startMigration(payload: StartMigrationPayload) {
    const res = await fetch('http://localhost:3000/api/migrations/start', {
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

  async getCurrent() {
    const res = await fetch('http://localhost:3000/api/migrations/current', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch current migration state');
    return res.json();
  },

  async resume(jobId: string) {
    const res = await fetch(`http://localhost:3000/api/migrations/${jobId}/resume`, {
      method: 'POST',
      credentials: 'include'
    });
    if (!res.ok) throw new Error('Failed to resume migration');
    return res.json();
  },

  async discard(jobId: string) {
    const res = await fetch(`http://localhost:3000/api/migrations/${jobId}/cancel`, {
      method: 'POST',
      credentials: 'include'
    });
    if (!res.ok) throw new Error('Failed to discard migration');
    return res.json();
  }
};
