import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AtSign,
  CheckCircle2,
  Loader2,
  Lock,
  LogOut,
  ShieldCheck,
  UserCheck,
  XCircle,
} from 'lucide-react';
import type { OnlineAuthState } from '../online/useOnlineAuth';
import { checkUsernameAvailability } from '../online/onlineApi';
import {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  isValidGender,
  PROFILE_GENDER_OPTIONS,
  ProfileGender,
  USERNAME_MAX,
  USERNAME_MIN,
  validateDisplayName,
  validateUsernameFormat,
} from '../shared/ProfileValidation';
import { PaperDivider, PaperModalShell } from './PaperUI';

type UsernameStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; message: string }
  | { state: 'taken'; message: string }
  | { state: 'invalid'; message: string };

interface ProfileSetupModalProps {
  isOpen: boolean;
  mode?: 'setup' | 'edit';
  auth: OnlineAuthState;
  onCompleteSuccess?: () => void;
  onClose?: () => void;
}

export const ProfileSetupModal: React.FC<ProfileSetupModalProps> = ({
  isOpen,
  mode = 'setup',
  auth,
  onCompleteSuccess,
  onClose,
}) => {
  const profile = auth.profile;
  const user = auth.user;

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [gender, setGender] = useState<ProfileGender | null>(null);
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>({ state: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [touchedName, setTouchedName] = useState(false);
  const [touchedUsername, setTouchedUsername] = useState(false);

  const checkSeqRef = useRef(0);
  const hydratedUidRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen || !profile) {
      hydratedUidRef.current = null;
      return;
    }

    const hydrationKey = `${profile.uid}:${mode}`;
    if (hydratedUidRef.current === hydrationKey) return;
    hydratedUidRef.current = hydrationKey;

    setDisplayName(profile.displayName || '');
    setUsername(profile.username || '');
    setGender(isValidGender(profile.gender) ? profile.gender : null);
    setFormError(null);
    setTouchedName(false);
    setTouchedUsername(false);

    if (profile.username && validateUsernameFormat(profile.username).valid) {
      setUsernameStatus({
        state: 'available',
        message: mode === 'edit' ? 'Current username' : 'Available',
      });
    } else {
      setUsernameStatus({ state: 'idle' });
    }
  }, [isOpen, mode, profile]);

  const normalizedCurrentUsername = (profile?.username || '').trim().toLowerCase();

  // Real-time debounced username availability check
  useEffect(() => {
    if (!isOpen || !user) return;

    const raw = username;
    if (!raw.trim()) {
      checkSeqRef.current += 1;
      setUsernameStatus(
        touchedUsername
          ? { state: 'invalid', message: 'Username is required.' }
          : { state: 'idle' }
      );
      return;
    }

    const format = validateUsernameFormat(raw);
    if (!format.valid) {
      checkSeqRef.current += 1;
      setUsernameStatus({
        state: 'invalid',
        message: format.error ?? 'Invalid Username',
      });
      return;
    }

    if (normalizedCurrentUsername && format.normalized === normalizedCurrentUsername) {
      checkSeqRef.current += 1;
      setUsernameStatus({
        state: 'available',
        message: mode === 'edit' ? 'Current username' : 'Available',
      });
      return;
    }

    const seq = ++checkSeqRef.current;
    setUsernameStatus({ state: 'checking' });

    const timerId = window.setTimeout(() => {
      void checkUsernameAvailability(format.normalized)
        .then((res) => {
          if (checkSeqRef.current !== seq) return;
          if (!res.valid) {
            setUsernameStatus({
              state: 'invalid',
              message: res.reason ?? 'Invalid Username',
            });
          } else if (res.available) {
            setUsernameStatus({
              state: 'available',
              message: 'Available',
            });
          } else {
            setUsernameStatus({
              state: 'taken',
              message: res.reason ?? 'Already Taken',
            });
          }
        })
        .catch(() => {
          if (checkSeqRef.current !== seq) return;
          setUsernameStatus({
            state: 'invalid',
            message: 'Could not verify availability right now.',
          });
        });
    }, 320);

    return () => window.clearTimeout(timerId);
  }, [isOpen, user, username, touchedUsername, normalizedCurrentUsername, mode]);

  const nameValidation = useMemo(() => validateDisplayName(displayName), [displayName]);
  const usernameFormat = useMemo(() => validateUsernameFormat(username), [username]);

  if (!isOpen || !user || !profile) return null;

  const isMandatorySetup = mode === 'setup';
  const avatarUrl = profile.photoURL || user.photoURL;
  const googleEmail = profile.email || user.email || '';
  const googleDisplay = user.displayName || profile.displayName || 'Google Account';

  const canSubmit =
    !submitting &&
    nameValidation.valid &&
    usernameFormat.valid &&
    usernameStatus.state === 'available' &&
    isValidGender(gender);

  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTouchedUsername(true);
    setFormError(null);
    // Automatically convert uppercase to lowercase and strip spaces
    const next = e.target.value.toLowerCase().replace(/\s+/g, '');
    setUsername(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouchedName(true);
    setTouchedUsername(true);
    setFormError(null);

    if (!nameValidation.valid) {
      setFormError(nameValidation.error ?? 'Enter a valid name.');
      return;
    }
    if (!usernameFormat.valid) {
      setFormError(usernameFormat.error ?? 'Enter a valid username.');
      return;
    }
    if (usernameStatus.state !== 'available') {
      setFormError(
        usernameStatus.state === 'checking'
          ? 'Please wait while we check username availability.'
          : 'Please choose an available username.'
      );
      return;
    }
    if (!isValidGender(gender)) {
      setFormError('Please select a gender option to continue.');
      return;
    }

    setSubmitting(true);
    try {
      const action = isMandatorySetup
        ? await auth.completeProfile({
            displayName: nameValidation.normalized,
            username: usernameFormat.normalized,
            gender,
          })
        : await auth.updateProfile({
            displayName: nameValidation.normalized,
            username: usernameFormat.normalized,
            gender,
          });

      if (!action.ok) {
        const msg = action.error || 'Could not save your profile. Please try again.';
        setFormError(msg);
        if (msg.toLowerCase().includes('taken')) {
          setUsernameStatus({ state: 'taken', message: 'Already Taken' });
        }
        return;
      }

      onCompleteSuccess?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PaperModalShell
      title={isMandatorySetup ? 'Complete Your Duelist Profile' : 'Edit Player Profile'}
      subtitle={
        isMandatorySetup
          ? 'Required once after Google Sign-In before entering Online 1v1'
          : 'Update your display name, unique username, or private gender'
      }
      icon={<UserCheck className="h-4 w-4" />}
      onClose={() => {
        if (!isMandatorySetup && !submitting) {
          onClose?.();
        }
      }}
      closeDisabled={isMandatorySetup || submitting}
      maxWidthClass="max-w-lg"
      zIndexClass="z-50"
      headerRight={
        isMandatorySetup ? (
          <button
            type="button"
            disabled={submitting}
            onClick={() => void auth.signOut()}
            className="paper-btn flex h-9 items-center gap-1.5 rounded-lg border border-[#45413C] bg-[#FFFDF8] px-3 text-[11px] font-bold text-[#292725] hover:bg-[#EFEAE0] disabled:opacity-40"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Sign Out</span>
          </button>
        ) : undefined
      }
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 p-4 sm:p-6">
        {/* Google Account Identity Header */}
        <div className="flex items-center gap-3.5 rounded-xl border-[1.5px] border-[#45413C] bg-[#F7F3EA] p-3.5">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={googleDisplay}
              referrerPolicy="no-referrer"
              className="h-12 w-12 shrink-0 rounded-lg border-[1.5px] border-[#45413C] object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border-[1.5px] border-[#45413C] bg-[#E8EFF6] font-display text-base font-extrabold text-[#365B82]">
              {googleDisplay.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#2E664B]">
                Google Verified
              </span>
              <ShieldCheck className="h-3.5 w-3.5 text-[#2E664B]" />
            </div>
            <div className="truncate text-sm font-bold text-[#292725]">{googleDisplay}</div>
            {googleEmail && (
              <div className="truncate text-[11px] font-medium text-[#6E6A64]">{googleEmail}</div>
            )}
          </div>
        </div>

        {formError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border-[1.5px] border-[#9E3B36] bg-[#F9EAE9] p-3 text-xs font-medium text-[#9E3B36]"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{formError}</span>
          </div>
        )}

        {/* Field A: Display Name */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor="profile-display-name"
              className="text-xs font-bold uppercase tracking-[0.08em] text-[#292725]"
            >
              Name <span className="text-[#9E3B36]">*</span>
            </label>
            <span className="font-mono-num text-[11px] text-[#6E6A64]">
              {displayName.trim().length}/{DISPLAY_NAME_MAX}
            </span>
          </div>
          <input
            id="profile-display-name"
            type="text"
            value={displayName}
            maxLength={DISPLAY_NAME_MAX}
            disabled={submitting}
            placeholder="Your duelist display name"
            onChange={(e) => {
              setTouchedName(true);
              setFormError(null);
              setDisplayName(e.target.value);
            }}
            onBlur={() => {
              setTouchedName(true);
              setDisplayName((prev) => prev.trim().replace(/\s+/g, ' '));
            }}
            className="h-11 w-full rounded-lg border-[1.5px] border-[#45413C] bg-[#FFFDF8] px-3.5 text-sm font-semibold text-[#292725] placeholder:text-[#8D8579] focus:border-[#365B82] focus:outline-none disabled:opacity-60"
          />
          {touchedName && !nameValidation.valid ? (
            <p className="text-[11px] font-semibold text-[#9E3B36]">{nameValidation.error}</p>
          ) : (
            <p className="text-[11px] text-[#6E6A64]">
              Shown alongside your username ({DISPLAY_NAME_MIN}–{DISPLAY_NAME_MAX} characters, spaces allowed).
            </p>
          )}
        </div>

        {/* Field B: Unique Username */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="profile-username"
              className="text-xs font-bold uppercase tracking-[0.08em] text-[#292725]"
            >
              Username <span className="text-[#9E3B36]">*</span>
            </label>
            <span className="font-mono-num text-[11px] text-[#6E6A64]">
              {username.length}/{USERNAME_MAX}
            </span>
          </div>

          <div className="relative flex items-center">
            <span className="pointer-events-none absolute left-3 text-[#6E6A64]">
              <AtSign className="h-4 w-4" />
            </span>
            <input
              id="profile-username"
              type="text"
              value={username}
              maxLength={USERNAME_MAX}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={submitting}
              placeholder="lowercase_handle"
              onChange={handleUsernameChange}
              onBlur={() => setTouchedUsername(true)}
              className="h-11 w-full rounded-lg border-[1.5px] border-[#45413C] bg-[#FFFDF8] pl-9 pr-32 font-mono-num text-sm font-bold text-[#292725] placeholder:font-sans placeholder:font-normal placeholder:text-[#8D8579] focus:border-[#365B82] focus:outline-none disabled:opacity-60"
            />
            <div className="pointer-events-none absolute right-2.5 flex items-center">
              {usernameStatus.state === 'checking' && (
                <span className="inline-flex items-center gap-1 rounded border border-[#9C6C2B]/50 bg-[#FBF3E2] px-2 py-0.5 text-[10px] font-bold text-[#85581A]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Checking...</span>
                </span>
              )}
              {usernameStatus.state === 'available' && (
                <span className="inline-flex items-center gap-1 rounded border border-[#2E664B] bg-[#E6F2EC] px-2 py-0.5 text-[10px] font-bold text-[#2E664B]">
                  <CheckCircle2 className="h-3 w-3" />
                  <span>Available</span>
                </span>
              )}
              {usernameStatus.state === 'taken' && (
                <span className="inline-flex items-center gap-1 rounded border border-[#9E3B36] bg-[#F9EAE9] px-2 py-0.5 text-[10px] font-bold text-[#9E3B36]">
                  <XCircle className="h-3 w-3" />
                  <span>Already Taken</span>
                </span>
              )}
              {usernameStatus.state === 'invalid' && (
                <span className="inline-flex items-center gap-1 rounded border border-[#9E3B36] bg-[#F9EAE9] px-2 py-0.5 text-[10px] font-bold text-[#9E3B36]">
                  <XCircle className="h-3 w-3" />
                  <span>Invalid Username</span>
                </span>
              )}
            </div>
          </div>

          {usernameStatus.state === 'invalid' || usernameStatus.state === 'taken' ? (
            <p className="text-[11px] font-semibold text-[#9E3B36]">{usernameStatus.message}</p>
          ) : (
            <p className="text-[11px] text-[#6E6A64]">
              Unique handle ({USERNAME_MIN}–{USERNAME_MAX} chars): lowercase a–z, numbers 0–9, and underscores (_).
            </p>
          )}
        </div>

        {/* Field C: Gender (no preselected default) */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-[0.08em] text-[#292725]">
              Gender <span className="text-[#9E3B36]">*</span>
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#6E6A64]">
              <Lock className="h-3 w-3" />
              <span>Private to your account</span>
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Gender">
            {PROFILE_GENDER_OPTIONS.map((opt) => {
              const selected = gender === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={submitting}
                  onClick={() => {
                    setFormError(null);
                    setGender(opt.value);
                  }}
                  className={`flex min-h-[42px] items-center justify-center rounded-lg border-[1.5px] px-3 text-xs font-bold transition-colors ${
                    selected
                      ? 'border-[#365B82] bg-[#E8EFF6] text-[#292725] shadow-[1.5px_1.5px_0px_#365B82]'
                      : 'border-[#45413C]/50 bg-[#FFFDF8] text-[#57534E] hover:bg-[#EFEAE0] hover:text-[#292725]'
                  } disabled:opacity-60`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-[#6E6A64]">
            Stored privately in your profile and never displayed in lobbies or matches.
          </p>
        </div>

        <PaperDivider />

        <div className="flex flex-wrap items-center justify-end gap-2.5">
          {!isMandatorySetup && onClose && (
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="paper-btn min-h-[42px] rounded-lg border-[1.5px] border-[#45413C] bg-[#FFFDF8] px-4 text-xs font-bold text-[#292725] hover:bg-[#EFEAE0] disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={!canSubmit}
            className="paper-btn flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border-[1.5px] border-[#45413C] bg-[#4F6D8A] px-5 text-xs font-bold uppercase tracking-[0.05em] text-[#FFFDF8] hover:bg-[#435E79] disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Saving Profile...</span>
              </>
            ) : (
              <span>
                {isMandatorySetup ? 'Save & Enter Arena' : 'Save Profile Changes'}
              </span>
            )}
          </button>
        </div>
      </form>
    </PaperModalShell>
  );
};
