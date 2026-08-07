import type { StartMigrationPayload } from '../types/transfer';
import { apiClient } from './apiClient';

export const migrationApi = {
  async startMigration(payload: StartMigrationPayload) {
    return apiClient('/api/migrations/start', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async startDiscovery(sourceId: string, sessionId: string) {
    return apiClient('/api/discovery/start', {
      method: 'POST',
      body: JSON.stringify({ itemsParam: `${sourceId}:folder`, sessionId })
    });
  },

  async retryDiscovery(sourceId: string, sessionId: string) {
    return apiClient('/api/discovery/retry', {
      method: 'POST',
      body: JSON.stringify({ itemsParam: `${sourceId}:folder`, sessionId })
    });
  },

  async getDiscoveryStatus(jobId: string) {
    return apiClient(`/api/discovery/${jobId}/status`);
  },

  async getCurrent() {
    return apiClient('/api/migrations/current');
  },

  async resume(jobId: string) {
    return apiClient(`/api/migrations/${jobId}/resume`, {
      method: 'POST'
    });
  },

  async validateSession(sessionId: string) {
    return apiClient(`/api/migrations/validate/${sessionId}`);
  },

  async getJobDetails(jobId: string) {
    return apiClient(`/api/migrations/${jobId}`);
  },

  async getJobLive(jobId: string) {
    return apiClient(`/api/migrations/${jobId}/live`);
  },

  async discard(jobId: string) {
    return apiClient(`/api/migrations/${jobId}/cancel`, {
      method: 'POST'
    });
  }
};

