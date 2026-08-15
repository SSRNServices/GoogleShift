import { prisma, pool, getDatabaseConnectionInfo } from '../src/utils/database';

async function testConnection() {
  console.log('\n==================================================');
  console.log('Testing New Database Connection Environment...');
  console.log('==================================================');
  const info = getDatabaseConnectionInfo();
  console.log(`- Connection Host: ${info.host}`);
  console.log(`- Port: ${info.port}`);
  console.log(`- Database: ${info.database}`);
  console.log(`- SSL Mode: ${info.sslMode}`);
  console.log(`- Connection Type: ${info.connectionType}`);
  console.log(`- Masked URL: ${info.maskedUrl}`);
  console.log('--------------------------------------------------');

  const start = Date.now();
  try {
    const result = await prisma.$queryRaw`SELECT 1 as alive, current_database(), current_user, version()`;
    const latency = Date.now() - start;
    console.log('✓ Database Connection SUCCESSFUL!');
    console.log(`- Latency: ${latency} ms`);
    console.log('- Result:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('❌ Database Connection FAILED!');
    console.error('- Error Message:', err.message);
    console.error('- Full Error Stack:', err.stack);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    console.log('==================================================\n');
  }
}

testConnection();
