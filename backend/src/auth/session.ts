import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { Pool } from 'pg';

const PgStore = pgSession(session);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export const sessionMiddleware = session({
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
    sameSite: 'none', // required for cross-origin
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  }
});
