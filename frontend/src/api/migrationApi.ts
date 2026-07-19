export interface StartMigrationPayload {
  sourceSelection: any[];
  destinationFolder: any;
  options: any;
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
      } catch (e) {
        // Fallback
      }
      throw new Error(message);
    }

    return res.json();
  }
};
