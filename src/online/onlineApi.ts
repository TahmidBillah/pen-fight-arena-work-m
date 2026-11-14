import { ArenaId, DeshiColorVariantId, PenTypeId } from '../utils/Constants';
import { TurnTimerOption } from '../game/MultiplayerTypes';
import {
  CanonicalVec3,
  MatchHistoryRecord,
  ResolvedShotSummary,
  RoomSnapshot,
  UserProfile,
} from '../shared/OnlineTypes';
import type { ProfileGender } from '../shared/ProfileValidation';
import { getFirebaseAuth } from './firebaseClient';

export class OnlineApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let sessionExpiredHandler: (() => void) | null = null;

export function registerSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

async function getAccessToken(forceRefresh = false): Promise<string | null> {
  const auth = getFirebaseAuth();
  const user = auth?.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

function mapFriendlyErrorMessage(status: number, code: string, fallback: string): string {
  switch (code) {
    case 'AUTH_EXPIRED':
      return 'Authentication expired. Please sign in with Google again.';
    case 'UNAUTHORIZED':
    case 'INVALID_SESSION':
      return 'Your session is invalid or expired. Please sign in with Google.';
    case 'ROOM_NOT_FOUND':
      return 'Room not found. Verify the 6-character room code and try again.';
    case 'ROOM_FULL':
      return 'This private room is full (2/2 players).';
    case 'INVALID_ROOM_CODE':
      return 'Invalid room code. Enter a 6-character alphanumeric code.';
    case 'NOT_YOUR_TURN':
      return 'Invalid turn: wait until your opponent finishes their shot.';
    case 'STALE_TURN_NUMBER':
    case 'TURN_EXPIRED':
      return 'Shot rejected: turn state changed or timer expired.';
    case 'INVALID_SHOT_PAYLOAD':
    case 'INVALID_DIRECTION':
      return 'Shot rejected by server validation. Pull back and try again.';
    case 'USERNAME_TAKEN':
      return 'That username is already taken. Please choose another.';
    case 'PROFILE_INCOMPLETE':
      return 'Complete your profile setup before playing Online 1v1.';
    default:
      if (status >= 500) {
        return fallback || 'Server error while processing online action. Please try again.';
      }
      return fallback;
  }
}

async function requestJson<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH';
    body?: unknown;
    auth?: boolean;
    idempotentRetries?: number;
  } = {}
): Promise<T> {
  const { method = 'GET', body, auth = true, idempotentRetries = 0 } = options;

  let attempts = 0;
  let refreshedOnce = false;

  while (true) {
    attempts += 1;
    let token: string | null = null;
    if (auth) {
      token = await getAccessToken(refreshedOnce);
      if (!token) {
        throw new OnlineApiError(401, 'UNAUTHORIZED', 'Please sign in with Google to continue.');
      }
    }

    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      if (attempts <= idempotentRetries) {
        await new Promise((r) => setTimeout(r, 300 * attempts));
        continue;
      }
      throw new OnlineApiError(
        0,
        'NETWORK_ERROR',
        'Network unavailable. Check your internet connection.'
      );
    }

    if (response.status === 401 && auth && !refreshedOnce) {
      refreshedOnce = true;
      continue;
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    if (!response.ok || parsed.ok === false) {
      if (response.status === 401 && auth) {
        sessionExpiredHandler?.();
      }

      if (response.status >= 502 && response.status <= 504 && attempts <= idempotentRetries) {
        await new Promise((r) => setTimeout(r, 350 * attempts));
        continue;
      }

      const code = typeof parsed.code === 'string' ? parsed.code : `HTTP_${response.status}`;
      const rawMessage =
        typeof parsed.error === 'string'
          ? parsed.error
          : `Server returned status ${response.status}.`;
      throw new OnlineApiError(
        response.status,
        code,
        mapFriendlyErrorMessage(response.status, code, rawMessage)
      );
    }

    return parsed as T;
  }
}

export async function checkOnlineHealth(): Promise<{
  ok: boolean;
  firebaseConfigured: boolean;
  serverTime: string;
}> {
  return requestJson('/api/health', { method: 'GET', auth: false });
}

export async function fetchMyProfile(includeHistory = false): Promise<{
  profile: UserProfile;
  matchHistory?: MatchHistoryRecord[];
}> {
  const qs = includeHistory ? '?includeHistory=1' : '';
  return requestJson<{ ok: true; profile: UserProfile; matchHistory?: MatchHistoryRecord[] }>(
    `/api/profile/me${qs}`,
    { method: 'GET' }
  );
}

export interface UsernameAvailabilityResponse {
  valid: boolean;
  available: boolean;
  normalized: string;
  reason: string | null;
}

export async function checkUsernameAvailability(
  username: string
): Promise<UsernameAvailabilityResponse> {
  const qs = new URLSearchParams({ username });
  return requestJson<{ ok: true } & UsernameAvailabilityResponse>(
    `/api/profile/check-username?${qs.toString()}`,
    { method: 'GET' }
  );
}

export async function completeMyProfile(params: {
  displayName: string;
  username: string;
  gender: ProfileGender;
}): Promise<UserProfile> {
  const res = await requestJson<{ ok: true; profile: UserProfile }>('/api/profile/complete', {
    method: 'POST',
    body: params,
  });
  return res.profile;
}

export async function updateMyProfile(params: {
  displayName?: string;
  username?: string;
  nickname?: string;
  gender?: ProfileGender;
}): Promise<UserProfile> {
  const res = await requestJson<{ ok: true; profile: UserProfile }>('/api/profile/me', {
    method: 'PATCH',
    body: params,
  });
  return res.profile;
}

export async function updateMyNickname(nickname: string): Promise<UserProfile> {
  return updateMyProfile({ username: nickname });
}

export async function createOnlineRoom(params: {
  arenaId: ArenaId;
  turnTimerSeconds: TurnTimerOption;
  penType: PenTypeId;
  deshiVariant: DeshiColorVariantId;
}): Promise<RoomSnapshot> {
  const res = await requestJson<{ ok: true; snapshot: RoomSnapshot }>('/api/rooms/create', {
    method: 'POST',
    body: params,
  });
  return res.snapshot;
}

export async function joinOnlineRoom(params: {
  roomCode: string;
  penType: PenTypeId;
  deshiVariant: DeshiColorVariantId;
}): Promise<RoomSnapshot> {
  const res = await requestJson<{ ok: true; snapshot: RoomSnapshot }>('/api/rooms/join', {
    method: 'POST',
    body: params,
  });
  return res.snapshot;
}

export async function fetchRoomDetail(roomCode: string): Promise<RoomSnapshot> {
  const qs = new URLSearchParams({ code: roomCode });
  const res = await requestJson<{ ok: true; snapshot: RoomSnapshot }>(
    `/api/rooms/detail?${qs.toString()}`,
    { method: 'GET' }
  );
  return res.snapshot;
}

export async function updateRoomReady(params: {
  roomCode: string;
  isReady?: boolean;
  penType?: PenTypeId;
  deshiVariant?: DeshiColorVariantId;
  arenaId?: ArenaId;
  turnTimerSeconds?: TurnTimerOption;
}): Promise<RoomSnapshot> {
  const res = await requestJson<{ ok: true; snapshot: RoomSnapshot }>('/api/rooms/ready', {
    method: 'POST',
    body: params,
  });
  return res.snapshot;
}

export async function leaveOnlineRoom(roomCode: string): Promise<void> {
  await requestJson('/api/rooms/leave', {
    method: 'POST',
    body: { roomCode },
  });
}

export async function startOnlineMatch(roomCode: string, eventId: string): Promise<RoomSnapshot> {
  const res = await requestJson<{ ok: true; snapshot: RoomSnapshot }>('/api/matches/start', {
    method: 'POST',
    body: { roomCode, eventId },
    idempotentRetries: 1,
  });
  return res.snapshot;
}

export async function fetchMatchState(params: {
  roomCode?: string;
  matchId: string;
}): Promise<RoomSnapshot> {
  const res = await requestJson<{ ok: true; snapshot: RoomSnapshot }>('/api/matches/state', {
    method: 'POST',
    body: params,
    idempotentRetries: 1,
  });
  return res.snapshot;
}

export async function submitOnlineShot(params: {
  roomCode: string;
  matchId: string;
  eventId: string;
  turnNumber: number;
  localAnchor: CanonicalVec3;
  dirX: number;
  dirZ: number;
  powerRatio: number;
}): Promise<{ snapshot: RoomSnapshot; shotResult: ResolvedShotSummary; duplicate: boolean }> {
  const res = await requestJson<{
    ok: true;
    snapshot: RoomSnapshot;
    shotResult: ResolvedShotSummary;
    duplicate: boolean;
  }>('/api/matches/submit-shot', {
    method: 'POST',
    body: params,
    idempotentRetries: 2,
  });
  return {
    snapshot: res.snapshot,
    shotResult: res.shotResult,
    duplicate: Boolean(res.duplicate),
  };
}

export async function finishOnlineMatch(params: {
  roomCode: string;
  matchId: string;
  mode: 'timeout' | 'forfeit' | 'complete';
  turnNumber?: number;
  eventId?: string;
}): Promise<RoomSnapshot> {
  const res = await requestJson<{ ok: true; snapshot: RoomSnapshot }>('/api/matches/finish', {
    method: 'POST',
    body: params,
    idempotentRetries: 1,
  });
  return res.snapshot;
}
