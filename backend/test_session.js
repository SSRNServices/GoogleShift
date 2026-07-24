require('dotenv').config();
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const store = new pgSession({
  pool: pool,
  tableName: 'session'
});

store.set('test-sid', { cookie: { maxAge: 1000 }, user: 'test' }, (err) => {
  if (err) {
    console.error('Failed to set session:', err);
  } else {
    console.log('Session set successfully');
    store.get('test-sid', (err, sess) => {
      if (err) console.error('Failed to get session:', err);
      else console.log('Retrieved session:', sess);
      pool.end();
    });
  }
});
