const fs = require('fs');
const path = require('path');

function replaceInFile(filePath, search, replacement) {
  const fullPath = path.resolve(__dirname, filePath);
  if (!fs.existsSync(fullPath)) return;
  let content = fs.readFileSync(fullPath, 'utf8');
  content = content.split(search).join(replacement);
  fs.writeFileSync(fullPath, content);
}

replaceInFile('src/pages/UserDashboard.tsx', 'formatBytes(sourceProfile.profile?.storage?.used)', 'formatBytes(sourceProfile.profile?.storage?.used || 0)');
replaceInFile('src/pages/UserDashboard.tsx', 'formatBytes(sourceProfile.profile?.storage?.limit)', 'formatBytes(sourceProfile.profile?.storage?.limit || 0)');
replaceInFile('src/pages/UserDashboard.tsx', 'formatBytes(destProfile.profile?.storage?.used)', 'formatBytes(destProfile.profile?.storage?.used || 0)');
replaceInFile('src/pages/UserDashboard.tsx', 'formatBytes(destProfile.profile?.storage?.limit)', 'formatBytes(destProfile.profile?.storage?.limit || 0)');

replaceInFile('src/pages/Migration.tsx', 'const [sourceProfile, setSourceProfile] = useState<unknown>(null);', 'const [sourceProfile, setSourceProfile] = useState<{state?: string; profile?: {email?: string}} | null>(null);');
replaceInFile('src/pages/Migration.tsx', 'const [destProfile, setDestProfile] = useState<unknown>(null);', 'const [destProfile, setDestProfile] = useState<{state?: string; profile?: {email?: string}} | null>(null);');
replaceInFile('src/pages/Migration.tsx', 'destSelected.id', 'destSelected?.id || ""');
replaceInFile('src/pages/Migration.tsx', 'selectedId: string', 'selectedId?: string');
let migrationContent = fs.readFileSync('src/pages/Migration.tsx', 'utf8');
migrationContent = migrationContent.replace(/alert\\(err\\.message \\|\\| 'Failed to start migration'\\);/g, 'alert(err instanceof Error ? err.message : "Failed to start migration");');
fs.writeFileSync('src/pages/Migration.tsx', migrationContent);

let loginContent = fs.readFileSync('src/pages/Login.tsx', 'utf8');
loginContent = loginContent.replace(/catch \\(err: unknown\\) \\{\\s*setError\\(err\\.message \\|\\| 'Login failed'\\);/g, 'catch (err: unknown) {\\n      if (err instanceof Error) setError(err.message); else setError("Login failed");');
fs.writeFileSync('src/pages/Login.tsx', loginContent);

let historyContent = fs.readFileSync('src/pages/History.tsx', 'utf8');
historyContent = historyContent.replace('const [jobs, setJobs] = useState<unknown[]>([])', 'const [jobs, setJobs] = useState<MigrationJob[]>([])');
const interfaceStr = `interface MigrationJob {
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
}
`;
if (!historyContent.includes('interface MigrationJob')) {
  historyContent = historyContent.replace('export default function History() {', interfaceStr + '\\nexport default function History() {');
}
fs.writeFileSync('src/pages/History.tsx', historyContent);
