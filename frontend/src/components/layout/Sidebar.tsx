import { Link, useLocation } from "react-router-dom"
import { cn } from "../../utils/cn"
import {
  Activity,
  BarChart3,
  FileBox,
  LayoutDashboard,
  Settings,
  Users
} from "lucide-react"

const sidebarNavItems = [
  {
    title: "Overview",
    href: "/admin",
    icon: LayoutDashboard,
  },
  {
    title: "Users",
    href: "/admin/users",
    icon: Users,
  },
  {
    title: "Migrations",
    href: "/admin/migrations",
    icon: FileBox,
  },
  {
    title: "System Health",
    href: "/admin/health",
    icon: Activity,
  },
  {
    title: "Logs",
    href: "/admin/logs",
    icon: BarChart3,
  },
  {
    title: "Settings",
    href: "/admin/settings",
    icon: Settings,
  },
]

export function Sidebar() {
  const location = useLocation()

  return (
    <nav
      className={cn(
        "flex w-64 flex-col border-r bg-card h-[calc(100vh-3.5rem)] px-3 py-4"
      )}
    >
      <div className="space-y-1">
        {sidebarNavItems.map((item) => {
          const isActive = location.pathname === item.href
          
          return (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                "group flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                isActive ? "bg-accent text-accent-foreground" : "transparent"
              )}
            >
              <item.icon className={cn("mr-2 h-4 w-4", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
              <span>{item.title}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
