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
  }
};
