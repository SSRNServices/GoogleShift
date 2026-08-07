import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform((val) => parseInt(val, 10)).default('3100'),
  
  // Security & Authentication
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  SESSION_SECRET: z.string().min(1, 'SESSION_SECRET is required'),
  
  // Database Configuration
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().optional(),
  
  // Google OAuth Credentials
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_LOGIN_REDIRECT_URI: z.string().url('GOOGLE_LOGIN_REDIRECT_URI must be a valid URL'),
  GOOGLE_DRIVE_REDIRECT_URI: z.string().url('GOOGLE_DRIVE_REDIRECT_URI must be a valid URL'),
  
  // Network & Domain Settings
  FRONTEND_URL: z.string().min(1, 'FRONTEND_URL is required'),
  BACKEND_URL: z.string().optional(),
  COOKIE_DOMAIN: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),
  
  // Cache / Redis (Optional)
  REDIS_URL: z.string().optional(),
  
  // Logging & Tuning
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
  AUTO_RETRY: z.string().optional().default('5'),
  DEFAULT_CHUNK_SIZE: z.string().optional().default('8388608'),
  MAX_PARALLEL_UPLOADS: z.string().optional().default('4'),
  VERIFY_CHECKSUM: z.string().optional().default('true'),
  PRESERVE_FOLDER_STRUCTURE: z.string().optional().default('true'),
  DISCOVERY_TIMEOUT_MS: z.string().optional().default('300000')
});

export type Config = z.infer<typeof envSchema>;

let validatedConfig: Config;

export function validateConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('\n❌ Invalid Environment Configuration:');
    const formattedErrors = result.error.format();
    for (const [key, val] of Object.entries(formattedErrors)) {
      if (key !== '_errors' && val && '_errors' in val && (val._errors as string[]).length > 0) {
        console.error(`  - ${key}: ${(val._errors as string[]).join(', ')}`);
      }
    }
    console.error('\nPlease check your .env file or environment settings before starting the server.\n');
    process.exit(1);
  }

  validatedConfig = result.data;
  return validatedConfig;
}

export function getConfig(): Config {
  if (!validatedConfig) {
    return validateConfig();
  }
  return validatedConfig;
}
