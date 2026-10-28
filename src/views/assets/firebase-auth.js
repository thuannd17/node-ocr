// Firebase sign-in in the browser, shared by /login, /signup and /account (an ES module):
//   const fb = await loadFirebase();   // null when login is not set up on the server
//   await fb.toSession(cred)           // a fresh sign-in -> the server's "__session" cookie (POST /api/auth/session)
// The Firebase JS SDK comes from Google's CDN; the browser keeps no Firebase session of its own (in memory only):
// the server's cookie is the session.
const V = '10.14.1';
const t = (s, p) => (window.t ? window.t(s, p) : s.replace(/\{(\w+)\}/g, (_, k) => p?.[k] ?? ''));

export const ERRORS = {
  'auth/invalid-credential': 'Wrong email or password',
  'auth/wrong-password': 'Wrong email or password',
  'auth/user-not-found': 'Wrong email or password',
  'auth/invalid-email': 'This is not an email address',
  'auth/email-already-in-use': 'There is already an account with this email: sign in instead',
  'auth/weak-password': 'Choose a longer password (8 characters or more)',
  'auth/user-disabled': 'This account is disabled',
  'auth/too-many-requests': 'Too many tries: please wait a little and try again',
  'auth/account-exists-with-different-credential': 'This email already signs in another way: use that one',
  'auth/popup-blocked': 'The browser blocked the sign-in window: allow pop-ups for this site',
  'auth/unauthorized-domain': 'This domain is not allowed in the Firebase project (Authentication > Settings > Authorized domains)',
  'auth/operation-not-allowed': 'This way of signing in is not turned on in the Firebase project',
  'auth/admin-restricted-operation': 'New accounts cannot be made right now: ask an admin',
  'auth/requires-recent-login': 'Please sign in again first',
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'The Firebase settings of this server are wrong (FIREBASE_API_KEY)',
  'auth/invalid-api-key': 'The Firebase settings of this server are wrong (FIREBASE_API_KEY)',
};
/** A sign-in error as a message for the page ('' when the user just closed the window). */
export function describe(e) {
  if (e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request') return '';
  return t(ERRORS[e?.code] || e?.message || 'The sign-in did not work, please try again');
}

export async function api(url, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(url, body || method !== 'GET' ? { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status, code: data.code, data });
  return data;
}

/** Back to the page that sent here (a path on this site only), else the account's own page. */
export function nextOf(role) {
  const want = new URLSearchParams(location.search).get('next') || '';
  if (/^\/(?![\/\\])/.test(want)) return want;
  return role === 'admin' ? '/label' : '/account';
}

export async function loadFirebase(config) {
  config ||= await api('/api/auth/config');
  if (!config.enabled) return null;
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const fa = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
  const auth = fa.getAuth(initializeApp(config.firebase));
  await fa.setPersistence(auth, fa.inMemoryPersistence);
  auth.languageCode = (window.I18N && window.I18N.lang) || 'en';
  const providers = { google: () => new fa.GoogleAuthProvider(), github: () => new fa.GithubAuthProvider() };
  return {
    config, auth, fa,
    popup: (name) => fa.signInWithPopup(auth, providers[name]()),
    /** The server's session for this fresh sign-in: { user }. The Firebase sign-in in the browser ends either way. */
    async toSession(cred) {
      try {
        return await api('/api/auth/session', { idToken: await cred.user.getIdToken() });
      } finally {
        await fa.signOut(auth).catch(() => {});
      }
    },
  };
}
