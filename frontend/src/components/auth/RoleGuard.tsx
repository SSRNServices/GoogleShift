import { Navigate, Outlet } from "react-router-dom";
import { useAuthStore } from "../../store/useAuthStore";
import Forbidden from "../../pages/errors/403";

interface RoleGuardProps {
  allowedRoles: Array<'SUPER_ADMIN' | 'ADMIN' | 'SUPERVISOR' | 'USER'>;
  children?: React.ReactNode;
}

export function RoleGuard({ allowedRoles, children }: RoleGuardProps) {
  const { user } = useAuthStore();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!allowedRoles.includes(user.role as any)) {
    return <Forbidden />;
  }

  return children ? <>{children}</> : <Outlet />;
}
