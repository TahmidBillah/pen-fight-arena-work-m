import React, { useEffect, useRef, useState } from 'react';
import { Clock, Flag, Loader2, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react';
import type { PerformanceMonitor } from '../game/PerformanceMonitor';
import type { RealtimeConnectionStatus } from '../online/useOnlineRoom';
import type { RoomSnapshot } from '../shared/OnlineTypes';
import { PEN_SPECS } from '../utils/Constants';
import { PerformanceOverlay } from './PerformanceOverlay';

interface OnlineHUDProps {
  snapshot: RoomSnapshot;
  myUserId: string;
  realtimeStatus: RealtimeConnectionStatus;
  onlineUserIds: string[];
  isSubmittingShot: boolean;
  isReplayingShot: boolean;
  error: string | null;
  sfxEnabled: boolean;
  monitor: PerformanceMonitor | null;
  showFps: boolean;
  onToggleSfx: () => void;
  onClaimTimeout: (turnNumber: number) => void;
  onForfeit: () => void;
}

export const OnlineHUD: React.FC<OnlineHUDProps> = ({
  snapshot,
  myUserId,
  realtimeStatus,
  onlineUserIds,
  isSubmittingShot,
  isReplayingShot,
  error,
  sfxEnabled,
  monitor,
  showFps,
  onToggleSfx,
  onClaimTimeout,
  onForfeit,
}) => {
  const match = snapshot.match;
  const penStates = snapshot.matchState?.penStates;
  const p1 = snapshot.players.find((p) => p.slot === 1);
  const p2 = snapshot.players.find((p) => p.slot === 2);

  const [secondsRemaining, setSecondsRemaining] = useState<number>(0);
  const [confirmForfeit, setConfirmForfeit] = useState(false);
  const claimedTurnRef = useRef<number | null>(null);

  useEffect(() => {
    if (!match || match.status !== 'ACTIVE' || !match.turnExpiresAt || match.turnTimerSeconds <= 0) {
      setSecondsRemaining(0);
      return;
    }

    const updateTimer = () => {
      const remainingMs = Date.parse(match.turnExpiresAt!) - Date.now();
      const secs = Math.max(0, Math.ceil(remainingMs / 1000));
      setSecondsRemaining(secs);

      if (
        remainingMs <= -400 &&
        !isSubmittingShot &&
        !isReplayingShot &&
        claimedTurnRef.current !== match.turnNumber
      ) {
        claimedTurnRef.current = match.turnNumber;
        onClaimTimeout(match.turnNumber);
      }
    };

    updateTimer();
    const id = window.setInterval(updateTimer, 250);
    return () => window.clearInterval(id);
  }, [match, isSubmittingShot, isReplayingShot, onClaimTimeout]);

  if (!match || !penStates) return null;

  const isMyTurn = match.status === 'ACTIVE' && match.currentTurnUid === myUserId;
  const activeSlot = match.currentTurnUid === match.player1Uid ? 1 : 2;
  const activePlayer = activeSlot === 1 ? p1 : p2;
  const activePlayerName =
    activePlayer?.profile.displayName ||
    (activePlayer?.profile.username ? `@${activePlayer.profile.username}` : `Player ${activeSlot}`);

  const opponent = snapshot.players.find((p) => p.uid !== myUserId) ?? null;
  const opponentDisconnected = Boolean(
    opponent && match.status === 'ACTIVE' && !onlineUserIds.includes(opponent.uid)
  );

  const statusText = isSubmittingShot
    ? 'Validating & resolving shot on server...'
    : isReplayingShot
      ? 'Resolving authoritative shot...'
      : match.status === 'COMPLETED'
        ? match.resultReason || 'Match completed'
        : isMyTurn
          ? 'Your turn — grab & pull your pen'
          : `${activePlayerName}'s turn — waiting for shot`;

  const renderPlayerCard = (slot: 1 | 2) => {
    const player = slot === 1 ? p1 : p2;
    const pen = slot === 1 ? penStates.player1 : penStates.player2;
    const isActive = match.status === 'ACTIVE' && activeSlot === slot;
    const isMe = player?.uid === myUserId;
    const isOnline = player ? onlineUserIds.includes(player.uid) : false;

    return (
      <div
        className={`pointer-events-auto paper-shadow-sm flex items-center gap-2 rounded-lg border-[1.5px] px-2.5 py-1.5 transition-colors sm:gap-3 sm:px-3.5 sm:py-2 ${
          isActive
            ? slot === 1
              ? 'border-[#365B82] bg-[#E8EFF6]'
              : 'border-[#9E3B36] bg-[#F9EAE9]'
            : 'border-[#45413C] bg-[#FFFDF8]'
        }`}
      >
        <span
          className={`h-6 w-1.5 rounded-sm ${slot === 1 ? 'bg-[#4F6D8A]' : 'bg-[#B55450]'}`}
          aria-hidden="true"
        />
        <div className="min-w-0 leading-tight">
          <div className="flex items-center gap-1.5 text-xs font-bold text-[#292725] sm:text-sm">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? 'bg-[#2E664B]' : 'bg-[#8D8579]'}`}
              title={isOnline ? 'Online' : 'Disconnected'}
            />
            <span className="max-w-[110px] truncate sm:max-w-[150px]">
              {player?.profile.displayName || player?.profile.username || `Player ${slot}`}
            </span>
            {isMe && (
              <span className="rounded border border-[#365B82]/40 bg-[#E8EFF6] px-1 py-0.2 text-[9px] font-bold uppercase text-[#365B82]">
                You
              </span>
            )}
          </div>
          <div className="truncate text-[9px] font-semibold text-[#6E6A64] sm:text-[10px]">
            <span className="font-mono-num">
              {player?.profile.username ? `@${player.profile.username}` : `P${slot}`}
            </span>
            {' · '}
            <span className="uppercase tracking-wider">
              {PEN_SPECS[pen.penType].label} · {pen.shotsCount}S
            </span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <header className="pointer-events-none safe-pad-top safe-pad-x fixed inset-x-0 top-0 z-20 w-full p-2 sm:p-4">
        <div className="flex w-full flex-wrap items-start justify-between gap-2 sm:flex-nowrap sm:gap-3">
          <div className="order-1">{renderPlayerCard(1)}</div>

          <div className="order-2 flex items-start gap-1.5 sm:order-3 sm:gap-2">
            {renderPlayerCard(2)}
            <PerformanceOverlay
              monitor={monitor}
              visible={showFps}
              className="pointer-events-auto shrink-0"
            />
          </div>

          <div className="pointer-events-none order-3 flex w-full flex-col items-center gap-1.5 sm:order-2 sm:w-auto">
            <div className="paper-shadow-sm flex max-w-[min(92vw,34rem)] items-center gap-2 rounded-lg border-[1.5px] border-[#45413C] bg-[#FFFDF8] px-3 py-1 text-center text-[11px] font-semibold text-[#292725] sm:text-xs">
              {(isSubmittingShot || isReplayingShot) && (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#4F6D8A]" />
              )}
              <span className="truncate">{statusText}</span>
              {match.turnTimerSeconds > 0 && match.status === 'ACTIVE' && (
                <span
                  className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono-num text-[11px] font-bold ${
                    secondsRemaining <= 5
                      ? 'border-[#9E3B36] bg-[#F9EAE9] text-[#9E3B36]'
                      : 'border-[#45413C]/40 bg-[#EFEAE0] text-[#292725]'
                  }`}
                >
                  <Clock className="h-3 w-3" />
                  {secondsRemaining}s
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 text-[10px] font-bold">
              <span className="paper-shadow-sm rounded border border-[#45413C] bg-[#FFFDF8] px-2 py-0.5 font-mono-num text-[#57534E]">
                Room {snapshot.room.roomCode} · Turn #{match.turnNumber}
              </span>
              <span
                className={`paper-shadow-sm inline-flex items-center gap-1 rounded border px-2 py-0.5 ${
                  realtimeStatus === 'CONNECTED'
                    ? 'border-[#2E664B] bg-[#E6F2EC] text-[#2E664B]'
                    : 'border-[#9C6C2B] bg-[#FBF3E2] text-[#85581A]'
                }`}
              >
                {realtimeStatus === 'CONNECTED' ? (
                  <Wifi className="h-3 w-3" />
                ) : (
                  <WifiOff className="h-3 w-3" />
                )}
                <span>{realtimeStatus === 'CONNECTED' ? 'Live' : 'Reconnecting'}</span>
              </span>
            </div>

            {opponentDisconnected && !error && (
              <div className="paper-shadow-sm rounded-lg border border-[#9C6C2B] bg-[#FBF3E2] px-3 py-1 text-[11px] font-semibold text-[#754C16]">
                Player disconnected:{' '}
                {opponent?.profile.displayName || `@${opponent?.profile.username}`} is reconnecting...
              </div>
            )}

            {error && (
              <div className="paper-shadow-sm rounded-lg border border-[#9E3B36] bg-[#F9EAE9] px-3 py-1 text-[11px] font-semibold text-[#9E3B36]">
                {error}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Bottom Right Quick Actions */}
      <div className="pointer-events-none safe-pad-bottom fixed bottom-3 right-3 z-20 sm:bottom-4 sm:right-4">
        <div className="pointer-events-auto flex items-center gap-2">
          {confirmForfeit && (
            <div className="paper-shadow-sm flex items-center gap-1.5 rounded-lg border-[1.5px] border-[#9E3B36] bg-[#FFFDF8] px-2.5 py-1 text-xs">
              <span className="font-bold text-[#9E3B36]">Forfeit match?</span>
              <button
                type="button"
                onClick={() => {
                  setConfirmForfeit(false);
                  onForfeit();
                }}
                className="rounded bg-[#9E3B36] px-2 py-0.5 font-bold text-[#FFFDF8]"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirmForfeit(false)}
                className="rounded border border-[#45413C]/40 px-2 py-0.5 font-bold text-[#292725]"
              >
                No
              </button>
            </div>
          )}

          <div className="paper-shadow-sm flex items-center gap-0.5 rounded-lg border-[1.5px] border-[#45413C] bg-[#FFFDF8] p-1">
            <button
              type="button"
              onClick={onToggleSfx}
              title={sfxEnabled ? 'Mute sound' : 'Unmute sound'}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[#292725] hover:bg-[#EFEAE0]"
            >
              {sfxEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5 text-[#9E3B36]" />}
            </button>
            <span className="h-4 w-px bg-[#D9C5A8]" aria-hidden="true" />
            <button
              type="button"
              onClick={() => setConfirmForfeit((v) => !v)}
              title="Forfeit Online Match"
              className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-bold text-[#9E3B36] hover:bg-[#F9EAE9]"
            >
              <Flag className="h-3.5 w-3.5" />
              <span>Forfeit</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
