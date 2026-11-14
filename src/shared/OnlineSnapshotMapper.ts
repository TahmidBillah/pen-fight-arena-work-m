import {
  ArenaId,
  DEFAULT_ARENA,
  DEFAULT_DESHI_VARIANT,
  DeshiColorVariantId,
  isArenaId,
  isDeshiColorVariantId,
  isPenTypeId,
  PenTypeId,
  STARTER_PEN,
} from '../utils/Constants';
import type { TurnTimerOption } from '../game/MultiplayerTypes';
import type {
  FirebaseRoomPlayerRecord,
  FirebaseRoomRecord,
  OnlineMatch,
  OnlineMatchState,
  OnlineRoom,
  OnlineRoomPlayer,
  RoomSnapshot,
} from './OnlineTypes';

export function normalizeArenaId(val: unknown): ArenaId {
  return isArenaId(val) ? val : DEFAULT_ARENA;
}

export function normalizeTimer(val: unknown): TurnTimerOption {
  const num = Number(val);
  return num === 0 || num === 10 || num === 15 || num === 20 || num === 30 ? num : 15;
}

export function normalizePen(val: unknown): PenTypeId {
  return isPenTypeId(val) ? val : STARTER_PEN;
}

export function normalizeDeshiVariant(val: unknown): DeshiColorVariantId {
  return isDeshiColorVariantId(val) ? val : DEFAULT_DESHI_VARIANT;
}

/**
 * Converts a raw Firebase RTDB `/rooms/{roomCode}` record into a canonical `RoomSnapshot`.
 * Shared across server handlers and the browser RTDB `onValue` listener.
 */
export function buildRoomSnapshot(record: FirebaseRoomRecord | null): RoomSnapshot | null {
  if (!record || !record.roomCode) return null;

  const room: OnlineRoom = {
    roomCode: record.roomCode,
    hostUid: record.hostUid,
    status: record.status,
    arenaId: normalizeArenaId(record.gameSettings?.arenaId),
    turnTimerSeconds: normalizeTimer(record.gameSettings?.turnTimerSeconds),
    maxPlayers: record.maxPlayers || 2,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  const rawPlayers: FirebaseRoomPlayerRecord[] = record.players
    ? Object.values(record.players)
    : [];

  const players: OnlineRoomPlayer[] = rawPlayers
    .map((p) => {
      const slot: 1 | 2 = p.slot === 2 ? 2 : 1;
      const lastSeenMs =
        typeof p.connection?.lastSeenAt === 'number'
          ? p.connection.lastSeenAt
          : Date.parse(p.joinedAt || record.createdAt);
      return {
        uid: p.uid,
        roomCode: record.roomCode,
        slot,
        team: p.team === 'red' ? ('red' as const) : ('blue' as const),
        penType: normalizePen(p.penType),
        deshiVariant: normalizeDeshiVariant(p.deshiVariant),
        isReady: Boolean(p.isReady),
        isConnected: p.connection?.online !== false,
        joinedAt: p.joinedAt || record.createdAt,
        lastSeenAt: Number.isFinite(lastSeenMs)
          ? new Date(lastSeenMs).toISOString()
          : record.updatedAt,
        profile: {
          uid: p.uid,
          displayName: p.displayName || p.nickname || `Player ${slot}`,
          username: p.username || (p.nickname ? p.nickname.toLowerCase() : `player_${slot}`),
          photoURL: p.photoURL ?? null,
          nickname: p.nickname || p.username || `Player_${slot}`,
          totalMatches: p.totalMatches ?? 0,
          wins: p.wins ?? 0,
          losses: p.losses ?? 0,
          draws: p.draws ?? 0,
        },
      };
    })
    .sort((a, b) => a.slot - b.slot);

  let match: OnlineMatch | null = null;
  let matchState: OnlineMatchState | null = null;

  if (record.gameState) {
    const gs = record.gameState;
    match = {
      id: gs.matchId,
      roomCode: record.roomCode,
      player1Uid: gs.player1Uid,
      player2Uid: gs.player2Uid,
      arenaId: room.arenaId,
      turnTimerSeconds: room.turnTimerSeconds,
      status: gs.status,
      currentTurnUid: record.currentTurnUid || gs.player1Uid,
      turnNumber: record.currentTurnNumber || 1,
      turnStartedAt: gs.turnStartedAt,
      turnExpiresAt: gs.turnExpiresAt ?? null,
      player1Score: gs.player1Score ?? 0,
      player2Score: gs.player2Score ?? 0,
      winnerUid: gs.winnerUid ?? null,
      resultType: gs.resultType ?? null,
      resultReason: gs.resultReason ?? null,
      version: gs.version ?? 1,
      sequenceNumber: gs.sequenceNumber ?? 1,
      createdAt: gs.createdAt,
      updatedAt: gs.updatedAt,
      completedAt: gs.completedAt ?? null,
    };

    matchState = {
      matchId: gs.matchId,
      stateVersion: gs.version ?? 1,
      sequenceNumber: gs.sequenceNumber ?? 1,
      turnNumber: record.currentTurnNumber || 1,
      penStates: gs.penStates,
      lastShot: record.lastShot ?? null,
      updatedAt: gs.updatedAt,
    };
  }

  return {
    room,
    players,
    match,
    matchState,
    serverTime: new Date().toISOString(),
  };
}
