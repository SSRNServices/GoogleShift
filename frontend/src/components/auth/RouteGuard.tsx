import { Navigate, Outlet, useLocation } from "react-router-dom"
import { useAuth } from "../../context/AuthContext"
import { Loader2 } from "lucide-react"

export function RouteGuard() {
  const { isAuthenticated, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!isAuthenticated) {
    // Save the attempted url for redirecting after login
    return <Navigate to="/" state={{ from: location }} replace />
  }

  return <Outlet />
}
