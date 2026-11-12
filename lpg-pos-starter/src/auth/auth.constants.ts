// Loads the backend's .env file so JWT_SECRET is available.
import 'dotenv/config';

const secret = process.env.JWT_SECRET;

if (!secret || secret.length < 32) {
  throw new Error(
    'JWT_SECRET is missing or too short. Add a line like ' +
      'JWT_SECRET=<at least 32 random characters> to the backend .env file.',
  );
}

// The secret used to sign sign-in tokens. Never share it or commit it.
export const JWT_SECRET: string = secret;

// How long a sign-in lasts before the person must sign in again (30 days).
export const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 30;