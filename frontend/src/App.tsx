import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import UserDashboard from './pages/Dashboard';
import AdminDashboard from './pages/admin/Dashboard';
import { RouteGuard } from './components/auth/RouteGuard';
import { RoleGuard } from './components/auth/RoleGuard';
import { MainLayout } from './components/layout/MainLayout';
import { AdminLayout } from './components/layout/AdminLayout';

export default function App() {
  return (
    <Routes>
      {/* Public Route */}
      <Route path="/" element={<Login />} />

      {/* Protected User Routes */}
      <Route element={<RouteGuard />}>
        <Route element={<MainLayout />}>
          <Route path="/dashboard" element={<UserDashboard />} />
          {/* Settings and Profile can go here */}
        </Route>

        {/* Protected Admin Routes */}
        <Route element={<RoleGuard allowedRoles={['SUPER_ADMIN']} />}>
          <Route element={<AdminLayout />}>
            <Route path="/admin" element={<AdminDashboard />} />
            {/* Additional admin routes go here (Users, Migrations, etc) */}
          </Route>
        </Route>
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
