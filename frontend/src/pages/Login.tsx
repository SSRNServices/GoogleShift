import { ArrowRight, Cloud } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Navigate } from 'react-router-dom';

export default function Login() {
  const { isAuthenticated, loading, login } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4 selection:bg-primary/20">
      <div className="w-full max-w-md bg-card border border-border rounded-2xl shadow-xl overflow-hidden p-10 flex flex-col items-center text-center">
        
        <div className="w-20 h-20 bg-primary rounded-3xl rotate-3 shadow-lg flex items-center justify-center mb-8 transition-transform hover:rotate-6">
          <Cloud className="text-primary-foreground w-10 h-10 -rotate-3" />
        </div>
        
        <h1 className="text-3xl font-extrabold tracking-tight mb-4 text-foreground">
          CloudShift
        </h1>
        
        <p className="text-base text-muted-foreground mb-10">
          Move Google Drive data securely between accounts.
        </p>
        
        <button
          onClick={login}
          className="w-full bg-foreground text-background hover:bg-foreground/90 font-semibold px-6 py-4 rounded-xl flex items-center justify-center gap-3 shadow-sm transition-all active:scale-95"
        >
          <svg viewBox="0 0 24 24" className="w-6 h-6 bg-background text-foreground rounded-full p-1" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" />
            <path d="M15 12H9" />
            <path d="M12 9L12 15" />
          </svg>
          Continue with Google
          <ArrowRight className="w-5 h-5 ml-2 opacity-70" />
        </button>

      </div>
    </div>
  );
}
