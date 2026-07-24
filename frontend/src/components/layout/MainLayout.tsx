import { Outlet } from "react-router-dom"
import { Header } from "./Header"

export function MainLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="flex-1 bg-muted/20">
        <Outlet />
      </main>
    </div>
  )
}
