import { Settings, Check } from 'lucide-react';
import type { TransferOptionsState } from '../types/transfer';

// eslint-disable-next-line react-refresh/only-export-components
export const defaultOptions: TransferOptionsState = {
  preserveStructure: true,
  overwriteExisting: false,
  skipExisting: true,
  renameConflicts: false,
  verifyChecksums: true,
  keepOriginalDate: true,
  transferDocsAsPdf: false,
  preservePermissions: false,
  threads: 4,
  chunkSize: 10,
  skipErrors: true,
  dryRun: false
};

export function TransferOptions({ options, onChange }: { options: TransferOptionsState, onChange: (o: TransferOptionsState) => void }) {
  const toggle = (key: keyof TransferOptionsState) => {
    onChange({ ...options, [key]: !options[key] });
  };

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
        <Settings className="w-5 h-5 text-muted-foreground" />
        <h3 className="text-lg font-semibold text-foreground">Transfer Options</h3>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        
        <label className="flex items-start gap-3 cursor-pointer group" onClick={() => toggle('preserveStructure')}>
          <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded border ${options.preserveStructure ? 'bg-primary border-primary text-primary-foreground' : 'border-input bg-background'} flex items-center justify-center transition-colors group-hover:border-primary`}>
            {options.preserveStructure && <Check className="w-3.5 h-3.5" />}
          </div>
          <div>
            <div className="font-medium text-sm text-foreground">Preserve Folder Structure</div>
            <div className="text-xs text-muted-foreground">Keep the exact hierarchy in the destination</div>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer group" onClick={() => toggle('keepOriginalDate')}>
          <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded border ${options.keepOriginalDate ? 'bg-primary border-primary text-primary-foreground' : 'border-input bg-background'} flex items-center justify-center transition-colors group-hover:border-primary`}>
            {options.keepOriginalDate && <Check className="w-3.5 h-3.5" />}
          </div>
          <div>
            <div className="font-medium text-sm text-foreground">Keep Original Modified Date</div>
            <div className="text-xs text-muted-foreground">Maintain the timestamp of the source file</div>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer group" onClick={() => toggle('verifyChecksums')}>
          <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded border ${options.verifyChecksums ? 'bg-primary border-primary text-primary-foreground' : 'border-input bg-background'} flex items-center justify-center transition-colors group-hover:border-primary`}>
            {options.verifyChecksums && <Check className="w-3.5 h-3.5" />}
          </div>
          <div>
            <div className="font-medium text-sm text-foreground">Verify Checksums</div>
            <div className="text-xs text-muted-foreground">Ensure bit-for-bit integrity after transfer</div>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer group" onClick={() => toggle('skipExisting')}>
          <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded border ${options.skipExisting ? 'bg-primary border-primary text-primary-foreground' : 'border-input bg-background'} flex items-center justify-center transition-colors group-hover:border-primary`}>
            {options.skipExisting && <Check className="w-3.5 h-3.5" />}
          </div>
          <div>
            <div className="font-medium text-sm text-foreground">Skip Existing</div>
            <div className="text-xs text-muted-foreground">Do not transfer if file already exists</div>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer group opacity-50">
          <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded border ${options.overwriteExisting ? 'bg-primary border-primary text-primary-foreground' : 'border-input bg-background'} flex items-center justify-center transition-colors`}>
            {options.overwriteExisting && <Check className="w-3.5 h-3.5" />}
          </div>
          <div>
            <div className="font-medium text-sm text-foreground">Overwrite Existing (Disabled)</div>
            <div className="text-xs text-muted-foreground">Replace files in destination</div>
          </div>
        </label>
        
        <label className="flex items-start gap-3 cursor-pointer group" onClick={() => toggle('transferDocsAsPdf')}>
          <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded border ${options.transferDocsAsPdf ? 'bg-primary border-primary text-primary-foreground' : 'border-input bg-background'} flex items-center justify-center transition-colors group-hover:border-primary`}>
            {options.transferDocsAsPdf && <Check className="w-3.5 h-3.5" />}
          </div>
          <div>
            <div className="font-medium text-sm text-foreground">Convert Google Docs to PDF</div>
            <div className="text-xs text-muted-foreground">Exports native docs as flat PDFs</div>
          </div>
        </label>

      </div>
    </div>
  );
}
