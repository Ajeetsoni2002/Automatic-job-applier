// Prints a bcrypt hash for ADMIN_PASSWORD_HASH.  Usage: npm run hash-password -- "your-password"
import bcrypt from 'bcryptjs';

const password = process.argv[2];
if (!password || password.length < 10) {
  console.error('Usage: npm run hash-password -- "a-password-of-at-least-10-characters"');
  process.exit(1);
}
const hash = await bcrypt.hash(password, 12);
console.log(
  `\nAdd this line to .env (single quotes keep the $ characters intact):\n\nADMIN_PASSWORD_HASH='${hash}'\n`,
);
