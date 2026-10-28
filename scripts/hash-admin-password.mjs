import { randomBytes, scryptSync } from 'node:crypto';

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('Usage: node scripts/hash-admin-password.mjs <password of at least 8 characters>');
  process.exitCode = 1;
} else {
  const salt = randomBytes(16).toString('base64url');
  const digest = scryptSync(password, salt, 64).toString('base64url');
  console.log(`scrypt$${salt}$${digest}`);
}
