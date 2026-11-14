import crypto from 'node:crypto';
import { z } from 'zod';
import {
  createInitialPenStates,
  resolveAuthoritativeShot,
} from '../../../src/shared/AuthoritativePhysics';
import type {
  FirebaseRoomRecord,
  ResolvedShotSummary,
} from '../../../src/shared/OnlineTypes';
import { authenticateRequest, enforceRateLimit, runRtdbTransaction } from '../firebaseAdmin';
import {
  ApiRequest,
  ApiResponse,
  getMethod,
  getQueryParam,
  parseValidatedBody,
  readJsonBody,
  sendError,
} from '../http';
import {
  buildRoomSnapshot,
  fetchRoomRecordByCode,
  recordCompletedMatch,
  resolveRoomCodeForMatchId,
} from '../roomData';
import type { IncomingMessage } from 'node:http';

const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/, 'Invalid 6-character room code.');

const startMatchSchema = z.object({
  roomCode: roomCodeSchema,
  eventId: z.string().min(8).max(80).optional(),
});

const submitShotSchema = z.object({
  roomCode: roomCodeSchema.optional(),
  matchId: z.string().min(8).max(80),
  eventId: z.string().min(8).max(80),
  turnNumber: z.number().int().min(1),
  localAnchor: z.object({
    x: z.number().finite().min(-2).max(2),
    y: z.number().finite().min(-2).max(2),
    z: z.number().finite().min(-4).max(4),
  }),
  dirX: z.number().finite().min(-1.5).max(1.5),
  dirZ: z.number().finite().min(-1.5).max(1.5),
  powerRatio: z.number().finite().min(0.02).max(1.0),
});

const finishMatchSchema = z.object({
  roomCode: roomCodeSchema.optional(),
  matchId: z.string().min(8).max(80),
  mode: z.enum(['timeout', 'forfeit', 'complete']).default('forfeit'),
  eventId: z.string().min(8).max(80).optional(),
  turnNumber: z.number().int().min(1).optional(),
});

async function resolveRoomFromParams(
  db: import('firebase-admin/database').Database,
  roomCode?: string,
  matchId?: string
): Promise<FirebaseRoomRecord | null> {
  if (roomCode) {
    return fetchRoomRecordByCode(db, roomCode);
  }
  if (matchId) {
    const resolvedCode = await resolveRoomCodeForMatchId(db, matchId);
    if (!resolvedCode) return null;
    return fetchRoomRecordByCode(db, resolvedCode);
  }
  return null;
}

export async function handleMatchStart(req: ApiRequest, res: ApiResponse): Promise<void> {
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

  const bodyRes = await parseValidatedBody(req, startMatchSchema);
  if (bodyRes.error || !bodyRes.data) {
    sendError(res, 400, 'INVALID_REQUEST', bodyRes.error ?? 'Invalid start match request.');
    return;
  }

  const { roomCode } = bodyRes.data;
  const eventId = bodyRes.data.eventId ?? crypto.randomUUID();
  const matchId = crypto.randomUUID();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  try {
    const txState: { code: string | null; message: string; alreadyStarted: boolean } = {
      code: null,
      message: '',
      alreadyStarted: false,
    };

    const tx = await runRtdbTransaction<FirebaseRoomRecord>(
      db.ref(`rooms/${roomCode}`),
      (current) => {
      txState.code = null;
      txState.message = '';
      txState.alreadyStarted = false;

      if (!current || typeof current !== 'object') {
        txState.code = 'ROOM_NOT_FOUND';
        txState.message = 'Room not found.';
        return;
      }

      const room = current as FirebaseRoomRecord;
      if (!room.players?.[user.uid]) {
        txState.code = 'NOT_A_MEMBER';
        txState.message = 'You are not a member of this room.';
        return;
      }
      if (room.hostUid !== user.uid) {
        txState.code = 'ONLY_HOST_CAN_START';
        txState.message = 'Only the room host can start the match.';
        return;
      }

      if (room.status === 'IN_PROGRESS' && room.gameState) {
        txState.alreadyStarted = true;
        return; // Idempotent: return existing state below
      }

      if (room.status !== 'WAITING') {
        txState.code = 'ROOM_NOT_WAITING';
        txState.message = 'Room cannot be started in its current state.';
        return;
      }

      const playerList = Object.values(room.players ?? {});
      const p1 = playerList.find((p) => p.slot === 1);
      const p2 = playerList.find((p) => p.slot === 2);

      if (!p1 || !p2) {
        txState.code = 'NEED_TWO_PLAYERS';
        txState.message = 'Waiting for Player 2 to join before starting.';
        return;
      }

      if (!p1.isReady || !p2.isReady) {
        txState.code = 'PLAYERS_NOT_READY';
        txState.message = 'Both players must mark Ready before starting the match.';
        return;
      }

      const initialPenStates = createInitialPenStates(
        { uid: p1.uid, penType: p1.penType, deshiVariant: p1.deshiVariant },
        { uid: p2.uid, penType: p2.penType, deshiVariant: p2.deshiVariant }
      );

      const timerSecs = room.gameSettings?.turnTimerSeconds ?? 15;
      const turnExpiresAt =
        timerSecs > 0 ? new Date(nowMs + timerSecs * 1000).toISOString() : null;

      return {
        ...room,
        status: 'IN_PROGRESS',
        updatedAt: nowIso,
        currentTurnUid: p1.uid,
        currentTurnNumber: 1,
        lastShot: null,
        processedEvents: { [eventId]: 1 },
        gameState: {
          matchId,
          status: 'ACTIVE',
          player1Uid: p1.uid,
          player2Uid: p2.uid,
          turnStartedAt: nowIso,
          turnExpiresAt,
          player1Score: 0,
          player2Score: 0,
          winnerUid: null,
          resultType: null,
          resultReason: null,
          version: 1,
          sequenceNumber: 1,
          penStates: initialPenStates,
          createdAt: nowIso,
          updatedAt: nowIso,
          completedAt: null,
        },
      } satisfies FirebaseRoomRecord;
    });

    if (!tx.committed) {
      if (txState.alreadyStarted) {
        const existingRecord = await fetchRoomRecordByCode(db, roomCode);
        const snapshot = buildRoomSnapshot(existingRecord);
        if (snapshot) {
          res.status(200).json({ ok: true, snapshot, alreadyStarted: true });
          return;
        }
      }

      const code = txState.code ?? 'START_FAILED';
      const status =
        code === 'ROOM_NOT_FOUND'
          ? 404
          : code === 'ONLY_HOST_CAN_START' || code === 'NOT_A_MEMBER'
            ? 403
            : code === 'PLAYERS_NOT_READY' || code === 'ROOM_NOT_WAITING'
              ? 409
              : 400;
      sendError(res, status, code, txState.message || 'Could not start match.');
      return;
    }

    const startedRecord = tx.snapshot.val() as FirebaseRoomRecord;
    if (startedRecord.gameState?.matchId) {
      await db.ref(`matchIndex/${startedRecord.gameState.matchId}`).set(startedRecord.roomCode);
    }

    const snapshot = buildRoomSnapshot(startedRecord);
    if (!snapshot) {
      sendError(res, 500, 'MATCH_LOAD_FAILED', 'Match started but failed to load state.');
      return;
    }

    res.status(200).json({
      ok: true,
      snapshot,
      alreadyStarted: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to start match.';
    sendError(res, 500, 'MATCH_START_FAILED', msg);
  }
}

export async function handleMatchState(req: ApiRequest, res: ApiResponse): Promise<void> {
  const method = getMethod(req);
  if (method !== 'GET' && method !== 'POST') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.error);
    return;
  }
  const { db, user } = auth.ctx;

  let roomCode = getQueryParam(req, 'roomCode') || getQueryParam(req, 'code');
  let matchId = getQueryParam(req, 'matchId');

  if (method === 'POST') {
    try {
      const body = (await readJsonBody(req as ApiRequest & IncomingMessage)) as Record<
        string,
        unknown
      >;
      if (!roomCode && typeof body?.roomCode === 'string') roomCode = body.roomCode;
      if (!matchId && typeof body?.matchId === 'string') matchId = body.matchId;
    } catch {
      sendError(res, 400, 'INVALID_REQUEST', 'Malformed JSON body.');
      return;
    }
  }

  if (!roomCode && !matchId) {
    sendError(res, 400, 'INVALID_MATCH_REQUEST', 'Provide roomCode or matchId.');
    return;
  }

  try {
    const record = await resolveRoomFromParams(db, roomCode, matchId);
    const snapshot = buildRoomSnapshot(record);
    if (!snapshot || !snapshot.match || (matchId && snapshot.match.id !== matchId)) {
      sendError(res, 404, 'MATCH_NOT_FOUND', 'Match not found.');
      return;
    }

    if (snapshot.match.player1Uid !== user.uid && snapshot.match.player2Uid !== user.uid) {
      sendError(res, 403, 'FORBIDDEN', 'You are not a participant in this match.');
      return;
    }

    res.status(200).json({ ok: true, snapshot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load match state.';
    sendError(res, 500, 'MATCH_STATE_FAILED', msg);
  }
}

export async function handleMatchSubmitShot(req: ApiRequest, res: ApiResponse): Promise<void> {
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

  const allowed = await enforceRateLimit(db, `match_shot:${user.uid}`, 30, 15);
  if (!allowed) {
    sendError(res, 429, 'RATE_LIMITED', 'Shot submission rate exceeded. Please wait briefly.');
    return;
  }

  const bodyRes = await parseValidatedBody(req, submitShotSchema);
  if (bodyRes.error || !bodyRes.data) {
    sendError(res, 400, 'INVALID_SHOT_PAYLOAD', bodyRes.error ?? 'Invalid shot parameters.');
    return;
  }
  const shot = bodyRes.data;

  if (Math.hypot(shot.dirX, shot.dirZ) < 1e-3) {
    sendError(res, 400, 'INVALID_DIRECTION', 'Shot direction magnitude is too small.');
    return;
  }

  try {
    const initialRecord = await resolveRoomFromParams(db, shot.roomCode, shot.matchId);
    if (!initialRecord || !initialRecord.gameState || initialRecord.gameState.matchId !== shot.matchId) {
      sendError(res, 404, 'MATCH_NOT_FOUND', 'Match not found.');
      return;
    }

    const gs = initialRecord.gameState;
    if (gs.player1Uid !== user.uid && gs.player2Uid !== user.uid) {
      sendError(res, 403, 'FORBIDDEN', 'You are not a participant in this match.');
      return;
    }

    // 1. Idempotency replay if exact eventId was already committed
    if (initialRecord.processedEvents && initialRecord.processedEvents[shot.eventId]) {
      const snapshot = buildRoomSnapshot(initialRecord)!;
      res.status(200).json({
        ok: true,
        duplicate: true,
        snapshot,
        shotResult: snapshot.matchState?.lastShot ?? null,
      });
      return;
    }

    // 2. Strict server-side turn & timer validation
    if (initialRecord.status !== 'IN_PROGRESS' || gs.status !== 'ACTIVE') {
      sendError(res, 409, 'MATCH_NOT_ACTIVE', 'This match has already finished.');
      return;
    }
    if (initialRecord.currentTurnUid !== user.uid) {
      sendError(res, 403, 'NOT_YOUR_TURN', 'It is currently your opponent’s turn.');
      return;
    }
    if (initialRecord.currentTurnNumber !== shot.turnNumber) {
      sendError(res, 409, 'STALE_TURN_NUMBER', 'Turn state changed before shot was received.');
      return;
    }
    if (gs.turnExpiresAt) {
      const expiresMs = Date.parse(gs.turnExpiresAt);
      if (Number.isFinite(expiresMs) && Date.now() > expiresMs + 1500) {
        sendError(res, 409, 'TURN_EXPIRED', 'Your turn timer expired.');
        return;
      }
    }

    const expectedVersion = gs.version;
    const shooterSlot: 1 | 2 = gs.player1Uid === user.uid ? 1 : 2;
    const resolution = await resolveAuthoritativeShot({
      penStates: gs.penStates,
      shooterSlot,
      localAnchor: shot.localAnchor,
      dirX: shot.dirX,
      dirZ: shot.dirZ,
      powerRatio: shot.powerRatio,
    });

    const isFinished = resolution.resultType !== null;
    const nextTurnUid = isFinished
      ? initialRecord.currentTurnUid!
      : shooterSlot === 1
        ? gs.player2Uid
        : gs.player1Uid;

    const winnerUid =
      resolution.winnerSlot === 1
        ? gs.player1Uid
        : resolution.winnerSlot === 2
          ? gs.player2Uid
          : null;

    const timerSecs = initialRecord.gameSettings?.turnTimerSeconds ?? 15;
    const nextExpiresAt =
      !isFinished && timerSecs > 0
        ? new Date(
            Date.now() + Math.round((timerSecs + resolution.durationSeconds) * 1000)
          ).toISOString()
        : null;

    const p1Score = resolution.winnerSlot === 1 ? 1 : gs.player1Score;
    const p2Score = resolution.winnerSlot === 2 ? 1 : gs.player2Score;
    const nowIso = new Date().toISOString();

    const txState: { code: string | null; message: string; duplicate: boolean } = {
      code: null,
      message: '',
      duplicate: false,
    };

    const tx = await runRtdbTransaction<FirebaseRoomRecord>(
      db.ref(`rooms/${initialRecord.roomCode}`),
      (current) => {
      txState.code = null;
      txState.message = '';
      txState.duplicate = false;

      if (!current || typeof current !== 'object') {
        txState.code = 'MATCH_NOT_FOUND';
        txState.message = 'Room no longer exists.';
        return;
      }

      const curRoom = current as FirebaseRoomRecord;
      const curGs = curRoom.gameState;
      if (!curGs || curGs.matchId !== shot.matchId) {
        txState.code = 'MATCH_NOT_FOUND';
        txState.message = 'Match not found.';
        return;
      }

      if (curRoom.processedEvents && curRoom.processedEvents[shot.eventId]) {
        txState.duplicate = true;
        return;
      }

      if (curRoom.status !== 'IN_PROGRESS' || curGs.status !== 'ACTIVE') {
        txState.code = 'MATCH_NOT_ACTIVE';
        txState.message = 'Match has already ended.';
        return;
      }
      if (curRoom.currentTurnUid !== user.uid) {
        txState.code = 'NOT_YOUR_TURN';
        txState.message = 'It is no longer your turn.';
        return;
      }
      if (curRoom.currentTurnNumber !== shot.turnNumber || curGs.version !== expectedVersion) {
        txState.code = 'STALE_TURN_NUMBER';
        txState.message = 'Match state changed concurrently. Please retry.';
        return;
      }

      const nextSeq = (curGs.sequenceNumber || 1) + 1;
      const shotSummary: ResolvedShotSummary = {
        eventId: shot.eventId,
        turnNumber: shot.turnNumber,
        sequenceNumber: nextSeq,
        shooterUid: user.uid,
        shooterSlot,
        powerPct: resolution.powerPct,
        appliedSpeed: resolution.appliedSpeed,
        spinFactor: resolution.spinFactor,
        durationSeconds: resolution.durationSeconds,
        keyframes: resolution.keyframes,
        collisions: resolution.collisions,
        firstFallenSlot: resolution.firstFallenSlot,
        winnerSlot: resolution.winnerSlot,
        isDraw: resolution.isDraw,
        resultType: resolution.resultType,
        resultReason: resolution.resultReason,
      };

      const nextProcessed: Record<string, number> = {
        ...(curRoom.processedEvents ?? {}),
        [shot.eventId]: nextSeq,
      };

      return {
        ...curRoom,
        status: isFinished ? 'COMPLETED' : 'IN_PROGRESS',
        updatedAt: nowIso,
        currentTurnUid: nextTurnUid,
        currentTurnNumber: isFinished ? shot.turnNumber : shot.turnNumber + 1,
        lastShot: shotSummary,
        processedEvents: nextProcessed,
        gameState: {
          ...curGs,
          status: isFinished ? 'COMPLETED' : 'ACTIVE',
          turnStartedAt: nowIso,
          turnExpiresAt: nextExpiresAt,
          player1Score: p1Score,
          player2Score: p2Score,
          winnerUid,
          resultType: resolution.resultType,
          resultReason: resolution.resultReason,
          version: curGs.version + 1,
          sequenceNumber: nextSeq,
          penStates: resolution.penStates,
          updatedAt: nowIso,
          completedAt: isFinished ? nowIso : null,
        },
      } satisfies FirebaseRoomRecord;
    });

    if (!tx.committed) {
      if (txState.duplicate) {
        const latest = await fetchRoomRecordByCode(db, initialRecord.roomCode);
        const snapshot = buildRoomSnapshot(latest);
        if (snapshot) {
          res.status(200).json({
            ok: true,
            duplicate: true,
            snapshot,
            shotResult: snapshot.matchState?.lastShot ?? null,
          });
          return;
        }
      }

      const code = txState.code ?? 'COMMIT_FAILED';
      const status = code === 'NOT_YOUR_TURN' ? 403 : code === 'MATCH_NOT_FOUND' ? 404 : 409;
      sendError(res, status, code, txState.message || 'Shot rejected.');
      return;
    }

    const updatedRecord = tx.snapshot.val() as FirebaseRoomRecord;
    if (isFinished) {
      await recordCompletedMatch(db, updatedRecord);
    }

    const updatedSnapshot = buildRoomSnapshot(updatedRecord);
    if (!updatedSnapshot) {
      sendError(res, 500, 'MATCH_LOAD_FAILED', 'Shot committed but failed to reload state.');
      return;
    }

    res.status(200).json({
      ok: true,
      duplicate: false,
      snapshot: updatedSnapshot,
      shotResult: updatedRecord.lastShot,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to resolve shot.';
    sendError(res, 500, 'SHOT_RESOLUTION_FAILED', msg);
  }
}

export async function handleMatchFinish(req: ApiRequest, res: ApiResponse): Promise<void> {
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

  const bodyRes = await parseValidatedBody(req, finishMatchSchema);
  if (bodyRes.error || !bodyRes.data) {
    sendError(res, 400, 'INVALID_REQUEST', bodyRes.error ?? 'Invalid match finish request.');
    return;
  }

  const payload = bodyRes.data;

  try {
    const initialRecord = await resolveRoomFromParams(db, payload.roomCode, payload.matchId);
    if (!initialRecord || !initialRecord.gameState || initialRecord.gameState.matchId !== payload.matchId) {
      sendError(res, 404, 'MATCH_NOT_FOUND', 'Match not found.');
      return;
    }

    const gsInit = initialRecord.gameState;
    if (gsInit.player1Uid !== user.uid && gsInit.player2Uid !== user.uid) {
      sendError(res, 403, 'FORBIDDEN', 'You are not a participant in this match.');
      return;
    }

    const eventId = payload.eventId ?? crypto.randomUUID();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const txState: {
      code: string | null;
      message: string;
      alreadyEnded: boolean;
      alreadyAdvanced: boolean;
      didCompleteMatch: boolean;
    } = {
      code: null,
      message: '',
      alreadyEnded: false,
      alreadyAdvanced: false,
      didCompleteMatch: false,
    };

    const tx = await runRtdbTransaction<FirebaseRoomRecord>(
      db.ref(`rooms/${initialRecord.roomCode}`),
      (current) => {
      txState.code = null;
      txState.message = '';
      txState.alreadyEnded = false;
      txState.alreadyAdvanced = false;
      txState.didCompleteMatch = false;

      if (!current || typeof current !== 'object') {
        txState.code = 'MATCH_NOT_FOUND';
        txState.message = 'Match not found.';
        return;
      }

      const room = current as FirebaseRoomRecord;
      const gs = room.gameState;
      if (!gs || gs.matchId !== payload.matchId) {
        txState.code = 'MATCH_NOT_FOUND';
        txState.message = 'Match not found.';
        return;
      }

      if (gs.status !== 'ACTIVE' || room.status !== 'IN_PROGRESS') {
        txState.alreadyEnded = true;
        return;
      }

      if (payload.mode === 'timeout') {
        if (payload.turnNumber && payload.turnNumber !== room.currentTurnNumber) {
          txState.alreadyAdvanced = true;
          return;
        }
        const timerSecs = room.gameSettings?.turnTimerSeconds ?? 15;
        if (timerSecs <= 0 || !gs.turnExpiresAt) {
          txState.code = 'TIMER_DISABLED';
          txState.message = 'Turn timer is disabled for this match.';
          return;
        }
        const expiresMs = Date.parse(gs.turnExpiresAt);
        if (Number.isFinite(expiresMs) && nowMs < expiresMs) {
          txState.code = 'TURN_NOT_EXPIRED';
          txState.message = 'Turn timer has not expired yet.';
          return;
        }

        const timedOutSlot: 1 | 2 = room.currentTurnUid === gs.player1Uid ? 1 : 2;
        const nextTurnUid = timedOutSlot === 1 ? gs.player2Uid : gs.player1Uid;
        const nextExpiresAt = new Date(nowMs + timerSecs * 1000).toISOString();
        const nextSeq = (gs.sequenceNumber || 1) + 1;

        return {
          ...room,
          updatedAt: nowIso,
          currentTurnUid: nextTurnUid,
          currentTurnNumber: room.currentTurnNumber + 1,
          processedEvents: { ...(room.processedEvents ?? {}), [eventId]: nextSeq },
          gameState: {
            ...gs,
            turnStartedAt: nowIso,
            turnExpiresAt: nextExpiresAt,
            version: gs.version + 1,
            sequenceNumber: nextSeq,
            updatedAt: nowIso,
            penStates: {
              player1: {
                ...gs.penStates.player1,
                skipsCount: gs.penStates.player1.skipsCount + (timedOutSlot === 1 ? 1 : 0),
              },
              player2: {
                ...gs.penStates.player2,
                skipsCount: gs.penStates.player2.skipsCount + (timedOutSlot === 2 ? 1 : 0),
              },
            },
          },
        } satisfies FirebaseRoomRecord;
      }

      // mode === 'forfeit' or 'complete': resign/forfeit cleanly in favor of opponent
      txState.didCompleteMatch = true;
      const forfeiter = room.players?.[user.uid];
      const winnerUid = gs.player1Uid === user.uid ? gs.player2Uid : gs.player1Uid;
      const winnerSlot = gs.player1Uid === winnerUid ? 1 : 2;
      const nextSeq = (gs.sequenceNumber || 1) + 1;

      return {
        ...room,
        status: 'COMPLETED',
        updatedAt: nowIso,
        currentTurnUid: winnerUid,
        processedEvents: { ...(room.processedEvents ?? {}), [eventId]: nextSeq },
        gameState: {
          ...gs,
          status: 'COMPLETED',
          turnExpiresAt: null,
          player1Score: winnerSlot === 1 ? 1 : 0,
          player2Score: winnerSlot === 2 ? 1 : 0,
          winnerUid,
          resultType: 'FORFEIT',
          resultReason: `${forfeiter?.nickname ?? 'Opponent'} forfeited the match.`,
          version: gs.version + 1,
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
      } satisfies FirebaseRoomRecord;
    });

    if (!tx.committed) {
      if (txState.alreadyEnded || txState.alreadyAdvanced) {
        const latest = await fetchRoomRecordByCode(db, initialRecord.roomCode);
        const snapshot = buildRoomSnapshot(latest);
        res.status(200).json({
          ok: true,
          snapshot,
          alreadyEnded: txState.alreadyEnded,
          alreadyAdvanced: txState.alreadyAdvanced,
        });
        return;
      }

      const code = txState.code ?? 'FINISH_FAILED';
      const status = code === 'MATCH_NOT_FOUND' ? 404 : code === 'TURN_NOT_EXPIRED' ? 409 : 400;
      sendError(res, status, code, txState.message || 'Could not finalize match action.');
      return;
    }

    const updatedRecord = tx.snapshot.val() as FirebaseRoomRecord;
    if (txState.didCompleteMatch) {
      await recordCompletedMatch(db, updatedRecord);
    }

    const snapshot = buildRoomSnapshot(updatedRecord);
    if (!snapshot) {
      sendError(res, 500, 'MATCH_LOAD_FAILED', 'Match updated but failed to reload state.');
      return;
    }

    res.status(200).json({ ok: true, snapshot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to finish match.';
    sendError(res, 500, 'MATCH_FINISH_FAILED', msg);
  }
}
