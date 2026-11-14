import { FirebaseApp, getApps, initializeApp } from 'firebase/app';
import {
  Auth,
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  setPersistence,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { Database, getDatabase } from 'firebase/database';

const DEFAULT_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCHCLK7y12opCuMZdZ8Kw-Qkv91a6klxHo',
  authDomain: 'pen-fight-arena-18.firebaseapp.com',
  databaseURL: 'https://pen-fight-arena-18-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'pen-fight-arena-18',
  storageBucket: 'pen-fight-arena-18.firebasestorage.app',
  messagingSenderId: '1055102711507',
  appId: '1:1055102711507:web:9a4aeef846c42339554626',
  measurementId: 'G-CVJM6Q7Z1X',
} as const;

function isPlaceholder(val: string): boolean {
  const lower = val.toLowerCase();
  return !val || lower.includes('your-project-id') || lower.includes('your-firebase');
}

function resolveEnvOrDefault(envVal: unknown, fallback: string): string {
  const trimmed = typeof envVal === 'string' ? envVal.trim() : '';
  return !isPlaceholder(trimmed) ? trimmed : fallback;
}

const resolvedDatabaseUrl = resolveEnvOrDefault(
  import.meta.env.VITE_FIREBASE_DATABASE_URL,
  DEFAULT_FIREBASE_CONFIG.databaseURL
);

const firebaseConfig = {
  apiKey: resolveEnvOrDefault(import.meta.env.VITE_FIREBASE_API_KEY, DEFAULT_FIREBASE_CONFIG.apiKey),
  authDomain: resolveEnvOrDefault(
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    DEFAULT_FIREBASE_CONFIG.authDomain
  ),
  databaseURL: resolvedDatabaseUrl,
  projectId: resolveEnvOrDefault(
    import.meta.env.VITE_FIREBASE_PROJECT_ID,
    DEFAULT_FIREBASE_CONFIG.projectId
  ),
  storageBucket: resolveEnvOrDefault(
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    DEFAULT_FIREBASE_CONFIG.storageBucket
  ),
  messagingSenderId: resolveEnvOrDefault(
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    DEFAULT_FIREBASE_CONFIG.messagingSenderId
  ),
  appId: resolveEnvOrDefault(import.meta.env.VITE_FIREBASE_APP_ID, DEFAULT_FIREBASE_CONFIG.appId),
  measurementId: resolveEnvOrDefault(
    import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
    DEFAULT_FIREBASE_CONFIG.measurementId
  ),
};

export function isFirebaseConfigured(): boolean {
  return (
    !isPlaceholder(firebaseConfig.apiKey) &&
    !isPlaceholder(firebaseConfig.authDomain) &&
    !isPlaceholder(firebaseConfig.projectId) &&
    !isPlaceholder(firebaseConfig.appId)
  );
}

export function isFirebaseDatabaseConfigured(): boolean {
  return isFirebaseConfigured() && Boolean(resolvedDatabaseUrl);
}

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;
let cachedDb: Database | null = null;
let persistenceInitialized = false;

export function getFirebaseApp(): FirebaseApp | null {
  if (!isFirebaseConfigured()) return null;
  if (!cachedApp) {
    const existing = getApps();
    cachedApp = existing.length > 0 ? existing[0] : initializeApp(firebaseConfig);
  }
  return cachedApp;
}

export function getFirebaseAuth(): Auth | null {
  const app = getFirebaseApp();
  if (!app) return null;
  if (!cachedAuth) {
    cachedAuth = getAuth(app);
  }
  if (!persistenceInitialized) {
    persistenceInitialized = true;
    void setPersistence(cachedAuth, browserLocalPersistence).catch(() => {
      // Non-fatal fallback if browser restricts indexedDB/localStorage in private context
    });
  }
  return cachedAuth;
}

export function getFirebaseDatabase(): Database | null {
  if (!isFirebaseDatabaseConfigured()) return null;
  const app = getFirebaseApp();
  if (!app) return null;
  if (!cachedDb) {
    cachedDb = getDatabase(app);
  }
  return cachedDb;
}

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: 'select_account',
});

export async function signInWithGoogle(): Promise<{ error?: string }> {
  const auth = getFirebaseAuth();
  if (!auth) {
    return {
      error:
        'Firebase Auth is not configured. Set VITE_FIREBASE_* environment variables to enable Google Sign-In.',
    };
  }

  try {
    await signInWithPopup(auth, googleProvider);
    return {};
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
    switch (code) {
      case 'auth/popup-blocked':
        return {
          error:
            'Google Sign-In pop-up was blocked by your browser. Allow pop-ups for this site and try again.',
        };
      case 'auth/popup-closed-by-user':
      case 'auth/cancelled-popup-request':
        return { error: 'Google Sign-In was cancelled before completion.' };
      case 'auth/unauthorized-domain':
        return {
          error:
            'Google login failed: this domain is not listed under Firebase Console → Authentication → Settings → Authorized domains.',
        };
      case 'auth/operation-not-allowed':
        return {
          error:
            'Google Sign-In is not enabled yet. Enable Google under Firebase Console → Authentication → Sign-in method.',
        };
      case 'auth/network-request-failed':
        return {
          error: 'Network unavailable while contacting Google Sign-In. Check your connection.',
        };
      default: {
        const msg = err instanceof Error ? err.message : 'Google login failed.';
        return { error: `Google login failed: ${msg}` };
      }
    }
  }
}

export async function signOutOnline(): Promise<void> {
  const auth = getFirebaseAuth();
  if (!auth) return;
  await signOut(auth);
}
