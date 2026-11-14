import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { Auth, DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { Database, Reference, getDatabase } from 'firebase-admin/database';
import { ApiRequest, checkInMemoryRateLimit, getBearerToken } from './http';

export interface FirebaseServerConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  databaseURL: string;
}

let cachedApp: App | null = null;
let cachedAuth: Auth | null = null;
let cachedDb: Database | null = null;

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    !value ||
    lower.includes('your-project-id') ||
    lower.includes('your_private_key') ||
    lower.includes('adminsdk-xxxxx') ||
    lower.includes('your-firebase')
  );
}

export function getFirebaseServerConfig(): FirebaseServerConfig | null {
  const projectId = (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.VITE_FIREBASE_PROJECT_ID ||
    ''
  ).trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const rawPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || '').trim();
  const privateKey = rawPrivateKey.replace(/\\n/g, '\n');
  const databaseURL = (
    process.env.FIREBASE_DATABASE_URL ||
    process.env.VITE_FIREBASE_DATABASE_URL ||
    ''
  ).trim();

  if (
    isPlaceholder(projectId) ||
    isPlaceholder(clientEmail) ||
    isPlaceholder(privateKey) ||
    isPlaceholder(databaseURL)
  ) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey,
    databaseURL,
  };
}

export function getFirebaseAdminServices(): {
  app: App;
  auth: Auth;
  db: Database;
  config: FirebaseServerConfig;
} | null {
  const config = getFirebaseServerConfig();
  if (!config) return null;

  if (!cachedApp) {
    const existing = getApps();
    cachedApp =
      existing.length > 0
        ? existing[0]
        : initializeApp({
            credential: cert({
              projectId: config.projectId,
              clientEmail: config.clientEmail,
              privateKey: config.privateKey,
            }),
            databaseURL: config.databaseURL,
          });
  }

  if (!cachedAuth) cachedAuth = getAuth(cachedApp);
  if (!cachedDb) cachedDb = getDatabase(cachedApp);

  return {
    app: cachedApp,
    auth: cachedAuth,
    db: cachedDb,
    config,
  };
}

export interface AuthenticatedContext {
  auth: Auth;
  db: Database;
  user: DecodedIdToken;
  config: FirebaseServerConfig;
}

export async function authenticateRequest(
  req: ApiRequest
): Promise<
  | { ok: true; ctx: AuthenticatedContext }
  | { ok: false; status: number; code: string; error: string }
> {
  const services = getFirebaseAdminServices();
  if (!services) {
    return {
      ok: false,
      status: 503,
      code: 'FIREBASE_NOT_CONFIGURED',
      error:
        'Online multiplayer backend is not configured yet. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and FIREBASE_DATABASE_URL.',
    };
  }

  const token = getBearerToken(req);
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      error: 'Authentication required. Please sign in with Google.',
    };
  }

  try {
    const decoded = await services.auth.verifyIdToken(token, true);
    return {
      ok: true,
      ctx: {
        auth: services.auth,
        db: services.db,
        user: decoded,
        config: services.config,
      },
    };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
    const isExpired =
      code === 'auth/id-token-expired' || code === 'auth/id-token-revoked';
    return {
      ok: false,
      status: 401,
      code: isExpired ? 'AUTH_EXPIRED' : 'INVALID_SESSION',
      error: isExpired
        ? 'Your authentication session expired. Please sign in with Google again.'
        : 'Invalid authentication token. Please sign in again.',
    };
  }
}

function sanitizeRateKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

/**
 * Hydrates the RTDB path via a temporary listener before running `.transaction(...)` so
 * serverless / cold Admin SDK instances never abort early on the uncached `current === null` pass.
 */
export async function runRtdbTransaction<T = unknown>(
  ref: Reference,
  updater: (current: T | null) => T | null | undefined
): ReturnType<Reference['transaction']> {
  const noop = () => {};
  ref.on('value', noop);
  try {
    await ref.once('value');
    return await ref.transaction(
      (cur: unknown) => updater((cur as T | null) ?? null),
      undefined,
      false
    );
  } finally {
    ref.off('value', noop);
  }
}

/**
 * Enforces per-user/action rate limiting using an in-memory fast check backed by
 * Firebase Realtime Database `/rateLimits/{key}` transactions across serverless instances.
 */
export async function enforceRateLimit(
  db: Database,
  key: string,
  windowSeconds: number,
  maxRequests: number
): Promise<boolean> {
  if (!checkInMemoryRateLimit(key, windowSeconds, maxRequests)) {
    return false;
  }

  try {
    const safeKey = sanitizeRateKey(key);
    const ref = db.ref(`rateLimits/${safeKey}`);
    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    const tx = await runRtdbTransaction<{ windowStart?: number; count?: number }>(
      ref,
      (rec) => {
        if (!rec || typeof rec.windowStart !== 'number' || now - rec.windowStart >= windowMs) {
          return { windowStart: now, count: 1 };
        }

        const curCount = typeof rec.count === 'number' ? rec.count : 0;
        if (curCount >= maxRequests) {
          return; // abort -> not committed
        }
        return { windowStart: rec.windowStart, count: curCount + 1 };
      }
    );

    return tx.committed;
  } catch {
    // Allow request if RTDB rate-limit transaction is temporarily unavailable so gameplay isn't blocked.
    return true;
  }
}
