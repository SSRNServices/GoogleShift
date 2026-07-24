import { Link } from "react-router-dom"
import { Cloud, LogOut, Settings, ShieldCheck, User as UserIcon } from "lucide-react"
import { useAuth } from "../../context/AuthContext"
import { Button } from "../ui/Button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/DropdownMenu"
import { Avatar, AvatarFallback, AvatarImage } from "../ui/Avatar"
import { Badge } from "../ui/Badge"

export function Header() {
  const { user, logout } = useAuth()
  
  if (!user) return null

  const initials = user.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .substring(0, 2)
    .toUpperCase()

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center justify-between">
        <div className="flex items-center gap-6 md:gap-10">
          <Link to="/dashboard" className="flex items-center space-x-2">
            <Cloud className="h-6 w-6 text-primary" />
            <span className="inline-block font-bold">CloudShift</span>
          </Link>
          
          <nav className="hidden md:flex gap-6">
            <Link
              to="/dashboard"
              className="text-sm font-medium transition-colors hover:text-foreground/80 text-foreground"
            >
              Dashboard
            </Link>
            {user.role === 'SUPER_ADMIN' && (
              <Link
                to="/admin"
                className="text-sm font-medium transition-colors hover:text-foreground/80 text-muted-foreground"
              >
                Admin
              </Link>
            )}
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative h-10 w-10 rounded-full">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={user.picture || ''} alt={user.name} />
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56" align="end" forceMount>
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none">{user.name}</p>
                  <p className="text-xs leading-none text-muted-foreground">
                    {user.email}
                  </p>
                  <div className="pt-2">
                     <Badge variant={user.role === 'SUPER_ADMIN' ? 'default' : 'secondary'} className="text-[10px]">
                        {user.role}
                     </Badge>
                  </div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem>
                  <UserIcon className="mr-2 h-4 w-4" />
                  <span>Profile</span>
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Settings className="mr-2 h-4 w-4" />
                  <span>Settings</span>
                </DropdownMenuItem>
                {user.role === 'SUPER_ADMIN' && (
                  <DropdownMenuItem>
                    <Link to="/admin" className="flex items-center w-full">
                      <ShieldCheck className="mr-2 h-4 w-4" />
                      <span>Admin Panel</span>
                    </Link>
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout} className="text-destructive focus:bg-destructive focus:text-destructive-foreground cursor-pointer">
                <LogOut className="mr-2 h-4 w-4" />
                <span>Log out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}
