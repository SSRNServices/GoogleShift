import { API_URL } from '../config/api';
import { useAuthStore } from '../store/useAuthStore';

type FetchOptions = RequestInit & {
  params?: Record<string, string>;
};

export const apiClient = async (endpoint: string, options: FetchOptions = {}) => {
  options.credentials = options.credentials || 'include';
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

  if (response.status === 401 && !endpoint.includes('/auth/login') && !endpoint.includes('/auth/refresh')) {
    console.warn(`[apiClient 401] Received 401 Unauthorized for ${endpoint}. Attempting automatic token refresh...`);
    try {
      const refreshPayload = refreshToken ? JSON.stringify({ refreshToken }) : undefined;
      const refreshRes = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        ...(refreshPayload ? { body: refreshPayload } : {})
      });
      
      if (refreshRes.ok) {
        const data = await refreshRes.json();
        console.log('[apiClient 200] Token refresh succeeded. Retrying original request to:', endpoint);
        setAuth(data.user, data.accessToken, data.refreshToken);
        
        // Retry original request with refreshed access token
        if (data.accessToken) {
          headers.set('Authorization', `Bearer ${data.accessToken}`);
        }
        response = await fetch(url, { ...options, headers });
      } else {
        console.warn('[apiClient] Refresh endpoint rejected with status:', refreshRes.status);
        logout('Session expired. Please log in again.');
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[apiClient] Exception during token refresh attempt:', errMsg);
      logout('Network or auth exception during token refresh.');
    }
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || errorData.message || 'API request failed');
  }

  return response.json();
};
