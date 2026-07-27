import { useState, useEffect } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { Link } from 'react-router-dom';
import { Cloud, HardDrive, Play, History, Settings, ExternalLink, Loader2, AlertCircle } from 'lucide-react';
import { apiClient } from '../api/apiClient';
import { API_URL } from '../config/api';

interface UserProfile {
  state?: string;
  profile?: {
    picture?: string;
    email?: string;
    storage?: {
      used?: number;
      limit?: number;
    };
  };
}

export default function UserDashboard() {
  const { user } = useAuthStore();
  
  const [sourceProfile, setSourceProfile] = useState<UserProfile | null>(null);
  const [destProfile, setDestProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProfiles = async () => {
      try {
        const [srcRes, destRes] = await Promise.all([
          apiClient('/auth/source/profile').catch(() => ({ state: 'NOT_CONNECTED' })),
          apiClient('/auth/destination/profile').catch(() => ({ state: 'NOT_CONNECTED' }))
        ]);
        setSourceProfile(srcRes as UserProfile);
        setDestProfile(destRes as UserProfile);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchProfiles();
  }, []);

  const handleConnect = (type: 'source' | 'destination') => {
    // We just redirect to the oauth URL handled by backend
    // Since our fetch uses JWT, we need to pass token to oauth redirect if it requires it, 
    // but the oauth redirect expects a session cookie if not customized. 
    // Wait, the backend requires token in header for `/auth/:type`.
    // We can pass token via query parameter or cookie for the oauth redirect to work.
    // For now, let's assume `http://localhost:3000/auth/source?token=...` or standard redirect.
    // Given backend `requireUserAuth`, it looks at `req.headers.authorization`. Browser redirects don't send auth headers.
    // For a real production app, setting a short-lived cookie before redirect is best.
    // Let's redirect and pass token as query for the backend to handle if it supported it, but our backend doesn't.
    // So we'll have to rely on frontend setting a cookie or modifying backend auth.middleware.
    // We can set a cookie via javascript that the backend can read if we update auth.middleware to read from cookies too.
    document.cookie = `access_token=${useAuthStore.getState().accessToken}; path=/`;
    window.location.href = `${API_URL}/auth/${type}`;
  };

  const handleDisconnect = async (type: 'source' | 'destination') => {
    try {
      await apiClient(`/auth/${type}/logout`, { method: 'POST' });
      if (type === 'source') setSourceProfile({ state: 'NOT_CONNECTED' });
      else setDestProfile({ state: 'NOT_CONNECTED' });
    } catch (e) {
      console.error(e);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  const isSourceConnected = sourceProfile?.state === 'CONNECTED';
  const isDestConnected = destProfile?.state === 'CONNECTED';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          Welcome back, {user?.name?.split(' ')[0] || 'User'}!
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Here's what's happening with your migrations today.
        </p>
      </div>

      {/* Cloud Accounts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Source Account */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex justify-between items-start mb-4">
            <div className="flex items-center space-x-3">
              <div className="bg-blue-100 dark:bg-blue-900/30 p-3 rounded-lg">
                <Cloud className="w-6 h-6 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Source Account</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">Google Drive</p>
              </div>
            </div>
            {isSourceConnected ? (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                Connected
              </span>
            ) : (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">
                Not Connected
              </span>
            )}
          </div>

          {isSourceConnected ? (
            <div className="space-y-4">
              <div className="flex items-center space-x-3">
                <img src={sourceProfile.profile?.picture} alt="" className="w-10 h-10 rounded-full" />
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{sourceProfile.profile?.email}</p>
                  <p className="text-xs text-gray-500">
                    Storage: {formatBytes(sourceProfile.profile?.storage?.used || 0)} / {formatBytes(sourceProfile.profile?.storage?.limit || 0)}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => handleDisconnect('source')}
                className="w-full text-sm text-red-600 hover:text-red-700 dark:text-red-400 font-medium py-2 px-4 border border-red-200 dark:border-red-900/50 rounded-lg transition-colors hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                Disconnect Account
              </button>
            </div>
          ) : (
            <div className="mt-6">
              <button 
                onClick={() => handleConnect('source')}
                className="w-full text-sm text-white bg-indigo-600 hover:bg-indigo-700 font-medium py-2 px-4 rounded-lg transition-colors flex justify-center items-center"
              >
                Connect Source
                <ExternalLink className="w-4 h-4 ml-2" />
              </button>
            </div>
          )}
        </div>

        {/* Destination Account */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex justify-between items-start mb-4">
            <div className="flex items-center space-x-3">
              <div className="bg-purple-100 dark:bg-purple-900/30 p-3 rounded-lg">
                <HardDrive className="w-6 h-6 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Destination Account</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">Google Drive</p>
              </div>
            </div>
            {isDestConnected ? (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                Connected
              </span>
            ) : (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">
                Not Connected
              </span>
            )}
          </div>

          {isDestConnected ? (
            <div className="space-y-4">
              <div className="flex items-center space-x-3">
                <img src={destProfile.profile?.picture} alt="" className="w-10 h-10 rounded-full" />
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{destProfile.profile?.email}</p>
                  <p className="text-xs text-gray-500">
                    Storage: {formatBytes(destProfile.profile?.storage?.used || 0)} / {formatBytes(destProfile.profile?.storage?.limit || 0)}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => handleDisconnect('destination')}
                className="w-full text-sm text-red-600 hover:text-red-700 dark:text-red-400 font-medium py-2 px-4 border border-red-200 dark:border-red-900/50 rounded-lg transition-colors hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                Disconnect Account
              </button>
            </div>
          ) : (
            <div className="mt-6">
              <button 
                onClick={() => handleConnect('destination')}
                className="w-full text-sm text-white bg-indigo-600 hover:bg-indigo-700 font-medium py-2 px-4 rounded-lg transition-colors flex justify-center items-center"
              >
                Connect Destination
                <ExternalLink className="w-4 h-4 ml-2" />
              </button>
            </div>
          )}
        </div>

      </div>

      {/* Current Migration Status */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Migration Status</h3>
        <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-800">
          <div className="flex items-center space-x-4">
            <div className="p-2 bg-white dark:bg-gray-800 rounded-full shadow-sm border border-gray-200 dark:border-gray-700">
              <AlertCircle className="w-5 h-5 text-gray-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">No active migration</p>
              <p className="text-xs text-gray-500">Ready to start a new transfer</p>
            </div>
          </div>
          <Link to="/migration" className="text-sm text-indigo-600 hover:text-indigo-500 font-medium flex items-center">
            Go to Migration
            <ArrowRight className="w-4 h-4 ml-1" />
          </Link>
        </div>
      </div>

      {/* Quick Actions */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Quick Actions</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Link to="/migration" className="flex flex-col items-center justify-center p-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 hover:border-indigo-500 hover:shadow-md transition-all group">
            <Play className="w-8 h-8 text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 mb-3" />
            <span className="text-sm font-medium text-gray-900 dark:text-white">Start Migration</span>
          </Link>
          <Link to="/history" className="flex flex-col items-center justify-center p-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 hover:border-indigo-500 hover:shadow-md transition-all group">
            <History className="w-8 h-8 text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 mb-3" />
            <span className="text-sm font-medium text-gray-900 dark:text-white">View History</span>
          </Link>
          <Link to="/settings" className="flex flex-col items-center justify-center p-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 hover:border-indigo-500 hover:shadow-md transition-all group">
            <Settings className="w-8 h-8 text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 mb-3" />
            <span className="text-sm font-medium text-gray-900 dark:text-white">Settings</span>
          </Link>
        </div>
      </div>

    </div>
  );
}

function ArrowRight(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
    </svg>
  );
}
