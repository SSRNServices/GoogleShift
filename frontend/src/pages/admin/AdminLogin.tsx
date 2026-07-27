import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Lock, ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { API_URL } from '../../config/api';
import { useAuth } from '../../context/AuthContext';

export default function AdminLogin() {
  const { isAuthenticated, user } = useAuth();
  
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [formData, setFormData] = useState({
    email: '',
    password: ''
  });

  if (isAuthenticated && user) {
    if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' || user.role === 'SUPERVISOR') {
      return <Navigate to="/admin" replace />;
    } else {
      return <Navigate to="/dashboard" replace />;
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch(`${API_URL}/api/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
        credentials: 'include'
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Invalid credentials');
      }

      window.location.href = '/admin'; // Force reload to refresh auth state
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Login failed');
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 selection:bg-primary/20">
      <div className="w-full max-w-md bg-card border border-border rounded-2xl shadow-xl overflow-hidden p-8 flex flex-col">
        
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-16 h-16 bg-muted/50 rounded-2xl shadow-inner flex items-center justify-center mb-4">
            <Lock className="text-muted-foreground w-8 h-8" />
          </div>
          
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Admin Portal
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Sign in to access the management dashboard
          </p>
        </div>
        
        {error && (
          <div className="bg-destructive/15 text-destructive text-sm p-3 rounded-md mb-6 text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Email Address</label>
            <input 
              type="email" 
              required
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
              value={formData.email}
              onChange={e => setFormData({...formData, email: e.target.value})}
              autoComplete="email"
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="block text-sm font-medium text-foreground">Password</label>
              <a href="#" className="text-xs text-primary hover:underline" onClick={(e) => { e.preventDefault(); alert("Contact a SUPER_ADMIN to reset your password."); }}>Forgot password?</a>
            </div>
            <input 
              type="password" 
              required
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
              value={formData.password}
              onChange={e => setFormData({...formData, password: e.target.value})}
              autoComplete="current-password"
            />
          </div>

          <div className="flex items-center mt-2">
            <input type="checkbox" id="remember" className="rounded border-border text-primary focus:ring-primary" />
            <label htmlFor="remember" className="ml-2 text-sm text-muted-foreground">Remember me</label>
          </div>

          <Button type="submit" className="w-full mt-6" disabled={submitting}>
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Sign In
            {!submitting && <ArrowRight className="w-4 h-4 ml-2 opacity-70" />}
          </Button>
        </form>

      </div>
    </div>
  );
}
