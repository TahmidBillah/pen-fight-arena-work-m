import { useCallback, useEffect, useRef, useState } from 'react';
import { onDisconnect, onValue, ref, serverTimestamp, set } from 'firebase/database';
import { ArenaId, DeshiColorVariantId, PenTypeId } from '../utils/Constants';
import { TurnTimerOption } from '../game/MultiplayerTypes';
import { buildRoomSnapshot } from '../shared/OnlineSnapshotMapper';
import {
  CanonicalVec3,
  FirebaseRoomRecord,
  ResolvedShotSummary,
  RoomSnapshot,
} from '../shared/OnlineTypes';
import { getFirebaseDatabase } from './firebaseClient';
import {
  createOnlineRoom,
  fetchMatchState,
  fetchRoomDetail,
  finishOnlineMatch,
  joinOnlineRoom,
  leaveOnlineRoom,
  startOnlineMatch,
  submitOnlineShot,
  updateRoomReady,
} from './onlineApi';

const ACTIVE_ROOM_STORAGE_KEY = 'pen_fight_online_active_room_v2';

function saveStoredRoomCode(code: string | null): void {
  try {
    if (code) {
      localStorage.setItem(ACTIVE_ROOM_STORAGE_KEY, code);
    } else {
      localStorage.removeItem(ACTIVE_ROOM_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function loadStoredRoomCode(): string | null {
  try {
    return localStorage.getItem(ACTIVE_ROOM_STORAGE_KEY);
  } catch {
    return null;
  }
}

export type RealtimeConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export interface OnlineRoomController {
  snapshot: RoomSnapshot | null;
  loading: boolean;
  busyAction: string | null;
  error: string | null;
  realtimeStatus: RealtimeConnectionStatus;
  onlineUserIds: string[];
  clearError: () => void;
  createRoom: (params: {
    arenaId: ArenaId;
    turnTimerSeconds: TurnTimerOption;
    penType: PenTypeId;
    deshiVariant: DeshiColorVariantId;
  }) => Promise<RoomSnapshot | null>;
  joinRoom: (params: {
    roomCode: string;
    penType: PenTypeId;
    deshiVariant: DeshiColorVariantId;
  }) => Promise<RoomSnapshot | null>;
  refreshRoom: () => Promise<RoomSnapshot | null>;
  updateReadyAndLoadout: (params: {
    isReady?: boolean;
    penType?: PenTypeId;
    deshiVariant?: DeshiColorVariantId;
    arenaId?: ArenaId;
    turnTimerSeconds?: TurnTimerOption;
  }) => Promise<RoomSnapshot | null>;
  leaveRoom: () => Promise<void>;
  startMatch: () => Promise<RoomSnapshot | null>;
  submitShot: (params: {
    localAnchor: CanonicalVec3;
    dirX: number;
    dirZ: number;
    powerRatio: number;
  }) => Promise<{ snapshot: RoomSnapshot; shotResult: ResolvedShotSummary } | null>;
  claimTimeout: (turnNumber: number) => Promise<RoomSnapshot | null>;
  forfeitMatch: () => Promise<RoomSnapshot | null>;
  dismissLocalRoom: () => void;
}

export function useOnlineRoom(options: {
  userId: string | null;
  onMatchFinished?: () => void;
}): OnlineRoomController {
  const { userId, onMatchFinished } = options;

  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeConnectionStatus>('DISCONNECTED');
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);

  const seenShotEventIdsRef = useRef<Set<string>>(new Set());
  const lastSequenceRef = useRef<number>(0);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const onMatchFinishedRef = useRef(onMatchFinished);

  onMatchFinishedRef.current = onMatchFinished;

  const applySnapshot = useCallback((next: RoomSnapshot | null) => {
    const prev = snapshotRef.current;

    if (next && prev && prev.room.roomCode === next.room.roomCode) {
      // Protect against stale/out-of-order RTDB snapshots during active matches
      if (
        prev.match &&
        next.match &&
        prev.match.id === next.match.id &&
        next.match.sequenceNumber < prev.match.sequenceNumber
      ) {
        return;
      }
      if (next.matchState?.lastShot?.eventId) {
        seenShotEventIdsRef.current.add(next.matchState.lastShot.eventId);
      }
      if (next.match?.sequenceNumber) {
        lastSequenceRef.current = Math.max(lastSequenceRef.current, next.match.sequenceNumber);
      }
    }

    const prevStatus = prev?.match?.status;
    snapshotRef.current = next;
    setSnapshot(next);

    if (!next) {
      setOnlineUserIds([]);
      saveStoredRoomCode(null);
      return;
    }

    setOnlineUserIds(next.players.filter((p) => p.isConnected).map((p) => p.uid));

    if (next.room.status === 'CANCELLED' || next.room.status === 'EXPIRED') {
      saveStoredRoomCode(null);
    } else {
      saveStoredRoomCode(next.room.roomCode);
    }

    if (prevStatus === 'ACTIVE' && next.match?.status === 'COMPLETED') {
      onMatchFinishedRef.current?.();
    }
  }, []);

  // Automatically restore active room if player refreshes browser
  useEffect(() => {
    if (!userId) {
      applySnapshot(null);
      seenShotEventIdsRef.current.clear();
      lastSequenceRef.current = 0;
      return;
    }

    const savedCode = loadStoredRoomCode();
    if (!savedCode || snapshotRef.current) return;

    let cancelled = false;
    setLoading(true);
    void fetchRoomDetail(savedCode)
      .then((res) => {
        if (cancelled) return;
        if (res.room.status === 'WAITING' || res.room.status === 'IN_PROGRESS') {
          applySnapshot(res);
        } else {
          saveStoredRoomCode(null);
        }
      })
      .catch(() => {
        if (!cancelled) saveStoredRoomCode(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, applySnapshot]);

  const refreshRoom = useCallback(async (): Promise<RoomSnapshot | null> => {
    const cur = snapshotRef.current;
    if (!cur) return null;
    try {
      const next =
        cur.match && cur.room.status === 'IN_PROGRESS'
          ? await fetchMatchState({ roomCode: cur.room.roomCode, matchId: cur.match.id })
          : await fetchRoomDetail(cur.room.roomCode);
      applySnapshot(next);
      return next;
    } catch {
      setError((prev) => prev ?? 'Match synchronization failed. Trying to reconnect...');
      return null;
    }
  }, [applySnapshot]);

  const activeRoomCode = snapshot?.room.roomCode ?? null;

  // Subscribe to Firebase Realtime Database `/rooms/{roomCode}` & `.info/connected` presence
  useEffect(() => {
    const db = getFirebaseDatabase();
    if (!db || !userId || !activeRoomCode) {
      setRealtimeStatus('DISCONNECTED');
      return;
    }

    setRealtimeStatus('CONNECTING');
    const roomRef = ref(db, `rooms/${activeRoomCode}`);
    const connectedRef = ref(db, '.info/connected');
    const myConnectionRef = ref(db, `rooms/${activeRoomCode}/players/${userId}/connection`);

    const unsubRoom = onValue(
      roomRef,
      (rtdbSnap) => {
        if (!rtdbSnap.exists()) return;
        const raw = rtdbSnap.val() as FirebaseRoomRecord;
        const mapped = buildRoomSnapshot(raw);
        if (mapped) {
          applySnapshot(mapped);
          setError((prev) =>
            prev === 'Match synchronization failed. Trying to reconnect...' ? null : prev
          );
        }
      },
      () => {
        setError('Match synchronization failed. Check your network connection.');
      }
    );

    const unsubConn = onValue(connectedRef, (connSnap) => {
      const isConnected = connSnap.val() === true;
      if (isConnected) {
        setRealtimeStatus('CONNECTED');
        const disconnectOp = onDisconnect(myConnectionRef);
        void disconnectOp
          .set({
            online: false,
            lastSeenAt: serverTimestamp(),
          })
          .catch(() => {
            // Presence write ignored if player already left room
          });

        void set(myConnectionRef, {
          online: true,
          lastSeenAt: Date.now(),
        }).catch(() => {
          // Presence write ignored if player already left room
        });
      } else {
        setRealtimeStatus('CONNECTING');
      }
    });

    const onBrowserOnline = () => {
      void refreshRoom();
    };
    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshRoom();
      }
    };
    window.addEventListener('online', onBrowserOnline);
    window.addEventListener('visibilitychange', onFocusOrVisible);
    window.addEventListener('focus', onFocusOrVisible);

    return () => {
      window.removeEventListener('online', onBrowserOnline);
      window.removeEventListener('visibilitychange', onFocusOrVisible);
      window.removeEventListener('focus', onFocusOrVisible);
      unsubRoom();
      unsubConn();
      void onDisconnect(myConnectionRef).cancel().catch(() => {});
      void set(myConnectionRef, {
        online: false,
        lastSeenAt: Date.now(),
      }).catch(() => {});
      setRealtimeStatus('DISCONNECTED');
    };
  }, [userId, activeRoomCode, applySnapshot, refreshRoom]);

  const createRoom = useCallback(
    async (params: {
      arenaId: ArenaId;
      turnTimerSeconds: TurnTimerOption;
      penType: PenTypeId;
      deshiVariant: DeshiColorVariantId;
    }) => {
      setError(null);
      setBusyAction('create');
      seenShotEventIdsRef.current.clear();
      lastSequenceRef.current = 0;
      try {
        const res = await createOnlineRoom(params);
        applySnapshot(res);
        return res;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create room.');
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [applySnapshot]
  );

  const joinRoom = useCallback(
    async (params: {
      roomCode: string;
      penType: PenTypeId;
      deshiVariant: DeshiColorVariantId;
    }) => {
      setError(null);
      setBusyAction('join');
      seenShotEventIdsRef.current.clear();
      lastSequenceRef.current = 0;
      try {
        const res = await joinOnlineRoom(params);
        applySnapshot(res);
        return res;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to join room.');
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [applySnapshot]
  );

  const updateReadyAndLoadout = useCallback(
    async (params: {
      isReady?: boolean;
      penType?: PenTypeId;
      deshiVariant?: DeshiColorVariantId;
      arenaId?: ArenaId;
      turnTimerSeconds?: TurnTimerOption;
    }) => {
      const cur = snapshotRef.current;
      if (!cur) return null;
      setError(null);
      setBusyAction('ready');
      try {
        const res = await updateRoomReady({ roomCode: cur.room.roomCode, ...params });
        applySnapshot(res);
        return res;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update room status.');
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [applySnapshot]
  );

  const leaveRoom = useCallback(async () => {
    const cur = snapshotRef.current;
    if (!cur) {
      applySnapshot(null);
      return;
    }
    setBusyAction('leave');
    setError(null);
    try {
      await leaveOnlineRoom(cur.room.roomCode);
    } catch {
      // Clear local state cleanly even if room already expired
    } finally {
      seenShotEventIdsRef.current.clear();
      lastSequenceRef.current = 0;
      applySnapshot(null);
      setBusyAction(null);
    }
  }, [applySnapshot]);

  const startMatch = useCallback(async () => {
    const cur = snapshotRef.current;
    if (!cur) return null;
    setError(null);
    setBusyAction('start');
    seenShotEventIdsRef.current.clear();
    lastSequenceRef.current = 0;
    try {
      const eventId = crypto.randomUUID();
      seenShotEventIdsRef.current.add(eventId);
      const res = await startOnlineMatch(cur.room.roomCode, eventId);
      applySnapshot(res);
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start match.');
      return null;
    } finally {
      setBusyAction(null);
    }
  }, [applySnapshot]);

  const submitShot = useCallback(
    async (params: {
      localAnchor: CanonicalVec3;
      dirX: number;
      dirZ: number;
      powerRatio: number;
    }) => {
      const cur = snapshotRef.current;
      if (!cur?.match) return null;
      setError(null);
      setBusyAction('shot');
      try {
        const eventId = crypto.randomUUID();
        const res = await submitOnlineShot({
          roomCode: cur.room.roomCode,
          matchId: cur.match.id,
          eventId,
          turnNumber: cur.match.turnNumber,
          ...params,
        });
        seenShotEventIdsRef.current.add(eventId);
        if (res.shotResult?.sequenceNumber) {
          lastSequenceRef.current = Math.max(
            lastSequenceRef.current,
            res.shotResult.sequenceNumber
          );
        }
        applySnapshot(res.snapshot);
        return { snapshot: res.snapshot, shotResult: res.shotResult };
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Shot rejected.');
        await refreshRoom();
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [applySnapshot, refreshRoom]
  );

  const claimTimeout = useCallback(
    async (turnNumber: number) => {
      const cur = snapshotRef.current;
      if (!cur?.match) return null;
      try {
        const eventId = crypto.randomUUID();
        const res = await finishOnlineMatch({
          roomCode: cur.room.roomCode,
          matchId: cur.match.id,
          mode: 'timeout',
          turnNumber,
          eventId,
        });
        applySnapshot(res);
        return res;
      } catch {
        return null;
      }
    },
    [applySnapshot]
  );

  const forfeitMatch = useCallback(async () => {
    const cur = snapshotRef.current;
    if (!cur?.match) return null;
    setError(null);
    setBusyAction('forfeit');
    try {
      const res = await finishOnlineMatch({
        roomCode: cur.room.roomCode,
        matchId: cur.match.id,
        mode: 'forfeit',
      });
      applySnapshot(res);
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to forfeit match.');
      return null;
    } finally {
      setBusyAction(null);
    }
  }, [applySnapshot]);

  const dismissLocalRoom = useCallback(() => {
    seenShotEventIdsRef.current.clear();
    lastSequenceRef.current = 0;
    applySnapshot(null);
  }, [applySnapshot]);

  return {
    snapshot,
    loading,
    busyAction,
    error,
    realtimeStatus,
    onlineUserIds,
    clearError: () => setError(null),
    createRoom,
    joinRoom,
    refreshRoom,
    updateReadyAndLoadout,
    leaveRoom,
    startMatch,
    submitShot,
    claimTimeout,
    forfeitMatch,
    dismissLocalRoom,
  };
}
