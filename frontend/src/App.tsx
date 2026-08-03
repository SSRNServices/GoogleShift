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
import History from './pages/History';
import Settings from './pages/Settings';

// Optional: Initialization component to load 'me' on mount if token exists
import { useEffect } from 'react';
import { useAuthStore } from './store/useAuthStore';
import { apiClient } from './api/apiClient';

function AuthInit({ children }: { children: React.ReactNode }) {
  const { setAuth, logout, setInitialized } = useAuthStore();
  
  useEffect(() => {
    apiClient('/auth/me')
      .then(data => {
        if (data.authenticated && data.user) {
          setAuth(data.user);
        } else {
          logout();
        }
      })
      .catch(() => {
        logout();
      })
      .finally(() => {
        setInitialized(true);
      });
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
