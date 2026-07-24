import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { getUserById, getUserByGoogleId, createUser } from '../utils/database';

passport.serializeUser((user: any, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await getUserById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

export const configurePassport = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const isProd = process.env.NODE_ENV === 'production';
  const callbackURL = isProd 
    ? 'https://api.migration.ssrnservices.in/auth/login/callback'
    : 'http://localhost:3000/auth/login/callback';

  if (!clientId || !clientSecret) {
    console.warn('Google Client ID or Secret missing. Passport login will fail.');
  } else {
    passport.use(new GoogleStrategy({
      clientID: clientId,
      clientSecret: clientSecret,
      callbackURL: callbackURL
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        let user = await getUserByGoogleId(profile.id);
        if (!user) {
          user = await createUser(profile);
        }
        return done(null, user);
      } catch (err) {
        return done(err, false);
      }
    }));
  }
};
