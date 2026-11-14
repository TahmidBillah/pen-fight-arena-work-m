import { z } from 'zod';
import {
  ARENA_ORDER,
  ArenaId,
  DEFAULT_ARENA,
  DEFAULT_DESHI_VARIANT,
  DESHI_COLOR_VARIANTS,
  DeshiColorVariantId,
  PEN_ORDER,
  PenTypeId,
  STARTER_PEN,
} from '../../../src/utils/Constants';
import type {
  FirebaseRoomPlayerRecord,
  FirebaseRoomRecord,
} from '../../../src/shared/OnlineTypes';
import { authenticateRequest, enforceRateLimit, runRtdbTransaction } from '../firebaseAdmin';
import {
  ApiRequest,
  ApiResponse,
  generateSecureRoomCode,
  getMethod,
  getQueryParam,
  parseValidatedBody,
  sendError,
} from '../http';
import {
  buildRoomSnapshot,
  ensureUserProfile,
  fetchRoomRecordByCode,
  recordCompletedMatch,
} from '../roomData';
import { isProfileComplete } from '../../../src/shared/ProfileValidation';

const arenaSchema = z.enum(ARENA_ORDER as [ArenaId, ...ArenaId[]]);
const penSchema = z.enum(PEN_ORDER as [PenTypeId, ...PenTypeId[]]);
const deshiVariantSchema = z.enum(
  DESHI_COLOR_VARIANTS.map((v) => v.id) as [DeshiColorVariantId, ...DeshiColorVariantId[]]
);
const timerSchema = z.union([
  z.literal(0),
  z.literal(10),
  z.literal(15),
  z.literal(20),
  z.literal(30),
]);
const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/, 'Invalid room code. Enter a 6-character alphanumeric code.');

const createRoomSchema = z.object({
  arenaId: arenaSchema.default(DEFAULT_ARENA),
  turnTimerSeconds: timerSchema.default(15),
  penType: penSchema.default(STARTER_PEN),
  deshiVariant: deshiVariantSchema.default(DEFAULT_DESHI_VARIANT),
});

const joinRoomSchema = z.object({
  roomCode: roomCodeSchema,
  penType: penSchema.default(STARTER_PEN),
  deshiVariant: deshiVariantSchema.default(DEFAULT_DESHI_VARIANT),
});

const readyRoomSchema = z.object({
  roomCode: roomCodeSchema,
  isReady: z.boolean().optional(),
  penType: penSchema.optional(),
  deshiVariant: deshiVariantSchema.optional(),
  arenaId: arenaSchema.optional(),
  turnTimerSeconds: timerSchema.optional(),
});

const leaveRoomSchema = z.object({
  roomCode: roomCodeSchema,
});

const ROOM_TTL_MS = 30 * 60 * 1000;

export async function handleRoomCreate(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (getMethod(req) !== 'POST') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.error);
    return;
  }
  const { db, user } = auth.ctx;

  const allowed = await enforceRateLimit(db, `room_create:${user.uid}`, 60, 10);
  if (!allowed) {
    sendError(res, 429, 'RATE_LIMITED', 'Too many rooms created. Please wait a minute.');
    return;
  }

  const bodyRes = await parseValidatedBody(req, createRoomSchema);
  if (bodyRes.error || !bodyRes.data) {
    sendError(res, 400, 'INVALID_REQUEST', bodyRes.error ?? 'Invalid room configuration.');
    return;
  }

  try {
    const profile = await ensureUserProfile(db, user);
    if (!isProfileComplete(profile)) {
      sendError(
        res,
        403,
        'PROFILE_INCOMPLETE',
        'Complete your profile setup (Name, Username, and Gender) before playing online.'
      );
      return;
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + ROOM_TTL_MS).toISOString();

    let createdRecord: FirebaseRoomRecord | null = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      const code = generateSecureRoomCode();
      const hostPlayer: FirebaseRoomPlayerRecord = {
        uid: user.uid,
        slot: 1,
        team: 'blue',
        penType: bodyRes.data.penType,
        deshiVariant: bodyRes.data.deshiVariant,
        isReady: false,
        joinedAt: nowIso,
        displayName: profile.displayName,
        username: profile.username,
        photoURL: profile.photoURL,
        nickname: profile.username || profile.nickname,
        totalMatches: profile.totalMatches,
        wins: profile.wins,
        losses: profile.losses,
        draws: profile.draws,
        connection: {
          online: true,
          lastSeenAt: nowMs,
        },
      };

      const candidate: FirebaseRoomRecord = {
        roomCode: code,
        hostUid: user.uid,
        status: 'WAITING',
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt: expiresIso,
        maxPlayers: 2,
        currentTurnUid: null,
        currentTurnNumber: 0,
        gameSettings: {
          arenaId: bodyRes.data.arenaId,
          turnTimerSeconds: bodyRes.data.turnTimerSeconds,
        },
        players: {
          [user.uid]: hostPlayer,
        },
        gameState: null,
        lastShot: null,
      };

      const tx = await runRtdbTransaction<FirebaseRoomRecord>(
        db.ref(`rooms/${code}`),
        (existing) => {
          if (existing !== null && existing !== undefined) {
            const isStaleEnded =
              (existing.status === 'CANCELLED' ||
                existing.status === 'EXPIRED' ||
                existing.status === 'COMPLETED') &&
              Date.parse(existing.updatedAt || existing.createdAt) < nowMs - 3600_000;
            if (!isStaleEnded) {
              return; // Abort collision
            }
          }
          return candidate;
        }
      );

      if (tx.committed) {
        createdRecord = tx.snapshot.val() as FirebaseRoomRecord;
        break;
      }
    }

    if (!createdRecord) {
      sendError(res, 500, 'ROOM_CODE_COLLISION', 'Could not allocate unique room code.');
      return;
    }

    const snapshot = buildRoomSnapshot(createdRecord);
    if (!snapshot) {
      sendError(res, 500, 'ROOM_LOAD_FAILED', 'Room created but snapshot could not be loaded.');
      return;
    }

    res.status(201).json({ ok: true, snapshot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create private room.';
    sendError(res, 500, 'ROOM_CREATE_FAILED', msg);
  }
}

export async function handleRoomJoin(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (getMethod(req) !== 'POST') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.error);
    return;
  }
  const { db, user } = auth.ctx;

  const allowed = await enforceRateLimit(db, `room_join:${user.uid}`, 30, 12);
  if (!allowed) {
    sendError(res, 429, 'RATE_LIMITED', 'Too many join attempts. Please wait a moment.');
    return;
  }

  const bodyRes = await parseValidatedBody(req, joinRoomSchema);
  if (bodyRes.error || !bodyRes.data) {
    sendError(
      res,
      400,
      'INVALID_ROOM_CODE',
      bodyRes.error ?? 'Invalid room code. Enter a 6-character code.'
    );
    return;
  }

  const { roomCode, penType, deshiVariant } = bodyRes.data;

  try {
    const profile = await ensureUserProfile(db, user);
    if (!isProfileComplete(profile)) {
      sendError(
        res,
        403,
        'PROFILE_INCOMPLETE',
        'Complete your profile setup (Name, Username, and Gender) before joining an online room.'
      );
      return;
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const reject: { code: string | null; message: string } = { code: null, message: '' };

    const tx = await runRtdbTransaction<FirebaseRoomRecord>(
      db.ref(`rooms/${roomCode}`),
      (current) => {
      reject.code = null;
      reject.message = '';

      if (!current || typeof current !== 'object') {
        reject.code = 'ROOM_NOT_FOUND';
        reject.message = `Room "${roomCode}" was not found. Check the code and try again.`;
        return;
      }

      const room = current as FirebaseRoomRecord;
      const expiresMs = Date.parse(room.expiresAt || '');
      if (Number.isFinite(expiresMs) && expiresMs <= nowMs && room.status === 'WAITING') {
        reject.code = 'ROOM_EXPIRED';
        reject.message = `Room "${roomCode}" has expired.`;
        return;
      }

      const playersMap = room.players ?? {};
      const alreadyMember = Boolean(playersMap[user.uid]);

      if (alreadyMember) {
        // Idempotent reconnect for existing room member
        const existingPlayer = playersMap[user.uid];
        return {
          ...room,
          updatedAt: nowIso,
          players: {
            ...playersMap,
            [user.uid]: {
              ...existingPlayer,
              penType: room.status === 'WAITING' ? penType : existingPlayer.penType,
              deshiVariant: room.status === 'WAITING' ? deshiVariant : existingPlayer.deshiVariant,
              displayName: profile.displayName,
              username: profile.username,
              photoURL: profile.photoURL,
              nickname: profile.username || profile.nickname,
              totalMatches: profile.totalMatches,
              wins: profile.wins,
              losses: profile.losses,
              draws: profile.draws,
              connection: {
                online: true,
                lastSeenAt: nowMs,
              },
            },
          },
        };
      }

      if (room.status !== 'WAITING') {
        reject.code = 'ROOM_UNAVAILABLE';
        reject.message =
          room.status === 'IN_PROGRESS'
            ? `Room "${roomCode}" is already in a match.`
            : `Room "${roomCode}" is no longer accepting players.`;
        return;
      }

      const existingCount = Object.keys(playersMap).length;
      if (existingCount >= (room.maxPlayers || 2)) {
        reject.code = 'ROOM_FULL';
        reject.message = `Room "${roomCode}" is already full (2/2 players).`;
        return;
      }

      const occupiedSlots = new Set(Object.values(playersMap).map((p) => p.slot));
      const assignedSlot: 1 | 2 = occupiedSlots.has(1) ? 2 : 1;

      const guestPlayer: FirebaseRoomPlayerRecord = {
        uid: user.uid,
        slot: assignedSlot,
        team: assignedSlot === 1 ? 'blue' : 'red',
        penType,
        deshiVariant,
        isReady: false,
        joinedAt: nowIso,
        displayName: profile.displayName,
        username: profile.username,
        photoURL: profile.photoURL,
        nickname: profile.username || profile.nickname,
        totalMatches: profile.totalMatches,
        wins: profile.wins,
        losses: profile.losses,
        draws: profile.draws,
        connection: {
          online: true,
          lastSeenAt: nowMs,
        },
      };

      return {
        ...room,
        updatedAt: nowIso,
        players: {
          ...playersMap,
          [user.uid]: guestPlayer,
        },
      };
    });

    if (!tx.committed) {
      const code = reject.code ?? 'JOIN_FAILED';
      const status =
        code === 'ROOM_NOT_FOUND'
          ? 404
          : code === 'ROOM_FULL' || code === 'ROOM_UNAVAILABLE' || code === 'ROOM_EXPIRED'
            ? 409
            : 400;
      sendError(res, status, code, reject.message || 'Could not join room.');
      return;
    }

    const updatedRecord = tx.snapshot.val() as FirebaseRoomRecord;
    const snapshot = buildRoomSnapshot(updatedRecord);
    if (!snapshot) {
      sendError(res, 500, 'ROOM_LOAD_FAILED', 'Joined room but failed to load room state.');
      return;
    }

    res.status(200).json({ ok: true, snapshot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to join room.';
    sendError(res, 500, 'ROOM_JOIN_FAILED', msg);
  }
}

export async function handleRoomDetail(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (getMethod(req) !== 'GET') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is allowed.');
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.error);
    return;
  }
  const { db, user } = auth.ctx;

  const codeParam = getQueryParam(req, 'code') || getQueryParam(req, 'roomCode');
  if (!codeParam || !roomCodeSchema.safeParse(codeParam).success) {
    sendError(res, 400, 'INVALID_ROOM_CODE', 'Provide a valid 6-character room code.');
    return;
  }

  try {
    const record = await fetchRoomRecordByCode(db, codeParam);
    const snapshot = buildRoomSnapshot(record);
    if (!snapshot) {
      sendError(res, 404, 'ROOM_NOT_FOUND', 'Room not found.');
      return;
    }

    const isMember =
      snapshot.room.hostUid === user.uid || snapshot.players.some((p) => p.uid === user.uid);
    if (!isMember) {
      sendError(res, 403, 'FORBIDDEN', 'You are not a member of this private room.');
      return;
    }

    res.status(200).json({ ok: true, snapshot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load room details.';
    sendError(res, 500, 'ROOM_DETAIL_FAILED', msg);
  }
}

export async function handleRoomReady(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (getMethod(req) !== 'POST') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.error);
    return;
  }
  const { db, user } = auth.ctx;

  const bodyRes = await parseValidatedBody(req, readyRoomSchema);
  if (bodyRes.error || !bodyRes.data) {
    sendError(res, 400, 'INVALID_REQUEST', bodyRes.error ?? 'Invalid ready request.');
    return;
  }

  const payload = bodyRes.data;

  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const reject: { code: string | null; message: string } = { code: null, message: '' };

    const tx = await runRtdbTransaction<FirebaseRoomRecord>(
      db.ref(`rooms/${payload.roomCode}`),
      (current) => {
      reject.code = null;
      reject.message = '';

      if (!current || typeof current !== 'object') {
        reject.code = 'ROOM_NOT_FOUND';
        reject.message = 'Room not found.';
        return;
      }

      const room = current as FirebaseRoomRecord;
      const member = room.players?.[user.uid];
      if (!member) {
        reject.code = 'NOT_A_MEMBER';
        reject.message = 'You are not a player in this room.';
        return;
      }

      if (room.status !== 'WAITING') {
        reject.code = 'ROOM_LOCKED';
        reject.message = 'Cannot change ready state after match has started.';
        return;
      }

      let nextSettings = { ...room.gameSettings };
      let settingsChanged = false;

      if (payload.arenaId !== undefined || payload.turnTimerSeconds !== undefined) {
        if (room.hostUid !== user.uid) {
          reject.code = 'HOST_ONLY';
          reject.message = 'Only the room host can change arena or turn timer.';
          return;
        }
        const candidateArena = payload.arenaId ?? nextSettings.arenaId;
        const candidateTimer = payload.turnTimerSeconds ?? nextSettings.turnTimerSeconds;
        if (
          candidateArena !== nextSettings.arenaId ||
          candidateTimer !== nextSettings.turnTimerSeconds
        ) {
          settingsChanged = true;
          nextSettings = {
            arenaId: candidateArena,
            turnTimerSeconds: candidateTimer,
          };
        }
      }

      const nextPlayers: Record<string, FirebaseRoomPlayerRecord> = {};
      for (const [uid, p] of Object.entries(room.players ?? {})) {
        if (uid === user.uid) {
          nextPlayers[uid] = {
            ...p,
            penType: payload.penType ?? p.penType,
            deshiVariant: payload.deshiVariant ?? p.deshiVariant,
            isReady: settingsChanged ? false : payload.isReady !== undefined ? payload.isReady : p.isReady,
            connection: {
              online: true,
              lastSeenAt: nowMs,
            },
          };
        } else {
          nextPlayers[uid] = {
            ...p,
            isReady: settingsChanged ? false : p.isReady,
          };
        }
      }

      return {
        ...room,
        updatedAt: nowIso,
        gameSettings: nextSettings,
        players: nextPlayers,
      };
    });

    if (!tx.committed) {
      const code = reject.code ?? 'ROOM_READY_FAILED';
      const status =
        code === 'ROOM_NOT_FOUND'
          ? 404
          : code === 'NOT_A_MEMBER' || code === 'HOST_ONLY'
            ? 403
            : code === 'ROOM_LOCKED'
              ? 409
              : 400;
      sendError(res, status, code, reject.message || 'Failed to update ready status.');
      return;
    }

    const updated = tx.snapshot.val() as FirebaseRoomRecord;
    const snapshot = buildRoomSnapshot(updated);
    if (!snapshot) {
      sendError(res, 500, 'ROOM_LOAD_FAILED', 'Failed to reload room state.');
      return;
    }

    res.status(200).json({ ok: true, snapshot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update ready state.';
    sendError(res, 500, 'ROOM_READY_FAILED', msg);
  }
}

export async function handleRoomLeave(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (getMethod(req) !== 'POST') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.error);
    return;
  }
  const { db, user } = auth.ctx;

  const bodyRes = await parseValidatedBody(req, leaveRoomSchema);
  if (bodyRes.error || !bodyRes.data) {
    sendError(res, 400, 'INVALID_REQUEST', bodyRes.error ?? 'Invalid leave request.');
    return;
  }

  const { roomCode } = bodyRes.data;

  try {
    const nowIso = new Date().toISOString();
    const reject: { code: string | null; message: string; forfeited: boolean } = {
      code: null,
      message: '',
      forfeited: false,
    };

    const tx = await runRtdbTransaction<FirebaseRoomRecord>(
      db.ref(`rooms/${roomCode}`),
      (current) => {
      reject.code = null;
      reject.message = '';
      reject.forfeited = false;

      if (!current || typeof current !== 'object') {
        return; // Room already gone
      }

      const room = current as FirebaseRoomRecord;
      const leavingPlayer = room.players?.[user.uid];
      if (!leavingPlayer) {
        reject.code = 'NOT_A_MEMBER';
        reject.message = 'You are not in this room.';
        return;
      }

      if (room.status === 'IN_PROGRESS' && room.gameState && room.gameState.status === 'ACTIVE') {
        reject.forfeited = true;
        const gs = room.gameState;
        const winnerUid = gs.player1Uid === user.uid ? gs.player2Uid : gs.player1Uid;
        const winnerSlot = gs.player1Uid === winnerUid ? 1 : 2;
        const nextSeq = (gs.sequenceNumber || 1) + 1;

        return {
          ...room,
          status: 'COMPLETED',
          updatedAt: nowIso,
          currentTurnUid: winnerUid,
          gameState: {
            ...gs,
            status: 'COMPLETED',
            turnExpiresAt: null,
            player1Score: winnerSlot === 1 ? 1 : 0,
            player2Score: winnerSlot === 2 ? 1 : 0,
            winnerUid,
            resultType: 'FORFEIT',
            resultReason: `${leavingPlayer.nickname} left the match.`,
            version: (gs.version || 1) + 1,
            sequenceNumber: nextSeq,
            updatedAt: nowIso,
            completedAt: nowIso,
            penStates: {
              player1: {
                ...gs.penStates.player1,
                isEliminated: winnerSlot === 2 ? true : gs.penStates.player1.isEliminated,
              },
              player2: {
                ...gs.penStates.player2,
                isEliminated: winnerSlot === 1 ? true : gs.penStates.player2.isEliminated,
              },
            },
          },
          players: {
            ...room.players,
            [user.uid]: {
              ...leavingPlayer,
              connection: { online: false, lastSeenAt: Date.now() },
            },
          },
        };
      }

      if (room.status === 'WAITING') {
        if (room.hostUid === user.uid) {
          return {
            ...room,
            status: 'CANCELLED',
            updatedAt: nowIso,
          };
        }

        const remainingPlayers: Record<string, FirebaseRoomPlayerRecord> = {};
        for (const [uid, p] of Object.entries(room.players ?? {})) {
          if (uid !== user.uid) {
            remainingPlayers[uid] = { ...p, isReady: false };
          }
        }
        return {
          ...room,
          updatedAt: nowIso,
          players: remainingPlayers,
        };
      }

      return room;
    });

    if (!tx.committed && reject.code) {
      sendError(res, 403, reject.code, reject.message);
      return;
    }

    if (tx.committed && reject.forfeited) {
      const committedRoom = tx.snapshot.val() as FirebaseRoomRecord;
      await recordCompletedMatch(db, committedRoom);
    }

    res.status(200).json({ ok: true, left: true, forfeited: reject.forfeited });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to leave room.';
    sendError(res, 500, 'ROOM_LEAVE_FAILED', msg);
  }
}
