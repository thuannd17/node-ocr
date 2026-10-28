// Accounts and sign-in (Firebase Authentication). Anyone can sign up (views/signup.html) to get API keys (/account);
// admins also get the admin pages.
//   The browser signs in with Firebase (Google, GitHub, email + password: views/login.html), sends its ID token once
//   (POST /api/auth/session) and gets a Firebase session cookie "__session" (the one cookie Firebase Hosting passes on to
//   Cloud Run). The gate (routes/auth-api.js) checks that cookie, or an API key (services/accounts.js).
//   Roles: user, or admin = a verified email in ADMIN_EMAILS, or an account with the "admin" claim (/users, or
//   npm run auth:grant -- <email>). An email + password account signs in once its email is verified.
// .env: FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID (the web app's config, public), ADMIN_EMAILS,
//   GOOGLE_APPLICATION_CREDENTIALS (the admin SDK key file; not needed on Cloud Run), AUTH_PROVIDERS (google,github,password).
// Without FIREBASE_PROJECT_ID / FIREBASE_API_KEY login is off: the admin pages then open only from this machine (isLocal).

export const SESSION_COOKIE = '__session';
export const SESSION_DAYS = 5;
const PROVIDERS = ['google', 'github', 'password'];

export function authConfig(env = process.env) {
  const enabled = !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY);
  const providers = (env.AUTH_PROVIDERS || PROVIDERS.join(',')).split(',').map(p => p.trim().toLowerCase()).filter(p => PROVIDERS.includes(p));
  return {
    enabled,
    firebase: enabled ? { apiKey: env.FIREBASE_API_KEY, authDomain: env.FIREBASE_AUTH_DOMAIN || `${env.FIREBASE_PROJECT_ID}.firebaseapp.com`, projectId: env.FIREBASE_PROJECT_ID } : null,
    providers,
  };
}

export const adminEmails = (env = process.env) => new Set((env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean));

/** An admin: the "admin" claim, or a verified email in ADMIN_EMAILS (an unverified one could be anybody's sign-up). */
export function isAdmin(claims, emails = adminEmails()) {
  if (!claims) return false;
  if (claims.admin === true) return true;
  return byAdminEmail(claims, emails);
}
const byAdminEmail = (u, emails = adminEmails()) => !!u?.email && (u.email_verified ?? u.emailVerified) === true && emails.has(u.email.toLowerCase());

export const roleOf = (claims) => (isAdmin(claims) ? 'admin' : 'user');

/** The signed-in user of a session's claims, as the pages see it. */
export const userOf = (claims) => ({
  uid: claims.uid || claims.sub, email: claims.email || '', name: claims.name || '', role: roleOf(claims),
  provider: claims.firebase?.sign_in_provider || '', emailVerified: claims.email_verified === true,
});

/** A request made on this machine, not passed on by a proxy or a tunnel (cloudflared, Cloud Run add these headers). */
export function isLocal(req) {
  const ip = req.socket?.remoteAddress || '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const h = req.headers || {};
  return loopback && !h['x-forwarded-for'] && !h['cf-connecting-ip'] && !h.forwarded && !h['x-forwarded-host'];
}

export function sessionCookieOf(req) {
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers?.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

let firebaseAuth = null;
async function auth() {
  if (!firebaseAuth) {
    const { initializeApp, getApps, applicationDefault } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const app = getApps()[0] || initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
    firebaseAuth = getAuth(app);
  }
  return firebaseAuth;
}

// a checked cookie is trusted for a minute (a page opens a dozen API calls); a sign-out drops it at once
const checked = new Map();
const CHECK_MS = 60_000;

/** The claims of a valid, not revoked session cookie, or null. */
export async function verifySession(cookie) {
  if (!cookie) return null;
  const hit = checked.get(cookie);
  if (hit && hit.until > Date.now()) return hit.claims;
  try {
    const claims = await (await auth()).verifySessionCookie(cookie, true);
    if (checked.size > 500) checked.clear();
    checked.set(cookie, { claims, until: Date.now() + CHECK_MS });
    return claims;
  } catch {
    checked.delete(cookie);
    return null;
  }
}

export function forgetSession(cookie) {
  if (cookie) checked.delete(cookie);
}

/** A session cookie for a fresh ID token; throws with .status 401 / 403 (.code 'email-not-verified'). */
export async function createSession(idToken) {
  const a = await auth();
  let claims;
  try {
    claims = await a.verifyIdToken(idToken, true);
  } catch (e) {
    if (e.code === 'auth/user-disabled') throw Object.assign(new Error('This account is disabled'), { status: 403 });
    throw Object.assign(new Error('The sign-in did not work, please try again'), { status: 401 });
  }
  // only a sign-in of the last 5 minutes makes a session (a stolen old token does not)
  if (Date.now() / 1000 - claims.auth_time > 5 * 60) throw Object.assign(new Error('Please sign in again'), { status: 401 });
  // an email + password account proves its email first (anybody can sign up with any email)
  if (claims.firebase?.sign_in_provider === 'password' && claims.email_verified !== true) {
    throw Object.assign(new Error('Please verify your email first: open the link we sent to {email}'.replace('{email}', claims.email)), { status: 403, code: 'email-not-verified' });
  }
  const cookie = await a.createSessionCookie(idToken, { expiresIn: SESSION_DAYS * 86400_000 });
  return { cookie, claims, user: userOf(claims) };
}

/** Make an account an admin (the "admin" claim), or a user again; its sessions end, so it signs in again with its new role. */
export async function setAdmin(uid, on) {
  const a = await auth();
  const user = await a.getUser(uid);
  await a.setCustomUserClaims(uid, { ...(user.customClaims || {}), admin: !!on });
  await a.revokeRefreshTokens(uid);
  return user;
}

export async function grantAdmin(email, on = true) {
  const user = await (await auth()).getUserByEmail(email);
  return setAdmin(user.uid, on);
}

/** Disable an account (it cannot sign in, its sessions end) or enable it again. */
export async function setDisabled(uid, disabled) {
  const a = await auth();
  await a.updateUser(uid, { disabled: !!disabled });
  if (disabled) await a.revokeRefreshTokens(uid);
}

export async function setDisplayName(uid, name) {
  await (await auth()).updateUser(uid, { displayName: name || null });
}

export async function deleteUser(uid) {
  await (await auth()).deleteUser(uid);
}

/** Every account of the project: { uid, email, name, providers, emailVerified, disabled, role, roleFixed, created, lastSignIn }. */
export async function listUsers() {
  const a = await auth();
  const out = [];
  let page;
  do {
    page = await a.listUsers(1000, page?.pageToken);
    for (const u of page.users) {
      const fixed = byAdminEmail(u);
      out.push({
        uid: u.uid, email: u.email || '', name: u.displayName || '', providers: u.providerData.map(p => p.providerId),
        emailVerified: u.emailVerified, disabled: u.disabled, role: fixed || u.customClaims?.admin === true ? 'admin' : 'user',
        roleFixed: fixed, created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime || null,
      });
    }
  } while (page.pageToken);
  return out;
}
