import type { DecodedIdToken } from 'firebase-admin/auth';
import { ServerValue, type Database } from 'firebase-admin/database';
import type {
  FirebaseRoomPlayerRecord,
  FirebaseRoomRecord,
  MatchHistoryRecord,
  PlayerStatsRecord,
  RoomSnapshot,
  UserProfile,
} from '../../src/shared/OnlineTypes';
import { buildRoomSnapshot } from '../../src/shared/OnlineSnapshotMapper';
import {
  isProfileComplete,
  isValidGender,
  normalizeDisplayName,
  ProfileGender,
  validateDisplayName,
  validateUsernameFormat,
} from '../../src/shared/ProfileValidation';
import { runRtdbTransaction } from './firebaseAdmin';

export { buildRoomSnapshot };

interface NicknameClaimRecord {
  uid: string;
  createdAt: number | object;
}

function extractNicknameOwnerUid(val: unknown): string | null {
  if (typeof val === 'string' && val.trim()) {
    return val;
  }
  if (val && typeof val === 'object' && 'uid' in val) {
    const uid = (val as { uid?: unknown }).uid;
    if (typeof uid === 'string' && uid.trim()) {
      return uid;
    }
  }
  return null;
}

function toIsoTimestamp(val: unknown, fallbackIso: string): string {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return new Date(val).toISOString();
  }
  if (typeof val === 'string' && val.trim()) {
    return val;
  }
  return fallbackIso;
}

function normalizeUserProfileRecord(
  uid: string,
  raw: (Partial<UserProfile> & { updatedAt?: unknown; createdAt?: unknown }) | null | undefined,
  fallback: {
    displayName: string;
    email: string | null;
    photoURL: string | null;
    nowIso: string;
  }
): UserProfile {
  const displayName =
    typeof raw?.displayName === 'string' ? raw.displayName : fallback.displayName;
  const rawUsername = typeof raw?.username === 'string' ? raw.username.trim().toLowerCase() : '';
  const normalizedUsername =
    typeof raw?.normalizedUsername === 'string' && raw.normalizedUsername.trim()
      ? raw.normalizedUsername.trim().toLowerCase()
      : rawUsername;
  const gender: ProfileGender | null = isValidGender(raw?.gender) ? raw.gender : null;
  const createdAt = toIsoTimestamp(raw?.createdAt, fallback.nowIso);
  const updatedAt = toIsoTimestamp(raw?.updatedAt, createdAt);
  const nickname =
    rawUsername ||
    (typeof raw?.nickname === 'string' ? raw.nickname : '');

  const profileCompleted = isProfileComplete({
    displayName,
    username: rawUsername,
    normalizedUsername,
    gender,
    profileCompleted: raw?.profileCompleted === true,
  });

  return {
    uid,
    displayName,
    username: rawUsername,
    normalizedUsername,
    gender,
    email: raw?.email ?? fallback.email,
    photoURL: raw?.photoURL ?? fallback.photoURL,
    nickname,
    profileCompleted,
    createdAt,
    updatedAt,
    totalMatches: typeof raw?.totalMatches === 'number' ? raw.totalMatches : 0,
    wins: typeof raw?.wins === 'number' ? raw.wins : 0,
    losses: typeof raw?.losses === 'number' ? raw.losses : 0,
    draws: typeof raw?.draws === 'number' ? raw.draws : 0,
  };
}

async function claimUniqueUsername(
  db: Database,
  uid: string,
  normalizedUsername: string
): Promise<boolean> {
  const lower = normalizedUsername.toLowerCase();
  const ref = db.ref(`nicknames/${lower}`);
  const tx = await runRtdbTransaction<NicknameClaimRecord | string>(ref, (current) => {
    const owner = extractNicknameOwnerUid(current);
    if (current === null) {
      return {
        uid,
        createdAt: ServerValue.TIMESTAMP,
      };
    }
    if (owner === uid) {
      if (typeof current === 'object' && current !== null && 'createdAt' in current) {
        return current;
      }
      return {
        uid,
        createdAt: ServerValue.TIMESTAMP,
      };
    }
    return; // Abort: claimed by another player
  });
  return tx.committed;
}

async function releaseUniqueUsername(
  db: Database,
  uid: string,
  normalizedUsername: string
): Promise<void> {
  const lower = normalizedUsername.trim().toLowerCase();
  if (!lower) return;
  const ref = db.ref(`nicknames/${lower}`);
  await runRtdbTransaction<NicknameClaimRecord | string>(ref, (current) => {
    const owner = extractNicknameOwnerUid(current);
    if (owner === uid) {
      return null;
    }
    return current ?? undefined;
  });
}

function derivePrefilledDisplayName(user: DecodedIdToken): string {
  const rawName =
    (typeof user.name === 'string' && user.name) ||
    (user.email ? user.email.split('@')[0] : '') ||
    '';
  const trimmed = normalizeDisplayName(rawName).slice(0, 24);
  return validateDisplayName(trimmed).valid ? trimmed : '';
}

/**
 * Ensures an authenticated Firebase Auth user has corresponding `/users/{uid}` and
 * `/playerStats/{uid}` records on first login. Never marks an incomplete account as
 * completed and never overwrites existing custom profile fields or stats.
 */
export async function ensureUserProfile(
  db: Database,
  user: DecodedIdToken
): Promise<UserProfile> {
  const userRef = db.ref(`users/${user.uid}`);
  const statsRef = db.ref(`playerStats/${user.uid}`);
  const snap = await userRef.get();

  const nowIso = new Date().toISOString();
  const prefilledName = derivePrefilledDisplayName(user);
  const email = typeof user.email === 'string' ? user.email : null;
  const photoURL = typeof user.picture === 'string' ? user.picture : null;

  if (snap.exists()) {
    const existing = (snap.val() ?? {}) as Partial<UserProfile> & {
      updatedAt?: unknown;
      createdAt?: unknown;
    };

    const normalized = normalizeUserProfileRecord(user.uid, existing, {
      displayName: prefilledName,
      email,
      photoURL,
      nowIso,
    });

    const patch: Record<string, unknown> = {};
    if ((existing.email ?? null) !== email) patch.email = email;
    if ((existing.photoURL ?? null) !== photoURL) patch.photoURL = photoURL;
    if (Boolean(existing.profileCompleted) !== normalized.profileCompleted) {
      patch.profileCompleted = normalized.profileCompleted;
    }
    if (existing.username === undefined) patch.username = normalized.username;
    if (existing.normalizedUsername === undefined) {
      patch.normalizedUsername = normalized.normalizedUsername;
    }

    if (Object.keys(patch).length > 0) {
      await userRef.update(patch);
    }

    const statsSnap = await statsRef.get();
    if (!statsSnap.exists()) {
      const statsInit: PlayerStatsRecord = {
        uid: user.uid,
        totalMatches: normalized.totalMatches,
        wins: normalized.wins,
        losses: normalized.losses,
        draws: normalized.draws,
        totalShots: 0,
        totalKnockouts: 0,
        updatedAt: nowIso,
      };
      await statsRef.set(statsInit);
    }

    return normalized;
  }

  const createdRecord = {
    uid: user.uid,
    displayName: prefilledName,
    username: '',
    normalizedUsername: '',
    gender: null,
    email,
    photoURL,
    nickname: '',
    profileCompleted: false,
    createdAt: nowIso,
    updatedAt: ServerValue.TIMESTAMP,
    totalMatches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
  };

  await runRtdbTransaction(userRef, (cur) => cur ?? createdRecord);
  const statsInit: PlayerStatsRecord = {
    uid: user.uid,
    totalMatches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    totalShots: 0,
    totalKnockouts: 0,
    updatedAt: nowIso,
  };
  await runRtdbTransaction<PlayerStatsRecord>(statsRef, (cur) => cur ?? statsInit);

  const finalSnap = await userRef.get();
  const saved = finalSnap.exists()
    ? (finalSnap.val() as Partial<UserProfile> & { updatedAt?: unknown; createdAt?: unknown })
    : undefined;

  return normalizeUserProfileRecord(user.uid, saved, {
    displayName: prefilledName,
    email,
    photoURL,
    nowIso,
  });
}

export interface UsernameAvailabilityResult {
  valid: boolean;
  available: boolean;
  normalized: string;
  reason: string | null;
}

export async function checkUsernameAvailability(
  db: Database,
  uid: string,
  rawUsername: string
): Promise<UsernameAvailabilityResult> {
  const format = validateUsernameFormat(rawUsername);
  if (!format.valid) {
    return {
      valid: false,
      available: false,
      normalized: format.normalized,
      reason: format.error,
    };
  }

  const snap = await db.ref(`nicknames/${format.normalized}`).get();
  if (!snap.exists()) {
    return {
      valid: true,
      available: true,
      normalized: format.normalized,
      reason: null,
    };
  }

  const ownerUid = extractNicknameOwnerUid(snap.val());
  const ownedBySelf = ownerUid === null || ownerUid === uid;
  return {
    valid: true,
    available: ownedBySelf,
    normalized: format.normalized,
    reason: ownedBySelf ? null : 'This username is already taken.',
  };
}

export type ProfileMutationResult =
  | { ok: true; profile: UserProfile }
  | { ok: false; status: number; code: string; error: string };

export async function completeUserProfile(
  db: Database,
  user: DecodedIdToken,
  input: {
    displayName: string;
    username: string;
    gender: ProfileGender;
  }
): Promise<ProfileMutationResult> {
  const nameCheck = validateDisplayName(input.displayName);
  if (!nameCheck.valid) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_DISPLAY_NAME',
      error: nameCheck.error ?? 'Invalid display name.',
    };
  }

  const usernameCheck = validateUsernameFormat(input.username);
  if (!usernameCheck.valid) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_USERNAME',
      error: usernameCheck.error ?? 'Invalid username.',
    };
  }

  if (!isValidGender(input.gender)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_GENDER',
      error: 'Please select a gender option.',
    };
  }

  const current = await ensureUserProfile(db, user);
  const nextNormalized = usernameCheck.normalized;
  const oldNormalized = (
    current.normalizedUsername ||
    current.username ||
    ''
  )
    .trim()
    .toLowerCase();

  const claimed = await claimUniqueUsername(db, user.uid, nextNormalized);
  if (!claimed) {
    return {
      ok: false,
      status: 409,
      code: 'USERNAME_TAKEN',
      error: 'That username is already taken. Please choose another.',
    };
  }

  const userRef = db.ref(`users/${user.uid}`);
  let committed = false;

  try {
    const tx = await runRtdbTransaction<Record<string, unknown>>(userRef, (existing) => {
      const base = existing && typeof existing === 'object' ? existing : {};
      return {
        ...base,
        uid: user.uid,
        displayName: nameCheck.normalized,
        username: nextNormalized,
        normalizedUsername: nextNormalized,
        nickname: nextNormalized,
        gender: input.gender,
        email: current.email,
        photoURL: current.photoURL,
        profileCompleted: true,
        createdAt: base.createdAt ?? current.createdAt,
        updatedAt: ServerValue.TIMESTAMP,
        totalMatches: typeof base.totalMatches === 'number' ? base.totalMatches : current.totalMatches,
        wins: typeof base.wins === 'number' ? base.wins : current.wins,
        losses: typeof base.losses === 'number' ? base.losses : current.losses,
        draws: typeof base.draws === 'number' ? base.draws : current.draws,
      };
    });
    committed = tx.committed;
  } catch (err) {
    if (oldNormalized !== nextNormalized) {
      await releaseUniqueUsername(db, user.uid, nextNormalized).catch(() => {});
    }
    throw err;
  }

  if (!committed) {
    if (oldNormalized !== nextNormalized) {
      await releaseUniqueUsername(db, user.uid, nextNormalized).catch(() => {});
    }
    return {
      ok: false,
      status: 500,
      code: 'PROFILE_SAVE_FAILED',
      error: 'Could not save user profile. Please try again.',
    };
  }

  if (oldNormalized && oldNormalized !== nextNormalized) {
    await releaseUniqueUsername(db, user.uid, oldNormalized).catch(() => {});
  }

  const freshSnap = await userRef.get();
  const profile = normalizeUserProfileRecord(
    user.uid,
    freshSnap.val() as Partial<UserProfile> & { updatedAt?: unknown; createdAt?: unknown },
    {
      displayName: nameCheck.normalized,
      email: current.email,
      photoURL: current.photoURL,
      nowIso: new Date().toISOString(),
    }
  );

  return { ok: true, profile };
}

export async function updateUserProfile(
  db: Database,
  user: DecodedIdToken,
  input: {
    displayName?: string;
    username?: string;
    nickname?: string;
    gender?: ProfileGender;
  }
): Promise<ProfileMutationResult> {
  const current = await ensureUserProfile(db, user);

  let nextDisplayName = current.displayName;
  if (input.displayName !== undefined) {
    const nameCheck = validateDisplayName(input.displayName);
    if (!nameCheck.valid) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_DISPLAY_NAME',
        error: nameCheck.error ?? 'Invalid display name.',
      };
    }
    nextDisplayName = nameCheck.normalized;
  }

  const rawUsernameInput = input.username !== undefined ? input.username : input.nickname;
  let nextUsername = current.username;
  if (rawUsernameInput !== undefined) {
    const usernameCheck = validateUsernameFormat(rawUsernameInput);
    if (!usernameCheck.valid) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_USERNAME',
        error: usernameCheck.error ?? 'Invalid username.',
      };
    }
    nextUsername = usernameCheck.normalized;
  }

  let nextGender = current.gender;
  if (input.gender !== undefined) {
    if (!isValidGender(input.gender)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_GENDER',
        error: 'Invalid gender selection.',
      };
    }
    nextGender = input.gender;
  }

  const oldNormalized = (current.normalizedUsername || current.username || '').trim().toLowerCase();
  const nextNormalized = nextUsername.trim().toLowerCase();

  if (nextNormalized && nextNormalized !== oldNormalized) {
    const claimed = await claimUniqueUsername(db, user.uid, nextNormalized);
    if (!claimed) {
      return {
        ok: false,
        status: 409,
        code: 'USERNAME_TAKEN',
        error: 'That username is already taken. Please choose another.',
      };
    }
  }

  const nextComplete = isProfileComplete({
    displayName: nextDisplayName,
    username: nextUsername,
    normalizedUsername: nextNormalized,
    gender: nextGender,
    profileCompleted: true,
  });

  const userRef = db.ref(`users/${user.uid}`);
  let committed = false;

  try {
    const tx = await runRtdbTransaction<Record<string, unknown>>(userRef, (existing) => {
      const base = existing && typeof existing === 'object' ? existing : {};
      return {
        ...base,
        uid: user.uid,
        displayName: nextDisplayName,
        username: nextUsername,
        normalizedUsername: nextNormalized,
        nickname: nextUsername || (typeof base.nickname === 'string' ? base.nickname : ''),
        gender: nextGender,
        email: current.email,
        photoURL: current.photoURL,
        profileCompleted: nextComplete,
        createdAt: base.createdAt ?? current.createdAt,
        updatedAt: ServerValue.TIMESTAMP,
        totalMatches: typeof base.totalMatches === 'number' ? base.totalMatches : current.totalMatches,
        wins: typeof base.wins === 'number' ? base.wins : current.wins,
        losses: typeof base.losses === 'number' ? base.losses : current.losses,
        draws: typeof base.draws === 'number' ? base.draws : current.draws,
      };
    });
    committed = tx.committed;
  } catch (err) {
    if (nextNormalized && nextNormalized !== oldNormalized) {
      await releaseUniqueUsername(db, user.uid, nextNormalized).catch(() => {});
    }
    throw err;
  }

  if (!committed) {
    if (nextNormalized && nextNormalized !== oldNormalized) {
      await releaseUniqueUsername(db, user.uid, nextNormalized).catch(() => {});
    }
    return {
      ok: false,
      status: 500,
      code: 'PROFILE_UPDATE_FAILED',
      error: 'Could not update profile.',
    };
  }

  if (oldNormalized && nextNormalized && oldNormalized !== nextNormalized) {
    await releaseUniqueUsername(db, user.uid, oldNormalized).catch(() => {});
  }

  const freshSnap = await userRef.get();
  const profile = normalizeUserProfileRecord(
    user.uid,
    freshSnap.val() as Partial<UserProfile> & { updatedAt?: unknown; createdAt?: unknown },
    {
      displayName: nextDisplayName,
      email: current.email,
      photoURL: current.photoURL,
      nowIso: new Date().toISOString(),
    }
  );

  return { ok: true, profile };
}

export async function fetchUserMatchHistory(
  db: Database,
  uid: string,
  limit = 15
): Promise<MatchHistoryRecord[]> {
  const snap = await db.ref(`matchHistory/${uid}`).limitToLast(limit).get();
  if (!snap.exists()) return [];
  const raw = snap.val() as Record<string, MatchHistoryRecord>;
  return Object.values(raw).sort((a, b) => Date.parse(b.playedAt) - Date.parse(a.playedAt));
}

export async function fetchRoomRecordByCode(
  db: Database,
  roomCode: string
): Promise<FirebaseRoomRecord | null> {
  const cleanCode = roomCode.trim().toUpperCase();
  if (!cleanCode) return null;
  const snap = await db.ref(`rooms/${cleanCode}`).get();
  if (!snap.exists()) return null;
  return snap.val() as FirebaseRoomRecord;
}

export async function fetchRoomSnapshotByCode(
  db: Database,
  roomCode: string
): Promise<RoomSnapshot | null> {
  const rec = await fetchRoomRecordByCode(db, roomCode);
  return buildRoomSnapshot(rec);
}

export async function resolveRoomCodeForMatchId(
  db: Database,
  matchId: string
): Promise<string | null> {
  const idxSnap = await db.ref(`matchIndex/${matchId}`).get();
  if (!idxSnap.exists()) return null;
  const val = idxSnap.val();
  return typeof val === 'string' && val ? val : null;
}

/**
 * Idempotently commits final match history and increments verified career statistics in
 * `/users/{uid}`, `/playerStats/{uid}`, and `/matchHistory/{uid}/{matchId}` when a match ends.
 */
export async function recordCompletedMatch(
  db: Database,
  roomRecord: FirebaseRoomRecord
): Promise<void> {
  const gs = roomRecord.gameState;
  if (!gs || gs.status !== 'COMPLETED') return;

  // Idempotency guard against concurrent retries committing stats twice
  const guardRef = db.ref(`matchIndex/${gs.matchId}_statsRecorded`);
  const guardTx = await runRtdbTransaction<boolean>(guardRef, (cur) => (cur ? undefined : true));
  if (!guardTx.committed) return;

  const p1 = Object.values(roomRecord.players ?? {}).find((p) => p.slot === 1);
  const p2 = Object.values(roomRecord.players ?? {}).find((p) => p.slot === 2);
  if (!p1 || !p2) return;

  const nowIso = gs.completedAt || new Date().toISOString();
  const isDraw = gs.resultType === 'DRAW';
  const p1Win = gs.winnerUid === p1.uid;
  const p2Win = gs.winnerUid === p2.uid;

  const writePlayerOutcome = async (
    player: FirebaseRoomPlayerRecord,
    opponent: FirebaseRoomPlayerRecord,
    didWin: boolean,
    myScore: number,
    oppScore: number,
    shots: number,
    knockouts: number
  ) => {
    const outcome: MatchHistoryRecord['outcome'] = isDraw ? 'DRAW' : didWin ? 'WIN' : 'LOSS';
    const historyEntry: MatchHistoryRecord = {
      matchId: gs.matchId,
      roomCode: roomRecord.roomCode,
      arenaId: roomRecord.gameSettings.arenaId,
      opponentUid: opponent.uid,
      opponentNickname: opponent.username || opponent.nickname,
      myScore,
      opponentScore: oppScore,
      winnerUid: gs.winnerUid ?? null,
      outcome,
      resultType: gs.resultType ?? 'DRAW',
      resultReason: gs.resultReason || 'Match completed.',
      turnsPlayed: roomRecord.currentTurnNumber,
      shotsCount: shots,
      playedAt: nowIso,
    };

    await db.ref(`matchHistory/${player.uid}/${gs.matchId}`).set(historyEntry);

    await runRtdbTransaction<UserProfile>(db.ref(`users/${player.uid}`), (u) => {
      if (!u || typeof u !== 'object') return u ?? undefined;
      return {
        ...u,
        totalMatches: (u.totalMatches ?? 0) + 1,
        wins: (u.wins ?? 0) + (didWin ? 1 : 0),
        losses: (u.losses ?? 0) + (!isDraw && !didWin ? 1 : 0),
        draws: (u.draws ?? 0) + (isDraw ? 1 : 0),
      };
    });

    await runRtdbTransaction<PlayerStatsRecord>(db.ref(`playerStats/${player.uid}`), (cur) => {
      const s: PlayerStatsRecord =
        cur && typeof cur === 'object'
          ? cur
          : {
              uid: player.uid,
              totalMatches: 0,
              wins: 0,
              losses: 0,
              draws: 0,
              totalShots: 0,
              totalKnockouts: 0,
              updatedAt: nowIso,
            };
      return {
        ...s,
        uid: player.uid,
        totalMatches: (s.totalMatches ?? 0) + 1,
        wins: (s.wins ?? 0) + (didWin ? 1 : 0),
        losses: (s.losses ?? 0) + (!isDraw && !didWin ? 1 : 0),
        draws: (s.draws ?? 0) + (isDraw ? 1 : 0),
        totalShots: (s.totalShots ?? 0) + shots,
        totalKnockouts: (s.totalKnockouts ?? 0) + knockouts,
        updatedAt: nowIso,
      };
    });
  };

  await Promise.all([
    writePlayerOutcome(
      p1,
      p2,
      p1Win,
      gs.player1Score,
      gs.player2Score,
      gs.penStates.player1.shotsCount,
      gs.penStates.player1.knockoutsCount
    ),
    writePlayerOutcome(
      p2,
      p1,
      p2Win,
      gs.player2Score,
      gs.player1Score,
      gs.penStates.player2.shotsCount,
      gs.penStates.player2.knockoutsCount
    ),
  ]);
}
