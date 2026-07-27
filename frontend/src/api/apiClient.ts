import { API_URL } from '../config/api';
import { useAuthStore } from '../store/useAuthStore';

type FetchOptions = RequestInit & {
  params?: Record<string, string>;
};

export const apiClient = async (endpoint: string, options: FetchOptions = {}) => {
  const { accessToken, refreshToken, setAuth, logout } = useAuthStore.getState();
  const headers = new Headers(options.headers || {});
  
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  // Handle query params
  let url = `${API_URL}${endpoint}`;
  if (options.params) {
    const params = new URLSearchParams(options.params);
    url += `?${params.toString()}`;
  }

  let response = await fetch(url, { ...options, headers });

  if (response.status === 401 && refreshToken) {
    // Attempt refresh
    try {
      const refreshRes = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });
      
      if (refreshRes.ok) {
        const data = await refreshRes.json();
        setAuth(data.user, data.accessToken, data.refreshToken);
        
        // Retry original request
        headers.set('Authorization', `Bearer ${data.accessToken}`);
        response = await fetch(url, { ...options, headers });
      } else {
        logout();
      }
    } catch {
      logout();
    }
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || errorData.message || 'API request failed');
  }

  return response.json();
};
