import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { pool } from '../utils/database';
import { getConfig } from '../config/config';
import { logger } from '../utils/logger';

const PgStore = pgSession(session);
const config = getConfig();

const cookieDomain = config.COOKIE_DOMAIN || (config.NODE_ENV === 'production' ? '.googleshift.com' : undefined);

const cookieOptions: session.CookieOptions = {
  secure: config.NODE_ENV === 'production',
  sameSite: config.NODE_ENV === 'production' ? 'none' : 'lax',
  ...(cookieDomain ? { domain: cookieDomain } : {}),
  httpOnly: true,
  maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
};

const sessionConfig: session.SessionOptions = {
  store: new PgStore({
    pool: pool,
    tableName: 'session'
  }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: cookieOptions
};

logger.info('[Express Session Config]', {
  secure: cookieOptions.secure,
  sameSite: cookieOptions.sameSite,
  proxy: sessionConfig.proxy,
  cookieDomain
});

export const sessionMiddleware = session(sessionConfig);
