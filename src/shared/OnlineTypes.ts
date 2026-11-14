import { ArenaId, DeshiColorVariantId, PenTypeId } from '../utils/Constants';
import { TeamId, TurnTimerOption } from '../game/MultiplayerTypes';
import type { ProfileGender } from './ProfileValidation';

export type RoomStatus = 'WAITING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
export type OnlineMatchStatus = 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
export type MatchResultType = 'PLAYER1_WIN' | 'PLAYER2_WIN' | 'DRAW' | 'FORFEIT';

export interface UserProfile {
  uid: string;
  displayName: string;
  username: string;
  normalizedUsername: string;
  gender: ProfileGender | null;
  email: string | null;
  photoURL: string | null;
  nickname: string;
  profileCompleted: boolean;
  createdAt: string;
  updatedAt: string;
  totalMatches: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface PublicPlayerProfile {
  uid: string;
  displayName: string;
  username: string;
  photoURL: string | null;
  nickname: string;
  totalMatches: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface PlayerStatsRecord {
  uid: string;
  totalMatches: number;
  wins: number;
  losses: number;
  draws: number;
  totalShots: number;
  totalKnockouts: number;
  updatedAt: string;
}

export interface MatchHistoryRecord {
  matchId: string;
  roomCode: string;
  arenaId: ArenaId;
  opponentUid: string;
  opponentNickname: string;
  myScore: number;
  opponentScore: number;
  winnerUid: string | null;
  outcome: 'WIN' | 'LOSS' | 'DRAW';
  resultType: MatchResultType;
  resultReason: string;
  turnsPlayed: number;
  shotsCount: number;
  playedAt: string;
}

export interface OnlineRoom {
  roomCode: string;
  hostUid: string;
  status: RoomStatus;
  arenaId: ArenaId;
  turnTimerSeconds: TurnTimerOption;
  maxPlayers: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OnlineRoomPlayer {
  uid: string;
  roomCode: string;
  slot: 1 | 2;
  team: TeamId;
  penType: PenTypeId;
  deshiVariant: DeshiColorVariantId;
  isReady: boolean;
  isConnected: boolean;
  joinedAt: string;
  lastSeenAt: string;
  profile: PublicPlayerProfile;
}

export interface CanonicalVec3 {
  x: number;
  y: number;
  z: number;
}

export interface CanonicalQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface CanonicalPose {
  pos: CanonicalVec3;
  rot: CanonicalQuat;
  linvel: CanonicalVec3;
  angvel: CanonicalVec3;
}

export interface OnlinePenState {
  uid: string;
  slot: 1 | 2;
  team: TeamId;
  penType: PenTypeId;
  deshiVariant: DeshiColorVariantId;
  pose: CanonicalPose;
  isEliminated: boolean;
  shotsCount: number;
  knockoutsCount: number;
  skipsCount: number;
}

export interface OnlinePenPairState {
  player1: OnlinePenState;
  player2: OnlinePenState;
}

/** [x, y, z, qx, qy, qz, qw] rounded for compact transport */
export type CompactPoseTuple = [number, number, number, number, number, number, number];

export interface ShotKeyframe {
  t: number;
  p1: CompactPoseTuple;
  p2: CompactPoseTuple;
}

export interface ShotCollisionEvent {
  t: number;
  kind: 'pen' | 'table' | 'floor';
  point: [number, number, number];
  speed: number;
  fallenSlot?: 1 | 2;
}

export interface ShotSubmissionInput {
  roomCode: string;
  matchId: string;
  eventId: string;
  turnNumber: number;
  localAnchor: CanonicalVec3;
  dirX: number;
  dirZ: number;
  powerRatio: number;
}

export interface ResolvedShotSummary {
  eventId: string;
  turnNumber: number;
  sequenceNumber: number;
  shooterUid: string;
  shooterSlot: 1 | 2;
  powerPct: number;
  appliedSpeed: number;
  spinFactor: number;
  durationSeconds: number;
  keyframes: ShotKeyframe[];
  collisions: ShotCollisionEvent[];
  firstFallenSlot: 1 | 2 | null;
  winnerSlot: 1 | 2 | null;
  isDraw: boolean;
  resultType: MatchResultType | null;
  resultReason: string | null;
}

export interface OnlineMatch {
  id: string;
  roomCode: string;
  player1Uid: string;
  player2Uid: string;
  arenaId: ArenaId;
  turnTimerSeconds: TurnTimerOption;
  status: OnlineMatchStatus;
  currentTurnUid: string;
  turnNumber: number;
  turnStartedAt: string;
  turnExpiresAt: string | null;
  player1Score: number;
  player2Score: number;
  winnerUid: string | null;
  resultType: MatchResultType | null;
  resultReason: string | null;
  version: number;
  sequenceNumber: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface OnlineMatchState {
  matchId: string;
  stateVersion: number;
  sequenceNumber: number;
  turnNumber: number;
  penStates: OnlinePenPairState;
  lastShot: ResolvedShotSummary | null;
  updatedAt: string;
}

export interface RoomSnapshot {
  room: OnlineRoom;
  players: OnlineRoomPlayer[];
  match: OnlineMatch | null;
  matchState: OnlineMatchState | null;
  serverTime: string;
}

/**
 * Raw Firebase Realtime Database representation stored at `/rooms/{roomCode}`.
 */
export interface FirebaseRoomPlayerRecord {
  uid: string;
  slot: 1 | 2;
  team: TeamId;
  penType: PenTypeId;
  deshiVariant: DeshiColorVariantId;
  isReady: boolean;
  joinedAt: string;
  displayName: string;
  username?: string;
  photoURL: string | null;
  nickname: string;
  totalMatches: number;
  wins: number;
  losses: number;
  draws: number;
  connection: {
    online: boolean;
    lastSeenAt: number;
  };
}

export interface FirebaseRoomGameState {
  matchId: string;
  status: OnlineMatchStatus;
  player1Uid: string;
  player2Uid: string;
  turnStartedAt: string;
  turnExpiresAt: string | null;
  player1Score: number;
  player2Score: number;
  winnerUid: string | null;
  resultType: MatchResultType | null;
  resultReason: string | null;
  version: number;
  sequenceNumber: number;
  penStates: OnlinePenPairState;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface FirebaseRoomRecord {
  roomCode: string;
  hostUid: string;
  status: RoomStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  maxPlayers: number;
  currentTurnUid: string | null;
  currentTurnNumber: number;
  gameSettings: {
    arenaId: ArenaId;
    turnTimerSeconds: TurnTimerOption;
  };
  players: Record<string, FirebaseRoomPlayerRecord>;
  gameState: FirebaseRoomGameState | null;
  lastShot: ResolvedShotSummary | null;
  processedEvents?: Record<string, number>;
}
