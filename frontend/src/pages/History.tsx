import { Clock, ArrowRight, Loader2, CheckCircle2, AlertTriangle, PlayCircle, FolderOutput, ExternalLink } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/apiClient';

const formatDate = (dateString: string) => {
  if (!dateString) return 'N/A';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(dateString));
};

interface MigrationJob {
  jobId: string;
  status: string;
  createdAt: string;
  endedAt?: string;
  sourceSelection?: {name?: string}[];
  destinationFolder?: {name?: string};
  completedFiles?: number;
  totalFiles?: number;
  failedFiles?: number;
  totalBytes?: number;
  transferredBytes?: number;
  speed?: number;
  eta?: number;
}

export default function History() {
  const navigate = useNavigate();
  const { data: migrations, isLoading } = useQuery({
    queryKey: ['migrations', 'history'],
    queryFn: async () => {
      const res = await apiClient('/api/migrations/history');
      return res.migrations || [];
    },
    refetchInterval: 3000 // Auto-refresh history every 3 seconds for active jobs
  });

  const handleOpenMigration = (jobId: string) => {
    navigate(`/migration/progress?jobId=${jobId}`);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Migration History</h1>
          <p className="text-muted-foreground mt-1">View past and current migration activities</p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        {migrations?.length === 0 ? (
          <div className="p-12 flex flex-col items-center justify-center text-center">
            <Clock className="w-12 h-12 text-muted-foreground mb-4 opacity-50" />
            <h3 className="text-lg font-medium text-foreground">No migrations yet</h3>
            <p className="text-muted-foreground mt-1">Your migration history will appear here once you start one.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {migrations?.map((job: MigrationJob) => {
              const isActive = ['queued', 'scanning', 'preparing', 'copying', 'verifying', 'paused', 'running'].includes(job.status);
              const transferred = Number(job.transferredBytes || 0);
              const totalBytes = Number(job.totalBytes || 0);
              let pct = 0;
              if (totalBytes > 0) pct = Math.min(100, Math.floor((transferred / totalBytes) * 100));
              else if (job.totalFiles && job.totalFiles > 0) pct = Math.min(100, Math.floor((((job.completedFiles || 0) + (job.failedFiles || 0)) / job.totalFiles) * 100));

              return (
                <div 
                  key={job.jobId} 
                  onClick={() => handleOpenMigration(job.jobId)}
                  className="p-6 hover:bg-muted/50 transition-colors cursor-pointer group"
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    
                    {/* Left Section: Status & Timestamps */}
                    <div className="flex items-start gap-4">
                      <div className="mt-1">
                        {job.status === 'completed' && <CheckCircle2 className="w-6 h-6 text-emerald-500" />}
                        {job.status === 'failed' && <AlertTriangle className="w-6 h-6 text-destructive" />}
                        {isActive && <Loader2 className="w-6 h-6 text-primary animate-spin" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-semibold text-foreground capitalize">{job.status}</span>
                          <span className="text-xs text-muted-foreground px-2 py-0.5 bg-secondary rounded-full border border-border">
                            ID: {job.jobId.slice(0, 8)}
                          </span>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          Started: {formatDate(job.createdAt)}
                        </div>
                        {job.endedAt && (
                          <div className="text-sm text-muted-foreground">
                            Ended: {formatDate(job.endedAt)}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Middle Section: Source -> Dest */}
                    <div className="flex items-center gap-3 text-sm flex-1 md:justify-center bg-background/50 px-4 py-2 rounded-lg border border-border">
                      <div className="flex items-center gap-1.5 truncate max-w-[150px]" title={job.sourceSelection?.[0]?.name}>
                        <FolderOutput className="w-4 h-4 text-blue-500" />
                        <span className="truncate font-medium">{job.sourceSelection?.[0]?.name || 'Source'}</span>
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <div className="flex items-center gap-1.5 truncate max-w-[150px]" title={job.destinationFolder?.name}>
                        <FolderOutput className="w-4 h-4 text-purple-500" />
                        <span className="truncate font-medium">{job.destinationFolder?.name || 'Destination'}</span>
                      </div>
                    </div>

                    {/* Right Section: Stats & Action Button */}
                    <div className="flex items-center gap-6 text-sm">
                      <div className="flex flex-col items-end">
                        <span className="text-muted-foreground text-xs">Progress</span>
                        <span className="font-medium text-foreground">{pct}% ({job.completedFiles || 0}/{job.totalFiles || 0})</span>
                      </div>
                      <div className="flex flex-col items-end">
                        <span className="text-muted-foreground text-xs">Data</span>
                        <span className="font-medium text-foreground">
                          {(totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(2) : '0')} MB
                        </span>
                      </div>
                      <button className="flex items-center space-x-1 text-xs px-3 py-1.5 rounded-md bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                        <span>{isActive ? 'Resume Live' : 'View Details'}</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    </div>

                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
