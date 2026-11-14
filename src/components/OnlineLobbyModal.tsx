import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Edit3,
  Globe,
  Loader2,
  LogIn,
  LogOut,
  Play,
  PlusCircle,
  RefreshCw,
  ShieldCheck,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { TURN_TIMER_OPTIONS, TurnTimerOption } from '../game/MultiplayerTypes';
import type { OnlineAuthState } from '../online/useOnlineAuth';
import type { OnlineRoomController } from '../online/useOnlineRoom';
import {
  ARENA_ORDER,
  ARENA_SPECS,
  ArenaId,
  DESHI_COLOR_VARIANTS,
  DeshiColorVariantId,
  getDeshiColorVariantSpec,
  PEN_SPECS,
  PenTypeId,
} from '../utils/Constants';
import { PaperDivider, PaperModalShell, PaperSectionLabel } from './PaperUI';
import { isProfileComplete } from '../shared/ProfileValidation';

interface OnlineLobbyModalProps {
  isOpen: boolean;
  auth: OnlineAuthState;
  room: OnlineRoomController;
  unlockedPens: PenTypeId[];
  defaultPen: PenTypeId;
  defaultDeshiVariant: DeshiColorVariantId;
  defaultArena: ArenaId;
  onEditProfile: () => void;
  onClose: () => void;
}

export const OnlineLobbyModal: React.FC<OnlineLobbyModalProps> = ({
  isOpen,
  auth,
  room,
  unlockedPens,
  defaultPen,
  defaultDeshiVariant,
  defaultArena,
  onEditProfile,
  onClose,
}) => {
  const [selectedArena, setSelectedArena] = useState<ArenaId>(defaultArena);
  const [selectedTimer, setSelectedTimer] = useState<TurnTimerOption>(15);
  const [selectedPen, setSelectedPen] = useState<PenTypeId>(defaultPen);
  const [selectedDeshiVariant, setSelectedDeshiVariant] =
    useState<DeshiColorVariantId>(defaultDeshiVariant);
  const [joinCode, setJoinCode] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedPen(defaultPen);
    setSelectedDeshiVariant(defaultDeshiVariant);
    setSelectedArena(defaultArena);
  }, [isOpen, defaultPen, defaultDeshiVariant, defaultArena]);

  if (!isOpen) return null;

  const profileComplete = isProfileComplete(auth.profile);

  const snap = room.snapshot;
  const inWaitingRoom = Boolean(snap && snap.room.status === 'WAITING');
  const myUserId = auth.user?.uid ?? null;
  const meInRoom = snap?.players.find((p) => p.uid === myUserId) ?? null;
  const p1 = snap?.players.find((p) => p.slot === 1) ?? null;
  const p2 = snap?.players.find((p) => p.slot === 2) ?? null;
  const isHost = Boolean(snap && myUserId && snap.room.hostUid === myUserId);
  const canHostStart = Boolean(isHost && p1 && p2 && p1.isReady && p2.isReady);

  const combinedError = auth.error || room.error;

  const handleCopyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      // Fallback ignored
    }
  };

  return (
    <PaperModalShell
      title={inWaitingRoom ? `Private Room · ${snap?.room.roomCode}` : 'Online 1v1 Multiplayer'}
      subtitle={
        inWaitingRoom
          ? 'Server-authoritative private 1v1 lobby'
          : 'Google sign-in · Private rooms · Turn-based Rapier 3D'
      }
      icon={<Globe className="h-4 w-4" />}
      onClose={onClose}
      maxWidthClass="max-w-2xl"
      zIndexClass="z-40"
      footer={
        inWaitingRoom && snap ? (
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <button
              type="button"
              disabled={room.busyAction !== null}
              onClick={() => void room.leaveRoom()}
              className="paper-btn flex min-h-[40px] items-center gap-1.5 rounded-lg border-[1.5px] border-[#9E3B36] bg-[#F9EAE9] px-4 text-xs font-bold text-[#9E3B36] hover:bg-[#F3D7D5] disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>{isHost ? 'Close Room' : 'Leave Room'}</span>
            </button>

            <div className="flex flex-wrap items-center gap-2">
              {meInRoom && (
                <button
                  type="button"
                  disabled={room.busyAction !== null}
                  onClick={() => void room.updateReadyAndLoadout({ isReady: !meInRoom.isReady })}
                  className={`paper-btn flex min-h-[40px] items-center gap-1.5 rounded-lg border-[1.5px] px-4 text-xs font-bold uppercase tracking-[0.04em] disabled:opacity-50 ${
                    meInRoom.isReady
                      ? 'border-[#2E664B] bg-[#E6F2EC] text-[#2E664B]'
                      : 'border-[#45413C] bg-[#FFFDF8] text-[#292725] hover:bg-[#EFEAE0]'
                  }`}
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>{meInRoom.isReady ? 'Ready ✓' : 'Mark Ready'}</span>
                </button>
              )}

              {isHost && (
                <button
                  type="button"
                  disabled={!canHostStart || room.busyAction !== null}
                  onClick={() => void room.startMatch()}
                  className="paper-btn flex min-h-[40px] items-center gap-1.5 rounded-lg border-[1.5px] border-[#45413C] bg-[#4F6D8A] px-5 text-xs font-bold uppercase tracking-[0.05em] text-[#FFFDF8] hover:bg-[#435E79] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {room.busyAction === 'start' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5 fill-current" />
                  )}
                  <span>Start Match</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 text-[11px] text-[#6E6A64]">
            <span>All shots are simulated and validated server-side.</span>
            <button
              type="button"
              onClick={onClose}
              className="paper-btn min-h-[36px] rounded-lg border border-[#45413C] bg-[#FFFDF8] px-3.5 text-xs font-bold text-[#292725] hover:bg-[#EFEAE0]"
            >
              Back to Menu
            </button>
          </div>
        )
      }
    >
      <div className="space-y-4 p-4 sm:p-6">
        {combinedError && (
          <div className="flex items-start justify-between gap-2 rounded-xl border-[1.5px] border-[#9E3B36] bg-[#F9EAE9] p-3 text-xs text-[#9E3B36]">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{combinedError}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                auth.clearError();
                room.clearError();
              }}
              className="shrink-0 font-bold underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Setup Needed Banner (when client/backend/RTDB env vars are not yet provisioned) */}
        {(!auth.clientConfigured || auth.backendConfigured === false) && (
          <div className="space-y-2 rounded-xl border-[1.5px] border-[#9C6C2B] bg-[#FBF3E2] p-4 text-xs text-[#754C16]">
            <div className="flex items-center gap-2 font-bold uppercase tracking-wider">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              <span>
                {auth.clientConfigured
                  ? 'Server & Realtime Database Setup Remaining'
                  : 'Firebase Online Configuration Required'}
              </span>
            </div>
            <p className="leading-relaxed">
              {auth.clientConfigured ? (
                <>
                  Firebase Auth (<code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">pen-fight-arena-18</code>) is active for Google Sign-In. To enable multiplayer rooms and match history, create a Firebase Realtime Database and set{' '}
                  <code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">VITE_FIREBASE_DATABASE_URL</code>,{' '}
                  <code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">FIREBASE_DATABASE_URL</code>,{' '}
                  <code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">FIREBASE_CLIENT_EMAIL</code>, and{' '}
                  <code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">FIREBASE_PRIVATE_KEY</code> in your server environment, then deploy{' '}
                  <code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">database.rules.json</code>.
                </>
              ) : (
                <>
                  Online 1v1 is wired to Firebase Authentication, Firebase Realtime Database, and
                  server-side Rapier physics. Configure your{' '}
                  <code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">VITE_FIREBASE_*</code>{' '}
                  client keys and server{' '}
                  <code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">FIREBASE_PROJECT_ID</code>
                  ,{' '}
                  <code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">
                    FIREBASE_CLIENT_EMAIL
                  </code>
                  ,{' '}
                  <code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">
                    FIREBASE_PRIVATE_KEY
                  </code>
                  , and{' '}
                  <code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">
                    FIREBASE_DATABASE_URL
                  </code>{' '}
                  environment variables, deploy{' '}
                  <code className="rounded bg-[#FFFDF8] px-1 py-0.5 font-mono-num">database.rules.json</code>
                  , and enable Google Sign-In in Firebase Console.
                </>
              )}
            </p>
          </div>
        )}

        {/* Phase A: Loading */}
        {auth.loading && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-xs text-[#6E6A64]">
            <Loader2 className="h-6 w-6 animate-spin text-[#4F6D8A]" />
            <span>Checking your Firebase session...</span>
          </div>
        )}

        {/* Phase B: Unauthenticated — Google Sign-In Gate */}
        {!auth.loading && !auth.user && (
          <div className="space-y-4 rounded-xl border-[1.5px] border-[#45413C] bg-[#F7F3EA] p-5 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border-[1.5px] border-[#45413C] bg-[#E8EFF6] text-[#365B82]">
              <LogIn className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <h3 className="font-display text-lg font-extrabold uppercase tracking-[0.03em] text-[#292725]">
                Sign In to Play Online 1v1
              </h3>
              <p className="mx-auto max-w-md text-xs leading-relaxed text-[#57534E]">
                Sign in with Google via Firebase Authentication to create your duelist profile, track
                verified Wins/Losses/Draws, and challenge friends in private 6-character rooms.
              </p>
            </div>

            <button
              type="button"
              disabled={!auth.clientConfigured || auth.signingIn}
              onClick={() => void auth.signIn()}
              className="paper-btn mx-auto flex min-h-[46px] items-center justify-center gap-2.5 rounded-lg border-[1.5px] border-[#45413C] bg-[#4F6D8A] px-6 text-xs font-bold uppercase tracking-[0.05em] text-[#FFFDF8] hover:bg-[#435E79] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {auth.signingIn ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="h-4 w-4" />
              )}
              <span>{auth.signingIn ? 'Opening Google Sign-In...' : 'Continue with Google'}</span>
            </button>
          </div>
        )}

        {/* Phase C: Authenticated — Profile Card */}
        {!auth.loading && auth.user && (
          <div className="rounded-xl border-[1.5px] border-[#45413C] bg-[#F7F3EA] p-3.5 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                {auth.profile?.photoURL || auth.user.photoURL ? (
                  <img
                    src={auth.profile?.photoURL || auth.user.photoURL || undefined}
                    alt={auth.profile?.nickname || auth.user.displayName || 'Player'}
                    referrerPolicy="no-referrer"
                    className="h-11 w-11 shrink-0 rounded-lg border border-[#45413C] object-cover"
                  />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[#45413C] bg-[#E8EFF6] font-display text-base font-extrabold text-[#365B82]">
                    {(auth.profile?.nickname || auth.user.displayName || 'P').slice(0, 2).toUpperCase()}
                  </div>
                )}

                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-bold text-[#292725]">
                      {auth.profile?.displayName ||
                        (auth.backendConfigured === false
                          ? auth.user.displayName || 'Google Account Signed In'
                          : 'Loading profile...')}
                    </span>
                    {auth.profile && (
                      <button
                        type="button"
                        onClick={onEditProfile}
                        title="Edit profile"
                        className="rounded p-1 text-[#6E6A64] hover:bg-[#EFEAE0] hover:text-[#292725]"
                      >
                        <Edit3 className="h-3 w-3" />
                      </button>
                    )}
                  </div>

                  <div className="truncate font-mono-num text-[11px] font-semibold text-[#6E6A64]">
                    {auth.profile?.username
                      ? `@${auth.profile.username}`
                      : auth.user.email || 'Setup required'}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {auth.profile && (
                  <div className="flex items-center gap-2 rounded-lg border border-[#45413C]/40 bg-[#FFFDF8] px-2.5 py-1 font-mono-num text-[11px] font-bold">
                    <span className="text-[#365B82]">{auth.profile.wins}W</span>
                    <span className="text-[#9E3B36]">{auth.profile.losses}L</span>
                    <span className="text-[#85581A]">{auth.profile.draws}D</span>
                  </div>
                )}

                {!inWaitingRoom && (
                  <button
                    type="button"
                    onClick={() => void auth.signOut()}
                    title="Sign out"
                    className="paper-btn flex h-8 items-center gap-1 rounded-lg border border-[#45413C] bg-[#FFFDF8] px-2.5 text-[11px] font-bold text-[#292725] hover:bg-[#EFEAE0]"
                  >
                    <LogOut className="h-3 w-3" />
                    <span>Sign Out</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Phase D: Waiting Room View */}
        {!auth.loading && auth.user && inWaitingRoom && snap && (
          <div className="space-y-4">
            {/* Room Code & Connection Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-[1.5px] border-[#365B82] bg-[#E8EFF6] p-3.5">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#365B82]">
                  Share Room Code With Opponent
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="font-mono-num text-2xl font-extrabold tracking-[0.22em] text-[#292725]">
                    {snap.room.roomCode}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopyCode(snap.room.roomCode)}
                    className="paper-btn flex h-8 items-center gap-1 rounded-lg border border-[#365B82] bg-[#FFFDF8] px-2.5 text-[11px] font-bold text-[#365B82]"
                  >
                    {copiedCode ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>{copiedCode ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-bold ${
                    room.realtimeStatus === 'CONNECTED'
                      ? 'border-[#2E664B] bg-[#E6F2EC] text-[#2E664B]'
                      : 'border-[#9C6C2B] bg-[#FBF3E2] text-[#85581A]'
                  }`}
                >
                  {room.realtimeStatus === 'CONNECTED' ? (
                    <Wifi className="h-3.5 w-3.5" />
                  ) : (
                    <WifiOff className="h-3.5 w-3.5" />
                  )}
                  <span>{room.realtimeStatus === 'CONNECTED' ? 'Realtime Live' : 'Syncing...'}</span>
                </span>

                <button
                  type="button"
                  onClick={() => void room.refreshRoom()}
                  title="Refresh room"
                  className="paper-btn flex h-8 w-8 items-center justify-center rounded-lg border border-[#45413C] bg-[#FFFDF8] text-[#292725]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Player 1 & Player 2 Cards */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {([1, 2] as const).map((slot) => {
                const player = slot === 1 ? p1 : p2;
                const isBlue = slot === 1;
                const online = player ? room.onlineUserIds.includes(player.uid) : false;

                if (!player) {
                  return (
                    <div
                      key={slot}
                      className="flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-[#8D8579] bg-[#F7F3EA]/70 p-4 text-center text-xs text-[#6E6A64]"
                    >
                      <Users className="h-5 w-5 animate-pulse text-[#8D8579]" />
                      <div className="font-bold text-[#292725]">Waiting for Player 2...</div>
                      <div>Share code {snap.room.roomCode}</div>
                    </div>
                  );
                }

                const penSpec = PEN_SPECS[player.penType];
                const deshiSpec =
                  player.penType === 'DESHI_PEN'
                    ? getDeshiColorVariantSpec(player.deshiVariant)
                    : null;

                return (
                  <div
                    key={slot}
                    className={`rounded-xl border-[1.5px] p-3.5 ${
                      isBlue
                        ? 'border-[#365B82] bg-[#E8EFF6]/70'
                        : 'border-[#9E3B36] bg-[#F9EAE9]/70'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        {player.profile.photoURL ? (
                          <img
                            src={player.profile.photoURL}
                            alt={player.profile.nickname}
                            referrerPolicy="no-referrer"
                            className="h-9 w-9 shrink-0 rounded-lg border border-[#45413C] object-cover"
                          />
                        ) : (
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#45413C] bg-[#FFFDF8] text-xs font-extrabold text-[#292725]">
                            {player.profile.nickname.slice(0, 2).toUpperCase()}
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${
                                online ? 'bg-[#2E664B]' : 'bg-[#8D8579]'
                              }`}
                              title={online ? 'Online' : 'Connecting'}
                            />
                            <span className="truncate text-sm font-bold text-[#292725]">
                              {player.profile.displayName || player.profile.username}
                            </span>
                          </div>
                          <div className="truncate font-mono-num text-[10px] font-bold text-[#6E6A64]">
                            @{player.profile.username} · {slot === 1 ? 'Blue Host' : 'Red Guest'}
                          </div>
                        </div>
                      </div>

                      <span
                        className={`shrink-0 rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${
                          player.isReady
                            ? 'border-[#2E664B] bg-[#E6F2EC] text-[#2E664B]'
                            : 'border-[#8D8579] bg-[#FFFDF8] text-[#6E6A64]'
                        }`}
                      >
                        {player.isReady ? 'Ready' : 'Not Ready'}
                      </span>
                    </div>

                    <PaperDivider className="my-2.5" />

                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-[#292725]">
                        {penSpec.label}
                        {deshiSpec ? ` (${deshiSpec.label})` : ''}
                      </span>
                      <span className="font-mono-num text-[11px] text-[#6E6A64]">
                        {player.profile.wins}W-{player.profile.losses}L-{player.profile.draws}D
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* My Pen Selection inside Waiting Room */}
            {meInRoom && (
              <div className="space-y-2.5 rounded-xl border border-[#45413C] bg-[#FFFDF8] p-3.5">
                <PaperSectionLabel right="Locked on Match Start">Your Pen Loadout</PaperSectionLabel>
                <div className="flex flex-wrap gap-1.5">
                  {unlockedPens.map((penId) => {
                    const spec = PEN_SPECS[penId];
                    const active = meInRoom.penType === penId;
                    return (
                      <button
                        key={penId}
                        type="button"
                        disabled={room.busyAction !== null}
                        onClick={() =>
                          void room.updateReadyAndLoadout({
                            penType: penId,
                            deshiVariant: meInRoom.deshiVariant,
                          })
                        }
                        className={`rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors ${
                          active
                            ? 'border-[#45413C] bg-[#4F6D8A] text-[#FFFDF8]'
                            : 'border-[#45413C]/40 bg-[#EFEAE0] text-[#292725] hover:bg-[#E5DEC9]'
                        }`}
                      >
                        {spec.label}
                      </button>
                    );
                  })}
                </div>

                {meInRoom.penType === 'DESHI_PEN' && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-[11px] font-semibold text-[#6E6A64]">Deshi Color:</span>
                    <div className="flex items-center gap-1.5">
                      {DESHI_COLOR_VARIANTS.map((v) => {
                        const active = meInRoom.deshiVariant === v.id;
                        return (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => void room.updateReadyAndLoadout({ deshiVariant: v.id })}
                            title={v.label}
                            className={`h-6 w-6 rounded-full border-2 transition-transform ${
                              active ? 'scale-110 border-[#292725]' : 'border-[#45413C]/40'
                            }`}
                            style={{ backgroundColor: v.swatchHex }}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Match Rules (Host Configurable) */}
            <div className="space-y-2.5 rounded-xl border border-[#45413C] bg-[#F7F3EA] p-3.5">
              <PaperSectionLabel right={isHost ? 'Host Controls' : 'Set by Host'}>
                Arena &amp; Turn Timer
              </PaperSectionLabel>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-[11px] font-semibold text-[#57534E]">Arena</div>
                  <div className="grid grid-cols-3 gap-1">
                    {ARENA_ORDER.map((arenaId) => {
                      const active = snap.room.arenaId === arenaId;
                      return (
                        <button
                          key={arenaId}
                          type="button"
                          disabled={!isHost || room.busyAction !== null}
                          onClick={() => void room.updateReadyAndLoadout({ arenaId })}
                          className={`rounded-md border px-1.5 py-1.5 text-[11px] font-bold ${
                            active
                              ? 'border-[#45413C] bg-[#4F6D8A] text-[#FFFDF8]'
                              : 'border-[#45413C]/40 bg-[#FFFDF8] text-[#57534E]'
                          } disabled:cursor-default`}
                        >
                          {ARENA_SPECS[arenaId].shortLabel}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-[11px] font-semibold text-[#57534E]">Turn Timer</div>
                  <div className="grid grid-cols-5 gap-1">
                    {TURN_TIMER_OPTIONS.map((opt) => {
                      const active = snap.room.turnTimerSeconds === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={!isHost || room.busyAction !== null}
                          onClick={() =>
                            void room.updateReadyAndLoadout({ turnTimerSeconds: opt.value })
                          }
                          className={`rounded-md border px-1 py-1.5 text-[11px] font-bold ${
                            active
                              ? 'border-[#45413C] bg-[#4F6D8A] text-[#FFFDF8]'
                              : 'border-[#45413C]/40 bg-[#FFFDF8] text-[#57534E]'
                          } disabled:cursor-default`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Phase E: Create or Join Private Room (only once profile is complete) */}
        {!auth.loading && auth.user && !inWaitingRoom && !profileComplete && (
          <div className="space-y-3 rounded-xl border-[1.5px] border-[#9C6C2B] bg-[#FBF3E2] p-4 text-center text-xs text-[#754C16]">
            <div className="font-display text-sm font-extrabold uppercase tracking-[0.04em] text-[#292725]">
              Profile Setup Required
            </div>
            <p className="leading-relaxed">
              Complete your Name, unique Username, and Gender before creating or joining Online 1v1 rooms.
            </p>
            <button
              type="button"
              onClick={onEditProfile}
              className="paper-btn inline-flex min-h-[40px] items-center justify-center rounded-lg border-[1.5px] border-[#45413C] bg-[#4F6D8A] px-5 text-xs font-bold uppercase tracking-[0.05em] text-[#FFFDF8] hover:bg-[#435E79]"
            >
              Complete Profile Setup
            </button>
          </div>
        )}

        {!auth.loading && auth.user && !inWaitingRoom && profileComplete && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Create Room Card */}
              <div className="flex flex-col justify-between space-y-3 rounded-xl border-[1.5px] border-[#45413C] bg-[#FFFDF8] p-4">
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <PlusCircle className="h-4 w-4 text-[#4F6D8A]" />
                    <h3 className="font-display text-sm font-extrabold uppercase tracking-[0.04em] text-[#292725]">
                      Create Private Room
                    </h3>
                  </div>

                  <div>
                    <div className="mb-1 text-[11px] font-semibold text-[#57534E]">Arena</div>
                    <div className="grid grid-cols-3 gap-1">
                      {ARENA_ORDER.map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setSelectedArena(id)}
                          className={`rounded-md border px-1.5 py-1.5 text-[11px] font-bold ${
                            selectedArena === id
                              ? 'border-[#45413C] bg-[#4F6D8A] text-[#FFFDF8]'
                              : 'border-[#45413C]/40 bg-[#EFEAE0] text-[#57534E]'
                          }`}
                        >
                          {ARENA_SPECS[id].shortLabel}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 text-[11px] font-semibold text-[#57534E]">Turn Timer</div>
                    <div className="grid grid-cols-5 gap-1">
                      {TURN_TIMER_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setSelectedTimer(opt.value)}
                          className={`rounded-md border px-1 py-1.5 text-[11px] font-bold ${
                            selectedTimer === opt.value
                              ? 'border-[#45413C] bg-[#4F6D8A] text-[#FFFDF8]'
                              : 'border-[#45413C]/40 bg-[#EFEAE0] text-[#57534E]'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 text-[11px] font-semibold text-[#57534E]">Your Pen</div>
                    <select
                      value={selectedPen}
                      onChange={(e) => setSelectedPen(e.target.value as PenTypeId)}
                      className="h-9 w-full rounded-lg border border-[#45413C] bg-[#FFFDF8] px-2.5 text-xs font-bold text-[#292725]"
                    >
                      {unlockedPens.map((id) => (
                        <option key={id} value={id}>
                          {PEN_SPECS[id].label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {selectedPen === 'DESHI_PEN' && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-semibold text-[#57534E]">Color:</span>
                      {DESHI_COLOR_VARIANTS.map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => setSelectedDeshiVariant(v.id)}
                          title={v.label}
                          className={`h-5 w-5 rounded-full border-2 ${
                            selectedDeshiVariant === v.id ? 'border-[#292725]' : 'border-[#45413C]/40'
                          }`}
                          style={{ backgroundColor: v.swatchHex }}
                        />
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  disabled={room.busyAction !== null}
                  onClick={() =>
                    void room.createRoom({
                      arenaId: selectedArena,
                      turnTimerSeconds: selectedTimer,
                      penType: selectedPen,
                      deshiVariant: selectedDeshiVariant,
                    })
                  }
                  className="paper-btn flex min-h-[42px] w-full items-center justify-center gap-2 rounded-lg border-[1.5px] border-[#45413C] bg-[#4F6D8A] px-4 text-xs font-bold uppercase tracking-[0.05em] text-[#FFFDF8] hover:bg-[#435E79] disabled:opacity-50"
                >
                  {room.busyAction === 'create' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <PlusCircle className="h-4 w-4" />
                  )}
                  <span>Create Room</span>
                </button>
              </div>

              {/* Join Room Card */}
              <div className="flex flex-col justify-between space-y-3 rounded-xl border-[1.5px] border-[#45413C] bg-[#FFFDF8] p-4">
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-[#2E664B]" />
                    <h3 className="font-display text-sm font-extrabold uppercase tracking-[0.04em] text-[#292725]">
                      Join Private Room
                    </h3>
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-[#57534E]">
                      6-Character Room Code
                    </label>
                    <input
                      type="text"
                      value={joinCode}
                      maxLength={6}
                      placeholder="e.g. K7M4P9"
                      onChange={(e) =>
                        setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                      }
                      className="h-11 w-full rounded-lg border-[1.5px] border-[#45413C] bg-[#F7F3EA] px-3 text-center font-mono-num text-lg font-extrabold tracking-[0.22em] text-[#292725] uppercase focus:outline-none"
                    />
                  </div>

                  <div>
                    <div className="mb-1 text-[11px] font-semibold text-[#57534E]">Your Pen</div>
                    <select
                      value={selectedPen}
                      onChange={(e) => setSelectedPen(e.target.value as PenTypeId)}
                      className="h-9 w-full rounded-lg border border-[#45413C] bg-[#FFFDF8] px-2.5 text-xs font-bold text-[#292725]"
                    >
                      {unlockedPens.map((id) => (
                        <option key={id} value={id}>
                          {PEN_SPECS[id].label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <p className="text-[11px] leading-relaxed text-[#6E6A64]">
                    Ask your opponent for their room code. Match rules and arena are synced automatically
                    from the host.
                  </p>
                </div>

                <button
                  type="button"
                  disabled={joinCode.trim().length !== 6 || room.busyAction !== null}
                  onClick={() =>
                    void room.joinRoom({
                      roomCode: joinCode.trim(),
                      penType: selectedPen,
                      deshiVariant: selectedDeshiVariant,
                    })
                  }
                  className="paper-btn flex min-h-[42px] w-full items-center justify-center gap-2 rounded-lg border-[1.5px] border-[#45413C] bg-[#2E664B] px-4 text-xs font-bold uppercase tracking-[0.05em] text-[#FFFDF8] hover:bg-[#24523C] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {room.busyAction === 'join' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <LogIn className="h-4 w-4" />
                  )}
                  <span>Join Room</span>
                </button>
              </div>
            </div>

            {auth.matchHistory.length > 0 && (
              <div className="rounded-xl border border-[#45413C] bg-[#F7F3EA] p-3.5">
                <PaperSectionLabel right={`${auth.matchHistory.length} Recent`}>
                  Recent Online Matches
                </PaperSectionLabel>
                <div className="mt-2 space-y-1.5">
                  {auth.matchHistory.slice(0, 4).map((item) => (
                    <div
                      key={item.matchId}
                      className="flex items-center justify-between gap-2 rounded-lg border border-[#45413C]/30 bg-[#FFFDF8] px-3 py-1.5 text-xs"
                    >
                      <div className="min-w-0 truncate">
                        <span
                          className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                            item.outcome === 'WIN'
                              ? 'bg-[#E6F2EC] text-[#2E664B]'
                              : item.outcome === 'LOSS'
                                ? 'bg-[#F9EAE9] text-[#9E3B36]'
                                : 'bg-[#FBF3E2] text-[#754C16]'
                          }`}
                        >
                          {item.outcome}
                        </span>
                        <span className="font-semibold text-[#292725]">
                          vs @{item.opponentNickname}
                        </span>
                      </div>
                      <span className="shrink-0 font-mono-num text-[11px] text-[#6E6A64]">
                        {ARENA_SPECS[item.arenaId]?.shortLabel ?? item.arenaId} · {item.turnsPlayed}T
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </PaperModalShell>
  );
};
