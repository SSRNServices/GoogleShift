import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { pool } from '../utils/database';
import { getConfig } from '../config/config';
import { logger } from '../utils/logger';

const PgStore = pgSession(session);
const config = getConfig();

const getDerivedCookieDomain = (): string | undefined => {
  if (config.COOKIE_DOMAIN) return config.COOKIE_DOMAIN;
  if (config.NODE_ENV !== 'production') return undefined;
  const targetUrl = config.FRONTEND_URL || config.BACKEND_URL || '';
  try {
    const hostname = new URL(targetUrl).hostname;
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      return `.${parts.slice(-2).join('.')}`;
    }
    return hostname;
  } catch (_) {
    return undefined;
  }
};

const cookieDomain = getDerivedCookieDomain();

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
