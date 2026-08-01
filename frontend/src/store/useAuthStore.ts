import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  isActive: boolean;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isInitialized: boolean;
  setAuth: (user: User, accessToken?: string | null, refreshToken?: string | null) => void;
  setInitialized: (initialized: boolean) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isInitialized: false,
      setAuth: (user, accessToken = null, refreshToken = null) => set((state) => ({
        user,
        accessToken: accessToken || state.accessToken,
        refreshToken: refreshToken || state.refreshToken,
        isInitialized: true
      })),
      setInitialized: (isInitialized) => set({ isInitialized }),
      logout: () => set({ user: null, accessToken: null, refreshToken: null, isInitialized: true }),
    }),
    {
      name: 'auth-storage', // unique name
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken
      }),
    }
  )
);
