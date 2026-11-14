import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import type { MatchHistoryRecord, UserProfile } from '../shared/OnlineTypes';
import { isProfileComplete, ProfileGender } from '../shared/ProfileValidation';
import {
  getFirebaseAuth,
  isFirebaseConfigured,
  signInWithGoogle,
  signOutOnline,
} from './firebaseClient';
import {
  checkOnlineHealth,
  completeMyProfile,
  fetchMyProfile,
  OnlineApiError,
  registerSessionExpiredHandler,
  updateMyNickname,
  updateMyProfile,
} from './onlineApi';

export interface ProfileActionResult {
  ok: boolean;
  error?: string;
}

export interface OnlineAuthState {
  clientConfigured: boolean;
  backendConfigured: boolean | null;
  loading: boolean;
  signingIn: boolean;
  user: FirebaseUser | null;
  profile: UserProfile | null;
  needsProfileSetup: boolean;
  matchHistory: MatchHistoryRecord[];
  error: string | null;
  clearError: () => void;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  completeProfile: (params: {
    displayName: string;
    username: string;
    gender: ProfileGender;
  }) => Promise<ProfileActionResult>;
  updateProfile: (params: {
    displayName?: string;
    username?: string;
    gender?: ProfileGender;
  }) => Promise<ProfileActionResult>;
  updateNickname: (nickname: string) => Promise<boolean>;
}

export function useOnlineAuth(): OnlineAuthState {
  const clientConfigured = isFirebaseConfigured();
  const [backendConfigured, setBackendConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState<boolean>(clientConfigured);
  const [signingIn, setSigningIn] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [matchHistory, setMatchHistory] = useState<MatchHistoryRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadProfileForUser = useCallback(async (activeUser: FirebaseUser | null) => {
    if (!activeUser) {
      setProfile(null);
      setMatchHistory([]);
      return;
    }
    try {
      const res = await fetchMyProfile(true);
      setProfile(res.profile);
      setMatchHistory(res.matchHistory ?? []);
      setError(null);
    } catch (err) {
      if (err instanceof OnlineApiError && err.status === 401) {
        await signOutOnline();
        setUser(null);
        setProfile(null);
        setMatchHistory([]);
        setError('Authentication expired. Please sign in with Google again.');
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to load online profile.';
      setError(msg);
    }
  }, []);

  useEffect(() => {
    void checkOnlineHealth()
      .then((res) => setBackendConfigured(res.firebaseConfigured))
      .catch(() => setBackendConfigured(false));
  }, []);

  useEffect(() => {
    registerSessionExpiredHandler(() => {
      void signOutOnline();
      setUser(null);
      setProfile(null);
      setMatchHistory([]);
      setError('Authentication expired. Please sign in with Google again.');
    });
    return () => registerSessionExpiredHandler(null);
  }, []);

  useEffect(() => {
    const auth = getFirebaseAuth();
    if (!auth) {
      setLoading(false);
      return;
    }

    let mounted = true;
    const unsubscribe = onAuthStateChanged(
      auth,
      (nextUser) => {
        if (!mounted) return;
        setUser(nextUser);
        if (!nextUser) {
          setProfile(null);
          setMatchHistory([]);
          setLoading(false);
          return;
        }
        void loadProfileForUser(nextUser).finally(() => {
          if (mounted) setLoading(false);
        });
      },
      (authErr) => {
        if (!mounted) return;
        setError(authErr.message || 'Firebase authentication error.');
        setLoading(false);
      }
    );

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [loadProfileForUser]);

  const signIn = useCallback(async () => {
    setError(null);
    setSigningIn(true);
    try {
      const res = await signInWithGoogle();
      if (res.error) {
        setError(res.error);
      }
    } finally {
      setSigningIn(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    await signOutOnline();
    setUser(null);
    setProfile(null);
    setMatchHistory([]);
  }, []);

  const refreshProfile = useCallback(async () => {
    await loadProfileForUser(user);
  }, [loadProfileForUser, user]);

  const completeProfile = useCallback(
    async (params: {
      displayName: string;
      username: string;
      gender: ProfileGender;
    }): Promise<ProfileActionResult> => {
      setError(null);
      try {
        const next = await completeMyProfile(params);
        setProfile(next);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not complete profile setup.';
        setError(msg);
        return { ok: false, error: msg };
      }
    },
    []
  );

  const updateProfile = useCallback(
    async (params: {
      displayName?: string;
      username?: string;
      gender?: ProfileGender;
    }): Promise<ProfileActionResult> => {
      setError(null);
      try {
        const next = await updateMyProfile(params);
        setProfile(next);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not update profile.';
        setError(msg);
        return { ok: false, error: msg };
      }
    },
    []
  );

  const updateNickname = useCallback(async (nickname: string): Promise<boolean> => {
    setError(null);
    try {
      const next = await updateMyNickname(nickname);
      setProfile(next);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not update username.';
      setError(msg);
      return false;
    }
  }, []);

  const needsProfileSetup = Boolean(
    !loading && user && profile && !isProfileComplete(profile)
  );

  return {
    clientConfigured,
    backendConfigured,
    loading,
    signingIn,
    user,
    profile,
    needsProfileSetup,
    matchHistory,
    error,
    clearError: () => setError(null),
    signIn,
    signOut,
    refreshProfile,
    completeProfile,
    updateProfile,
    updateNickname,
  };
}
