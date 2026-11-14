import React from 'react';
import { Award, Home, PlusCircle, Scale, ShieldAlert, Trophy } from 'lucide-react';
import type { RoomSnapshot, UserProfile } from '../shared/OnlineTypes';
import { PEN_SPECS } from '../utils/Constants';
import { PaperDivider, PaperModalShell } from './PaperUI';

interface OnlineResultModalProps {
  snapshot: RoomSnapshot | null;
  myUserId: string | null;
  profile: UserProfile | null;
  isReplayingShot: boolean;
  onPlayNewMatch: () => void;
  onExitToMenu: () => void;
}

export const OnlineResultModal: React.FC<OnlineResultModalProps> = ({
  snapshot,
  myUserId,
  profile,
  isReplayingShot,
  onPlayNewMatch,
  onExitToMenu,
}) => {
  if (!snapshot?.match || snapshot.match.status !== 'COMPLETED' || isReplayingShot || !myUserId) {
    return null;
  }

  const match = snapshot.match;
  const p1 = snapshot.players.find((p) => p.slot === 1);
  const p2 = snapshot.players.find((p) => p.slot === 2);
  const pen1 = snapshot.matchState?.penStates.player1;
  const pen2 = snapshot.matchState?.penStates.player2;

  const isDraw = match.resultType === 'DRAW';
  const didWin = match.winnerUid === myUserId;

  const title = isDraw ? 'Match Draw' : didWin ? 'Victory!' : 'Defeat';
  const badgeStyle = isDraw
    ? 'border-[#9C6C2B] bg-[#FBF3E2] text-[#754C16]'
    : didWin
      ? 'border-[#2E664B] bg-[#E6F2EC] text-[#2E664B]'
      : 'border-[#9E3B36] bg-[#F9EAE9] text-[#9E3B36]';

  return (
    <PaperModalShell
      title={title}
      subtitle={`Online 1v1 · Room ${snapshot.room.roomCode}`}
      icon={
        isDraw ? (
          <Scale className="h-4 w-4" />
        ) : didWin ? (
          <Trophy className="h-4 w-4" />
        ) : (
          <ShieldAlert className="h-4 w-4" />
        )
      }
      onClose={onExitToMenu}
      maxWidthClass="max-w-lg"
      zIndexClass="z-40"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onExitToMenu}
            className="paper-btn flex min-h-[40px] items-center gap-1.5 rounded-lg border-[1.5px] border-[#45413C] bg-[#FFFDF8] px-4 text-xs font-bold text-[#292725] hover:bg-[#EFEAE0]"
          >
            <Home className="h-3.5 w-3.5" />
            <span>Main Menu</span>
          </button>
          <button
            type="button"
            onClick={onPlayNewMatch}
            className="paper-btn flex min-h-[40px] items-center gap-1.5 rounded-lg border-[1.5px] border-[#45413C] bg-[#4F6D8A] px-5 text-xs font-bold uppercase tracking-[0.05em] text-[#FFFDF8] hover:bg-[#435E79]"
          >
            <PlusCircle className="h-3.5 w-3.5" />
            <span>Online Lobby</span>
          </button>
        </div>
      }
    >
      <div className="space-y-4 p-4 sm:p-6">
        <div className={`rounded-xl border-[1.5px] p-4 text-center ${badgeStyle}`}>
          <div className="font-display text-2xl font-extrabold uppercase tracking-[0.04em]">
            {title}
          </div>
          <p className="mt-1 text-xs font-semibold">
            {match.resultReason || 'Authoritative match result committed.'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {[
            { slot: 1 as const, player: p1, pen: pen1 },
            { slot: 2 as const, player: p2, pen: pen2 },
          ].map(({ slot, player, pen }) => {
            const isWinner = match.winnerUid && player?.uid === match.winnerUid;
            return (
              <div
                key={slot}
                className={`rounded-xl border-[1.5px] p-3 text-xs ${
                  isWinner
                    ? 'border-[#2E664B] bg-[#E6F2EC]/60'
                    : 'border-[#45413C] bg-[#F7F3EA]'
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0">
                    <div className="truncate font-bold text-[#292725]">
                      {player?.profile.displayName || player?.profile.username || `Player ${slot}`}
                    </div>
                    {player?.profile.username && (
                      <div className="truncate font-mono-num text-[10px] font-semibold text-[#6E6A64]">
                        @{player.profile.username}
                      </div>
                    )}
                  </div>
                  {isWinner && (
                    <span className="shrink-0 rounded bg-[#2E664B] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#FFFDF8]">
                      Winner
                    </span>
                  )}
                </div>
                {pen && (
                  <div className="mt-1.5 space-y-0.5 text-[11px] text-[#57534E]">
                    <div>Pen: {PEN_SPECS[pen.penType].label}</div>
                    <div>Shots: {pen.shotsCount}</div>
                    <div>Turns Skipped: {pen.skipsCount}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {profile && (
          <>
            <PaperDivider />
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#45413C] bg-[#EFEAE0] px-4 py-2.5 text-xs">
              <span className="flex items-center gap-1.5 font-bold text-[#292725]">
                <Award className="h-4 w-4 text-[#85581A]" />
                <span>Your Career Online Record</span>
              </span>
              <span className="font-mono-num font-bold text-[#292725]">
                {profile.wins}W · {profile.losses}L · {profile.draws}D ({profile.totalMatches} Matches)
              </span>
            </div>
          </>
        )}
      </div>
    </PaperModalShell>
  );
};
