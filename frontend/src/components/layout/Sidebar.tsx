import { Link, useLocation } from "react-router-dom";
import { useState } from "react";
import { cn } from "../../utils/cn";
import { useAuthStore } from "../../store/useAuthStore";
import {
  Activity,
  BarChart3,
  FileBox,
  LayoutDashboard,
  Settings,
  Users,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  History
} from "lucide-react";

export function Sidebar() {
  const location = useLocation();
  const { user } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);

  if (!user) return null;

  const isAdminRoute = location.pathname.startsWith('/admin');
  const isAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' || user.role === 'SUPERVISOR';

  let navItems = [
    { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { title: "Migration", href: "/migration", icon: FileBox },
    { title: "History", href: "/history", icon: History },
    { title: "Settings", href: "/settings", icon: Settings },
  ];

  if (isAdminRoute && isAdmin) {
    navItems = [
      { title: "Admin Overview", href: "/admin", icon: LayoutDashboard },
      { title: "Users", href: "/admin/users", icon: Users },
      { title: "System Health", href: "/admin/health", icon: Activity },
      { title: "Logs", href: "/admin/logs", icon: BarChart3 },
      { title: "Back to App", href: "/dashboard", icon: ChevronLeft },
    ];
  } else if (isAdmin) {
    navItems.push({ title: "Admin Panel", href: "/admin", icon: ShieldCheck });
  }

  return (
    <nav
      className={cn(
        "flex flex-col border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 transition-all duration-300 relative",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <div className="absolute -right-3 top-6">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full p-1 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      <div className="flex-1 space-y-1 p-3 mt-4">
        {navItems.map((item) => {
          // Exact match for dashboard/admin, prefix match for others if needed, but exact is safer
          const isActive = location.pathname === item.href || (item.href !== '/dashboard' && item.href !== '/admin' && location.pathname.startsWith(item.href));
          
          return (
            <Link
              key={item.title}
              to={item.href}
              className={cn(
                "group flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-indigo-50 hover:text-indigo-700 dark:hover:bg-indigo-500/10 dark:hover:text-indigo-400",
                isActive ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400" : "text-gray-600 dark:text-gray-400",
                collapsed ? "justify-center px-0" : ""
              )}
              title={collapsed ? item.title : undefined}
            >
              <item.icon className={cn("h-5 w-5 flex-shrink-0", isActive ? "text-indigo-600 dark:text-indigo-400" : "text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400", collapsed ? "" : "mr-3")} />
              {!collapsed && <span>{item.title}</span>}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
