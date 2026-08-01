import { useState } from 'react';
import { Cloud, Loader2 } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { apiClient } from '../api/apiClient';
import { API_URL } from '../config/api';

export default function Login() {
  const { user, accessToken, setAuth } = useAuthStore();
  const [formData, setFormData] = useState({ email: '', password: '', rememberMe: false });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (accessToken && user) {
    if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') {
      return <Navigate to="/admin" replace />;
    }
    return <Navigate to="/dashboard" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await apiClient('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: formData.email, password: formData.password })
      });
      setAuth(data.user, data.accessToken, data.refreshToken);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message || 'Login failed');
      } else {
        setError('Login failed');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = () => {
    window.location.href = `${API_URL}/auth/google`;
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex flex-col items-center justify-center p-4 selection:bg-indigo-500/30">
      <div className="w-full max-w-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-xl overflow-hidden p-10 flex flex-col items-center text-center">
        
        <div className="w-16 h-16 bg-indigo-600 rounded-2xl shadow-lg flex items-center justify-center mb-6">
          <Cloud className="text-white w-8 h-8" />
        </div>
        
        <h1 className="text-2xl font-extrabold tracking-tight mb-2">
          Welcome back
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">
          Sign in to your account
        </p>

        <form className="w-full text-left space-y-4" onSubmit={handleSubmit}>
          {error && (
            <div className="bg-red-50 dark:bg-red-900/30 p-3 rounded-md text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}
          
          <div>
            <label className="block text-sm font-medium mb-1">Email address</label>
            <input
              type="email"
              required
              className="w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-indigo-500 focus:border-indigo-500 bg-transparent"
              value={formData.email}
              onChange={e => setFormData({ ...formData, email: e.target.value })}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              required
              className="w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-indigo-500 focus:border-indigo-500 bg-transparent"
              value={formData.password}
              onChange={e => setFormData({ ...formData, password: e.target.value })}
            />
          </div>

          <div className="flex items-center justify-between mt-4">
            <div className="flex items-center">
              <input
                id="remember_me"
                type="checkbox"
                className="h-4 w-4 text-indigo-600 rounded border-gray-300"
                checked={formData.rememberMe}
                onChange={e => setFormData({ ...formData, rememberMe: e.target.checked })}
              />
              <label htmlFor="remember_me" className="ml-2 block text-sm">
                Remember me
              </label>
            </div>

            <div className="text-sm">
              <Link to="/forgot-password" className="font-medium text-indigo-600 hover:text-indigo-500">
                Forgot password?
              </Link>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 text-white hover:bg-indigo-700 font-semibold px-4 py-2 mt-6 rounded-md flex items-center justify-center transition-all disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Sign in'}
          </button>
        </form>

        <div className="mt-6 w-full">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300 dark:border-gray-700" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-white dark:bg-gray-800 text-gray-500">Or continue with</span>
            </div>
          </div>

          <button
            onClick={handleGoogleLogin}
            type="button"
            className="mt-6 w-full border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 font-semibold px-4 py-2 rounded-md flex items-center justify-center transition-all"
          >
            Google
          </button>
        </div>

        <p className="mt-8 text-sm text-gray-600 dark:text-gray-400">
          Don't have an account?{' '}
          <Link to="/signup" className="font-medium text-indigo-600 hover:text-indigo-500">
            Sign up
          </Link>
        </p>

      </div>
    </div>
  );
}
