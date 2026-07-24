import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { Pool } from 'pg';

const PgStore = pgSession(session);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const sessionConfig = {
  store: new PgStore({
    pool: pool,
    tableName: 'session'
  }),
  secret: process.env.SESSION_SECRET || 'super_secret_fallback',
  resave: false,
  saveUninitialized: false,
  proxy: true, // required for secure cookies behind proxy
  cookie: {
    secure: true, // force secure cookies for cross-origin
    sameSite: 'none' as const, // required for cross-origin
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  }
};

console.log('\n=== Express Session Config ===');
console.log('Secure:', sessionConfig.cookie.secure);
console.log('SameSite:', sessionConfig.cookie.sameSite);
console.log('Proxy:', sessionConfig.proxy);
console.log('=============================\n');

export const sessionMiddleware = session(sessionConfig);
