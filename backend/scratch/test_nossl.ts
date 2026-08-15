import 'dotenv/config';
import { Pool } from 'pg';

async function testConnection() {
  const rawUrl = process.env.DATABASE_URL || '';
  console.log('Raw URL evaluated:', rawUrl.replace(/:[^:@]+@/, ':***@'));

  const match = rawUrl.match(/postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?\s]+)/);
  if (!match) {
    console.error('Could not parse database URL via regex:', rawUrl);
    return;
  }

  const [, user, password, host, port, database] = match;
  console.log(`Parsed -> User: ${user}, Host: ${host}, Port: ${port}, Database: ${database}`);

  // Test 1: Without SSL
  console.log('\n--- Test 1: Connecting WITHOUT SSL (ssl: false) ---');
  const poolNoSsl = new Pool({
    user,
    password,
    host,
    port: parseInt(port, 10),
    database,
    ssl: false,
    connectionTimeoutMillis: 5000
  });

  try {
    const client = await poolNoSsl.connect();
    const res = await client.query('SELECT 1 as alive, current_database(), version()');
    console.log('✓ SUCCESS WITHOUT SSL! Result:', res.rows[0]);
    client.release();
  } catch (err: any) {
    console.error('❌ FAILED WITHOUT SSL:', err.message);
  } finally {
    await poolNoSsl.end();
  }

  // Test 2: With SSL
  console.log('\n--- Test 2: Connecting WITH SSL (ssl: { rejectUnauthorized: false }) ---');
  const poolSsl = new Pool({
    user,
    password,
    host,
    port: parseInt(port, 10),
    database,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  });

  try {
    const client = await poolSsl.connect();
    const res = await client.query('SELECT 1 as alive, current_database(), version()');
    console.log('✓ SUCCESS WITH SSL! Result:', res.rows[0]);
    client.release();
  } catch (err: any) {
    console.error('❌ FAILED WITH SSL:', err.message);
  } finally {
    await poolSsl.end();
  }
}

testConnection();
