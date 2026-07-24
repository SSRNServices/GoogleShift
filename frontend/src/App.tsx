import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import UserDashboard from './pages/admin/Dashboard'; // we'll use a single dashboard for now, or you can point to UserDashboard if they differ
import AdminDashboard from './pages/admin/Dashboard';
import { AuthGuard } from './components/auth/AuthGuard';
import { RoleGuard } from './components/auth/RoleGuard';
import { MainLayout } from './components/layout/MainLayout';
import { AdminLayout } from './components/layout/AdminLayout';
import NotFound from './pages/errors/404';
import Forbidden from './pages/errors/403';

export default function App() {
  return (
    <Routes>
      {/* Public Route */}
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Navigate to="/login" replace />} />

      {/* Protected Routes wrapper */}
      <Route element={<AuthGuard />}>
        
        {/* User Routes */}
        <Route element={<MainLayout />}>
          <Route path="/dashboard" element={<UserDashboard />} />
        </Route>

        {/* Admin Routes */}
        <Route path="/admin" element={
          <RoleGuard allowedRoles={['SUPER_ADMIN']}>
            <AdminLayout />
          </RoleGuard>
        }>
          <Route index element={<AdminDashboard />} />
          <Route path="users" element={<AdminDashboard />} /> {/* placeholder */}
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
  );
}
