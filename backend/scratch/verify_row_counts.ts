import { prisma, pool } from '../src/utils/database';

async function verifyCounts() {
  try {
    const userCount = await prisma.user.count();
    const discoveryJobCount = await prisma.discoveryJob.count();
    const migrationSessionCount = await prisma.migrationSession.count();
    const oauthAccountCount = await prisma.oAuthAccount.count();
    const scanSummaryCount = await prisma.scanSummary.count();

    console.log('\n==================================================');
    console.log('Row Counts Verification against Self-Hosted Database:');
    console.log('==================================================');
    console.log(`- User: ${userCount} (Expected: 1)`);
    console.log(`- DiscoveryJob: ${discoveryJobCount} (Expected: 7)`);
    console.log(`- MigrationSession: ${migrationSessionCount} (Expected: 7)`);
    console.log(`- OAuthAccount: ${oauthAccountCount} (Expected: 2)`);
    console.log(`- ScanSummary: ${scanSummaryCount} (Expected: 3)`);
    console.log('==================================================\n');

    const matches = (
      userCount === 1 &&
      discoveryJobCount === 7 &&
      migrationSessionCount === 7 &&
      oauthAccountCount === 2 &&
      scanSummaryCount === 3
    );

    if (matches) {
      console.log('✓ ALL ROW COUNTS MATCH EXPECTATIONS PERFECTLY!');
    } else {
      console.log('⚠️ Row count mismatch detected.');
    }
  } catch (err: any) {
    console.error('❌ Query failed:', err.message);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

verifyCounts();
