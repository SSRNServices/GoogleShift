import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ForgotPassword from './pages/ForgotPassword';
import UserDashboard from './pages/UserDashboard';
import AdminDashboard from './pages/admin/Dashboard';
import AdminUsers from './pages/admin/Users';
import { AuthGuard } from './components/auth/AuthGuard';
import { RoleGuard } from './components/auth/RoleGuard';
import { MainLayout } from './components/layout/MainLayout';
import { AdminLayout } from './components/layout/AdminLayout';
import NotFound from './pages/errors/404';
import Forbidden from './pages/errors/403';
import Migration from './pages/Migration';
import MigrationProgress from './pages/MigrationProgress';
import PhotosMigrationProgress from './pages/PhotosMigrationProgress';
import History from './pages/History';
import Settings from './pages/Settings';

// Optional: Initialization component to load 'me' on mount if token exists
import { useEffect } from 'react';
import { useAuthStore } from './store/useAuthStore';
import { apiClient } from './api/apiClient';

function AuthInit({ children }: { children: React.ReactNode }) {
  const { setAuth, logout, setInitialized } = useAuthStore();
  
  useEffect(() => {
    console.log('[AuthInit] Initializing session check...');
    apiClient('/auth/me')
      .then(async data => {
        if (data.authenticated && data.user) {
          console.log('[AuthInit] User session active for:', data.user.email);
          setAuth(data.user);

          // Check if user has an active migration running on backend
          try {
            const activeRes = await apiClient('/api/migrations/current');
            if (activeRes && activeRes.jobId && activeRes.status !== 'idle') {
              console.log(`[AuthInit] Active migration discovered: JobId ${activeRes.jobId} (Status: ${activeRes.status})`);
            }
          } catch (_) {}
        }
      })
      .catch(err => {
        console.warn('[AuthInit] Session check warning:', err.message);
      })
      .finally(() => {
        setInitialized(true);
      });

    // Proactive background token refresh every 45 minutes (2,700,000 ms)
    // Ensures 1-hour access tokens are renewed long before expiration
    const refreshInterval = setInterval(() => {
      const { user, accessToken } = useAuthStore.getState();
      if (user || accessToken) {
        console.log('[AuthInit] Proactive background token refresh executing...');
        apiClient('/auth/me').catch(err => {
          console.warn('[AuthInit] Proactive refresh warning:', err.message);
        });
      }
    }, 45 * 60 * 1000);

    return () => clearInterval(refreshInterval);
  }, [setAuth, logout, setInitialized]);

  return <>{children}</>;
}

export default function App() {
  return (
    <AuthInit>
      <Routes>
        {/* Public Routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/" element={<Navigate to="/login" replace />} />

        {/* Protected Routes wrapper */}
        <Route element={<AuthGuard />}>
          
          {/* User Routes */}
          <Route element={<MainLayout />}>
            <Route path="/dashboard" element={<UserDashboard />} />
            <Route path="/migration" element={<Migration />} />
            <Route path="/migration/progress" element={<MigrationProgress />} />
            <Route path="/migration/progress/:jobId" element={<MigrationProgress />} />
            <Route path="/migration/:jobId" element={<MigrationProgress />} />
            <Route path="/photos/progress" element={<PhotosMigrationProgress />} />
            <Route path="/photos/progress/:jobId" element={<PhotosMigrationProgress />} />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
          </Route>

          {/* Admin Routes */}
          <Route path="/admin" element={
            <RoleGuard allowedRoles={['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR']}>
              <AdminLayout />
            </RoleGuard>
          }>
            <Route index element={<AdminDashboard />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="migrations" element={<AdminDashboard />} /> {/* placeholder */}
            <Route path="health" element={<AdminDashboard />} /> {/* placeholder */}
            <Route path="logs" element={<AdminDashboard />} /> {/* placeholder */}
            <Route path="settings" element={<AdminDashboard />} /> {/* placeholder */}
          </Route>
        </Route>

        {/* Error Routes */}
        <Route path="/403" element={<Forbidden />} />
        <Route path="/404" element={<NotFound />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthInit>
  );
}
