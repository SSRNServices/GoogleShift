import { Navigate, Outlet } from "react-router-dom"
import { useAuth } from "../../context/AuthContext"

interface RoleGuardProps {
  allowedRoles: Array<'SUPER_ADMIN' | 'ADMIN' | 'USER'>
}

export function RoleGuard({ allowedRoles }: RoleGuardProps) {
  const { user } = useAuth()

  if (!user) {
    return <Navigate to="/" replace />
  }

  if (!allowedRoles.includes(user.role)) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-background">
        <h1 className="text-4xl font-extrabold tracking-tight text-foreground">403</h1>
        <p className="mt-4 text-lg text-muted-foreground">You do not have permission to access this area.</p>
      </div>
    )
  }

  return <Outlet />
}
