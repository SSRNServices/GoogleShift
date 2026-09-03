import { useState, useEffect } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { Link } from 'react-router-dom';
import { Cloud, Play, History, Settings, ExternalLink, Loader2, Image } from 'lucide-react';
import { apiClient } from '../api/apiClient';
import { API_URL } from '../config/api';

interface UserProfile {
  state?: string;
  profile?: {
    picture?: string;
    email?: string;
    name?: string;
    storage?: {
      used?: number;
      limit?: number;
    };
  };
}

export default function UserDashboard() {
  const { user } = useAuthStore();
  
  const [driveSourceProfile, setDriveSourceProfile] = useState<UserProfile | null>(null);
  const [driveDestProfile, setDriveDestProfile] = useState<UserProfile | null>(null);
  const [photosSourceProfile, setPhotosSourceProfile] = useState<UserProfile | null>(null);
  const [photosDestProfile, setPhotosDestProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProfiles = async () => {
      try {
        const [driveSrc, driveDest, photosSrc, photosDest] = await Promise.all([
          apiClient('/auth/source/profile').catch(() => ({ state: 'NOT_CONNECTED' })),
          apiClient('/auth/destination/profile').catch(() => ({ state: 'NOT_CONNECTED' })),
          apiClient('/auth/photos/source/profile').catch(() => ({ state: 'NOT_CONNECTED' })),
          apiClient('/auth/photos/destination/profile').catch(() => ({ state: 'NOT_CONNECTED' }))
        ]);
        setDriveSourceProfile(driveSrc as UserProfile);
        setDriveDestProfile(driveDest as UserProfile);
        setPhotosSourceProfile(photosSrc as UserProfile);
        setPhotosDestProfile(photosDest as UserProfile);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchProfiles();
  }, []);

  const handleConnect = (endpoint: string) => {
    document.cookie = `access_token=${useAuthStore.getState().accessToken}; path=/`;
    window.location.href = `${API_URL}/auth/${endpoint}`;
  };

  const handleDisconnect = async (endpoint: string, setter: (val: UserProfile) => void) => {
    try {
      await apiClient(`/auth/${endpoint}/logout`, { method: 'POST' });
      setter({ state: 'NOT_CONNECTED' });
    } catch (e) {
      console.error(e);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  const isDriveSourceConnected = driveSourceProfile?.state === 'CONNECTED';
  const isDriveDestConnected = driveDestProfile?.state === 'CONNECTED';
  const isPhotosSourceConnected = photosSourceProfile?.state === 'CONNECTED';
  const isPhotosDestConnected = photosDestProfile?.state === 'CONNECTED';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          Welcome back, {user?.name?.split(' ')[0] || 'User'}!
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Manage your Google Drive and Google Photos migration connections.
        </p>
      </div>

      {/* Google Drive Accounts */}
      <div className="space-y-4">
        <h2 className="text-lg font-bold text-gray-900 dark:text-white flex items-center">
          <Cloud className="w-5 h-5 text-blue-500 mr-2" /> Google Drive Accounts
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Source Drive */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">Source Drive Account</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">Read access to Drive files</p>
              </div>
              {isDriveSourceConnected ? (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">Connected</span>
              ) : (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">Not Connected</span>
              )}
            </div>
            {isDriveSourceConnected ? (
              <div className="space-y-4">
                <p className="text-sm font-medium text-gray-900 dark:text-white">{driveSourceProfile.profile?.email}</p>
                <button onClick={() => handleDisconnect('source', setDriveSourceProfile)} className="w-full text-xs text-red-600 font-medium py-2 border border-red-200 rounded-lg hover:bg-red-50">Disconnect</button>
              </div>
            ) : (
              <button onClick={() => handleConnect('source')} className="w-full text-xs text-white bg-indigo-600 font-medium py-2 rounded-lg hover:bg-indigo-700 flex justify-center items-center">
                Connect Source Drive <ExternalLink className="w-3.5 h-3.5 ml-1" />
              </button>
            )}
          </div>

          {/* Destination Drive */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">Destination Drive Account</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">Write access to target Drive</p>
              </div>
              {isDriveDestConnected ? (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">Connected</span>
              ) : (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">Not Connected</span>
              )}
            </div>
            {isDriveDestConnected ? (
              <div className="space-y-4">
                <p className="text-sm font-medium text-gray-900 dark:text-white">{driveDestProfile.profile?.email}</p>
                <button onClick={() => handleDisconnect('destination', setDriveDestProfile)} className="w-full text-xs text-red-600 font-medium py-2 border border-red-200 rounded-lg hover:bg-red-50">Disconnect</button>
              </div>
            ) : (
              <button onClick={() => handleConnect('destination')} className="w-full text-xs text-white bg-indigo-600 font-medium py-2 rounded-lg hover:bg-indigo-700 flex justify-center items-center">
                Connect Destination Drive <ExternalLink className="w-3.5 h-3.5 ml-1" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Google Photos Accounts */}
      <div className="space-y-4">
        <h2 className="text-lg font-bold text-gray-900 dark:text-white flex items-center">
          <Image className="w-5 h-5 text-purple-500 mr-2" /> Google Photos Accounts
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Source Photos */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">Source Photos Account</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">Read access to Photos library & albums</p>
              </div>
              {isPhotosSourceConnected ? (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">Connected</span>
              ) : (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">Not Connected</span>
              )}
            </div>
            {isPhotosSourceConnected ? (
              <div className="space-y-4">
                <p className="text-sm font-medium text-gray-900 dark:text-white">{photosSourceProfile.profile?.email}</p>
                <button onClick={() => handleDisconnect('photos/source', setPhotosSourceProfile)} className="w-full text-xs text-red-600 font-medium py-2 border border-red-200 rounded-lg hover:bg-red-50">Disconnect</button>
              </div>
            ) : (
              <button onClick={() => handleConnect('photos/source')} className="w-full text-xs text-white bg-indigo-600 font-medium py-2 rounded-lg hover:bg-indigo-700 flex justify-center items-center">
                Connect Source Photos <ExternalLink className="w-3.5 h-3.5 ml-1" />
              </button>
            )}
          </div>

          {/* Destination Photos */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">Destination Photos Account</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">Upload & album management access</p>
              </div>
              {isPhotosDestConnected ? (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">Connected</span>
              ) : (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">Not Connected</span>
              )}
            </div>
            {isPhotosDestConnected ? (
              <div className="space-y-4">
                <p className="text-sm font-medium text-gray-900 dark:text-white">{photosDestProfile.profile?.email}</p>
                <button onClick={() => handleDisconnect('photos/destination', setPhotosDestProfile)} className="w-full text-xs text-red-600 font-medium py-2 border border-red-200 rounded-lg hover:bg-red-50">Disconnect</button>
              </div>
            ) : (
              <button onClick={() => handleConnect('photos/destination')} className="w-full text-xs text-white bg-indigo-600 font-medium py-2 rounded-lg hover:bg-indigo-700 flex justify-center items-center">
                Connect Destination Photos <ExternalLink className="w-3.5 h-3.5 ml-1" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Quick Actions</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Link to="/migration" className="flex flex-col items-center justify-center p-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 hover:border-indigo-500 hover:shadow-md transition-all group">
            <Play className="w-8 h-8 text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 mb-3" />
            <span className="text-sm font-medium text-gray-900 dark:text-white">Start New Migration</span>
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
