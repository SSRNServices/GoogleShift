import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiClient } from '../api/apiClient';

interface MigrationSessionState {
  sessionId: string | null;
  sessionData: Record<string, unknown> | null;
  isLoading: boolean;
  error: string | null;
  
  createSession: (payload: {
    sourceEmail: string;
    destinationEmail: string;
    sourceFolderId: string;
    destinationFolderId: string;
  }) => Promise<void>;
  
  fetchSession: (sessionId: string) => Promise<void>;
  clearSession: () => void;
  discardSession: () => Promise<void>;
}

export const useMigrationSessionStore = create<MigrationSessionState>()(
  persist(
    (set, get) => ({
      sessionId: null,
      sessionData: null,
      isLoading: false,
      error: null,

      createSession: async (payload) => {
        set({ sessionId: null, sessionData: null, isLoading: true, error: null });
        try {
          console.log('[Frontend] Creating new MigrationSession with payload:', payload);
          const response = await apiClient('/api/migration/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          
          if (!response.success) throw new Error(response.error);
          
          console.log('[Frontend] MigrationSession created successfully. Session ID:', response.session.id);
          set({ 
            sessionId: response.session.id, 
            sessionData: response.session,
            isLoading: false 
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : 'Failed to create session';
          set({ error: errMsg, isLoading: false });
          throw err;
        }
      },

      fetchSession: async (sessionId: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await apiClient(`/api/migration/session/${sessionId}`);
          if (!response.success) throw new Error(response.error);
          
          set({ 
            sessionId: response.session.id, 
            sessionData: response.session,
            isLoading: false 
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : 'Failed to fetch session';
          set({ error: errMsg, isLoading: false });
          throw err;
        }
      },

      clearSession: () => {
        set({ sessionId: null, sessionData: null, error: null, isLoading: false });
        try {
          localStorage.removeItem('migration-session-storage');
          sessionStorage.removeItem('migration-session-storage');
        } catch (_) {}
      },

      discardSession: async () => {
        const currentId = get().sessionId;
        if (currentId) {
          await apiClient('/api/discovery/discard', {
            method: 'POST',
            body: JSON.stringify({ sessionId: currentId })
          }).catch(() => {});
        }

        set({ sessionId: null, sessionData: null, error: null, isLoading: false });
        try {
          localStorage.removeItem('migration-session-storage');
          sessionStorage.removeItem('migration-session-storage');
        } catch (_) {}
      }
    }),
    {
      name: 'migration-session-storage',
    }
  )
);
