import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import bcrypt from 'bcrypt';
import { prisma } from '../utils/database';

export function configureLocalStrategy() {
  passport.use(new LocalStrategy(
    {
      usernameField: 'email',
      passwordField: 'password'
    },
    async (email, password, done) => {
      try {
        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() }
        });

        if (!user) {
          return done(null, false, { message: 'Invalid email or password' });
        }

        if (!user.isActive || user.status !== 'ACTIVE') {
          return done(null, false, { message: 'Account is locked or inactive' });
        }

        if (!user.passwordHash) {
          return done(null, false, { message: 'This account uses Google Login' });
        }

        const isMatch = await bcrypt.compare(password, user.passwordHash);
        
        if (!isMatch) {
          return done(null, false, { message: 'Invalid email or password' });
        }

        // Update last login
        await prisma.user.update({
          where: { id: user.id },
          data: { lastLogin: new Date() }
        });

        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }
  ));
}
