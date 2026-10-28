// Make a Firebase account an admin of the site (the "admin" claim, services/auth.js), or take it back.
//   npm run auth:grant -- someone@example.com            (the account must have signed in once, or be added in the console)
//   npm run auth:grant -- someone@example.com --revoke   (also ends its sessions)
// Needs FIREBASE_PROJECT_ID and the admin SDK key (GOOGLE_APPLICATION_CREDENTIALS) in .env.
import { grantAdmin } from '../services/auth.js';

const args = process.argv.slice(2);
const email = args.find(a => !a.startsWith('--'));
const on = !args.includes('--revoke');
if (!email) {
  console.error('Usage: npm run auth:grant -- <email> [--revoke]');
  process.exit(1);
}
try {
  const user = await grantAdmin(email, on);
  console.log(on ? `${user.email} is an admin now (sign in again to use it).` : `${user.email} is no longer an admin; its sessions are ended.`);
} catch (e) {
  console.error(e.code === 'auth/user-not-found' ? `No Firebase account with ${email}: sign in once on /login, or add it in the Firebase console.` : e.message);
  process.exit(1);
}
