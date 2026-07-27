const fs = require('fs');
const path = require('path');

const files = [
  'src/components/MigrationDashboard.tsx',
  'src/components/TransferSummary.tsx',
  'src/components/auth/RoleGuard.tsx',
  'src/pages/Migration.tsx',
  'src/pages/MigrationProgress.tsx',
  'src/pages/UserDashboard.tsx',
  'src/pages/admin/Users.tsx'
];

files.forEach(file => {
  const fullPath = path.join(__dirname, file);
  if (fs.existsSync(fullPath)) {
    let content = fs.readFileSync(fullPath, 'utf-8');
    content = content.replace(/catch \(err\) {}/g, 'catch { }');
    content = content.replace(/catch \(e\) {}/g, 'catch { }');
    content = content.replace(/useState<any>/g, 'useState<unknown>');
    content = content.replace(/item: any/g, 'item: unknown');
    content = content.replace(/\(e: any\)/g, '(e: unknown)');
    content = content.replace(/: any/g, ': unknown');
    // Specific fixes
    if (file.includes('TransferSummary.tsx')) {
      content = content.replace(/, \[\]\);/g, ', [onScanComplete]);');
    }
    if (file.includes('Users.tsx')) {
      // Fix fetchUsers called before declaration
      content = content.replace(/const fetchUsers = async/g, 'async function fetchUsers');
      content = content.replace(/catch \(e\) {/g, 'catch (e) {'); // Revert catch if it was changed
      content = content.replace(/console\.error\(e\);/g, 'console.error(e);');
    }
    fs.writeFileSync(fullPath, content);
  }
});
console.log('Fixed');
