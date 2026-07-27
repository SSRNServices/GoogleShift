import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Cloud, Loader2, ArrowLeft } from 'lucide-react';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    
    // Simulate API call
    setTimeout(() => {
      setLoading(false);
      setSuccess(true);
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-xl p-10 flex flex-col items-center text-center">
        
        <div className="w-16 h-16 bg-indigo-600 rounded-2xl shadow-lg flex items-center justify-center mb-6">
          <Cloud className="text-white w-8 h-8" />
        </div>
        
        <h1 className="text-2xl font-extrabold tracking-tight mb-2">
          Forgot Password
        </h1>
        
        {!success ? (
          <>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">
              Enter your email address and we'll send you a link to reset your password.
            </p>

            <form className="w-full text-left space-y-4" onSubmit={handleSubmit}>
              <div>
                <label className="block text-sm font-medium mb-1">Email address</label>
                <input
                  type="email"
                  required
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-indigo-500 focus:border-indigo-500 bg-transparent"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-indigo-600 text-white hover:bg-indigo-700 font-semibold px-4 py-2 mt-6 rounded-md flex items-center justify-center transition-all disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Send reset link'}
              </button>
            </form>
          </>
        ) : (
          <div className="text-sm text-green-600 dark:text-green-400 mb-8">
            If an account exists for {email}, you will receive a password reset link shortly.
          </div>
        )}

        <div className="mt-8">
          <Link to="/login" className="flex items-center text-sm font-medium text-indigo-600 hover:text-indigo-500">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to login
          </Link>
        </div>

      </div>
    </div>
  );
}
