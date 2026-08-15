import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { getUserById, getUserByGoogleId, createUser, prisma } from '../utils/database';

passport.serializeUser((user: any, done) => {
  console.log("serializeUser", user);
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  console.log("deserializeUser", id);
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
  const callbackURL = process.env.GOOGLE_LOGIN_REDIRECT_URI as string;

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
          const email = profile.emails?.[0]?.value;
          if (email) {
            const existingUser = await prisma.user.findUnique({ where: { email } });
            if (existingUser) {
              user = await prisma.user.update({
                where: { id: existingUser.id },
                data: {
                  googleId: profile.id,
                  avatar: profile.photos?.[0]?.value || existingUser.avatar
                }
              });
            }
          }
          if (!user) {
            user = await createUser(profile);
          }
        }
        return done(null, user);
      } catch (err) {
        return done(err, false);
      }
    }));
  }
};
