import { Link } from "react-router-dom"
import { Button } from "../../components/ui/Button"
import { ShieldAlert } from "lucide-react"

export default function Forbidden() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background text-center px-4">
      <ShieldAlert className="h-24 w-24 text-destructive mb-8 opacity-90" strokeWidth={1.5} />
      <h1 className="text-4xl font-extrabold tracking-tight mb-2">Access Denied</h1>
      <p className="text-muted-foreground text-lg mb-8 max-w-md">
        You do not have permission to view this page. If you believe this is a mistake, please contact your administrator.
      </p>
      <div className="flex gap-4">
        <Button asChild variant="default">
          <Link to="/dashboard">Return to Dashboard</Link>
        </Button>
      </div>
    </div>
  )
}
