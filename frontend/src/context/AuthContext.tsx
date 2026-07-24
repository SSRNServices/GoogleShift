import React, { createContext, useContext } from 'react';
import { API_URL } from '../config/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';

interface User {
  id: string;
  email: string;
  name: string;
  picture: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'SUPERVISOR' | 'USER';
  status: 'ACTIVE' | 'PENDING' | 'DISABLED';
}

interface AuthContextType {
  isAuthenticated: boolean;
  user: User | null;
  loading: boolean;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const { data: user, isLoading } = useQuery<User | null>({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/auth/me`, { credentials: 'include' });
      if (!res.ok) {
        if (res.status === 401) return null;
        throw new Error('Failed to fetch user');
      }
      return res.json();
    },
    retry: false,
    refetchOnWindowFocus: false, // Don't refetch on focus to avoid flicker
    staleTime: 1000 * 60 * 5, // 5 minutes cache
  });

  const isAuthenticated = !!user;

  const login = () => {
    window.location.href = `${API_URL}/auth/login`;
  };

  const logout = async () => {
    try {
      await fetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
      queryClient.setQueryData(['auth', 'me'], null);
    } catch (e) {
      console.error('Logout failed', e);
    }
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, user: user || null, loading: isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
