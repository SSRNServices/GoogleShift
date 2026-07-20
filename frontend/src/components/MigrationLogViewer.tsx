import { useEffect, useRef } from 'react';
import { Terminal } from 'lucide-react';

export function MigrationLogViewer({ logs }: { logs: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="bg-black text-emerald-400 p-4 font-mono text-xs flex flex-col h-64 border-t border-border/50">
      <div className="flex items-center gap-2 mb-3 text-emerald-500/70 border-b border-emerald-500/20 pb-2">
        <Terminal className="w-4 h-4" />
        <span className="uppercase tracking-widest font-semibold">Live Event Log</span>
      </div>
      
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-1.5 scrollbar-thin scrollbar-thumb-emerald-500/20 scrollbar-track-transparent pr-2"
      >
        {logs.length === 0 && (
          <div className="text-emerald-500/40 italic">Waiting for events...</div>
        )}
        {logs.map((log, i) => (
          <div key={i} className="flex gap-3">
            <span className="text-emerald-500/50 flex-shrink-0">[{new Date().toLocaleTimeString()}]</span>
            <span className="break-all">{log}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
