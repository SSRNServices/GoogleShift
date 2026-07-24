import { Link } from "react-router-dom"
import { Button } from "../../components/ui/Button"
import { SearchX } from "lucide-react"

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background text-center px-4">
      <SearchX className="h-24 w-24 text-muted-foreground mb-8 opacity-80" strokeWidth={1.5} />
      <h1 className="text-4xl font-extrabold tracking-tight mb-2">Page Not Found</h1>
      <p className="text-muted-foreground text-lg mb-8 max-w-md">
        The page you are looking for doesn't exist or has been moved.
      </p>
      <div className="flex gap-4">
        <Button asChild variant="default">
          <Link to="/dashboard">Return to Dashboard</Link>
        </Button>
      </div>
    </div>
  )
}
