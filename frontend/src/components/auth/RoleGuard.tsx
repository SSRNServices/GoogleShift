import { Navigate, Outlet } from "react-router-dom"
import { useAuth } from "../../context/AuthContext"
import Forbidden from "../../pages/errors/403"

interface RoleGuardProps {
  allowedRoles: Array<'SUPER_ADMIN' | 'ADMIN' | 'USER'>
  children?: React.ReactNode
}

export function RoleGuard({ allowedRoles, children }: RoleGuardProps) {
  const { user } = useAuth()

  // This guard expects AuthGuard to handle authentication check first.
  // But just in case, redirect to login if no user.
  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (!allowedRoles.includes(user.role)) {
    // Return 403 page instead of redirecting to "/"
    return <Forbidden />
  }

  return children ? <>{children}</> : <Outlet />
}
