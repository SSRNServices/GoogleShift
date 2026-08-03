import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiClient } from '../api/apiClient';

interface MigrationSessionState {
  sessionId: string | null;
  sessionData: any | null;
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
}

export const useMigrationSessionStore = create<MigrationSessionState>()(
  persist(
    (set) => ({
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
        } catch (err: any) {
          set({ error: err.message || 'Failed to create session', isLoading: false });
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
        } catch (err: any) {
          set({ error: err.message || 'Failed to fetch session', isLoading: false });
          throw err;
        }
      },

      clearSession: () => {
        set({ sessionId: null, sessionData: null, error: null });
      }
    }),
    {
      name: 'migration-session-storage',
    }
  )
);
