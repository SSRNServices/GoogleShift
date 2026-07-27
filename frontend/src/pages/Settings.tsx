import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { User, Lock, Bell, Shield, LogOut, Key } from 'lucide-react';

export default function Settings() {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('profile');

  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Settings</h1>
          <p className="text-muted-foreground mt-1">Manage your account preferences</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-8">
        
        {/* Sidebar Nav */}
        <div className="w-full md:w-64 flex-shrink-0">
          <nav className="space-y-1">
            <button
              onClick={() => setActiveTab('profile')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${activeTab === 'profile' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
            >
              <User className="w-5 h-5" /> Profile
            </button>
            <button
              onClick={() => setActiveTab('security')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${activeTab === 'security' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
            >
              <Shield className="w-5 h-5" /> Security
            </button>
            <button
              onClick={() => setActiveTab('notifications')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${activeTab === 'notifications' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
            >
              <Bell className="w-5 h-5" /> Notifications
            </button>
            <button
              onClick={() => setActiveTab('sessions')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${activeTab === 'sessions' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
            >
              <Key className="w-5 h-5" /> Active Sessions
            </button>
          </nav>

          <div className="mt-8 pt-8 border-t border-border">
            <button
              onClick={logout}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
            >
              <LogOut className="w-5 h-5" /> Sign Out All Devices
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 bg-card border border-border rounded-xl shadow-sm overflow-hidden p-8">
          
          {activeTab === 'profile' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-foreground">Profile Information</h3>
                <p className="text-sm text-muted-foreground">Update your account's profile information and email address.</p>
              </div>

              <div className="flex items-center gap-6 pb-6 border-b border-border">
                <img src={user?.picture || 'https://ui-avatars.com/api/?name=' + user?.name} alt="Avatar" className="w-20 h-20 rounded-full bg-secondary" />
                <button className="px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-muted/50 transition-colors">
                  Change Avatar
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">Full Name</label>
                  <input type="text" defaultValue={user?.name} disabled className="w-full px-4 py-2 bg-muted/30 border border-border rounded-lg text-foreground cursor-not-allowed" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">Email Address</label>
                  <input type="email" defaultValue={user?.email} disabled className="w-full px-4 py-2 bg-muted/30 border border-border rounded-lg text-foreground cursor-not-allowed" />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'security' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-foreground">Update Password</h3>
                <p className="text-sm text-muted-foreground">Ensure your account is using a long, random password to stay secure.</p>
              </div>

              <div className="max-w-md space-y-4">
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">Current Password</label>
                  <input type="password" placeholder="••••••••" className="w-full px-4 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">New Password</label>
                  <input type="password" placeholder="••••••••" className="w-full px-4 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">Confirm Password</label>
                  <input type="password" placeholder="••••••••" className="w-full px-4 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
                <button className="px-6 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors">
                  Save Password
                </button>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-foreground">Email Notifications</h3>
                <p className="text-sm text-muted-foreground">Choose what updates you want to receive.</p>
              </div>

              <div className="space-y-4">
                <label className="flex items-start gap-3">
                  <input type="checkbox" defaultChecked className="mt-1 w-4 h-4 text-primary rounded border-border" />
                  <div>
                    <div className="font-medium text-sm text-foreground">Migration Complete</div>
                    <div className="text-xs text-muted-foreground">Receive an email when a background migration finishes.</div>
                  </div>
                </label>
                <label className="flex items-start gap-3">
                  <input type="checkbox" defaultChecked className="mt-1 w-4 h-4 text-primary rounded border-border" />
                  <div>
                    <div className="font-medium text-sm text-foreground">Migration Failed</div>
                    <div className="text-xs text-muted-foreground">Receive an email if a migration encounters a fatal error.</div>
                  </div>
                </label>
              </div>
            </div>
          )}

          {activeTab === 'sessions' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-foreground">Active Sessions</h3>
                <p className="text-sm text-muted-foreground">Manage devices currently logged into your account.</p>
              </div>

              <div className="p-4 rounded-lg border border-border bg-muted/20 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                    <Lock className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-medium text-sm text-foreground">Mac OS (Chrome)</div>
                    <div className="text-xs text-muted-foreground">Mumbai, India • Current Session</div>
                  </div>
                </div>
                <span className="text-xs font-medium text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded-full">Active Now</span>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
