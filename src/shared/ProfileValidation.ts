export type ProfileGender = 'male' | 'female' | 'prefer_not_to_say';

export const PROFILE_GENDER_OPTIONS: ReadonlyArray<{
  value: ProfileGender;
  label: string;
}> = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
] as const;

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 24;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16;
export const USERNAME_REGEX = /^[a-z0-9_]{3,16}$/;

export function normalizeDisplayName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function validateDisplayName(raw: string): {
  valid: boolean;
  normalized: string;
  error: string | null;
} {
  const normalized = normalizeDisplayName(raw);
  if (normalized.length < DISPLAY_NAME_MIN) {
    return {
      valid: false,
      normalized,
      error: `Name must be at least ${DISPLAY_NAME_MIN} characters.`,
    };
  }
  if (normalized.length > DISPLAY_NAME_MAX) {
    return {
      valid: false,
      normalized,
      error: `Name cannot exceed ${DISPLAY_NAME_MAX} characters.`,
    };
  }
  return { valid: true, normalized, error: null };
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateUsernameFormat(raw: string): {
  valid: boolean;
  normalized: string;
  error: string | null;
} {
  const normalized = normalizeUsername(raw);
  if (!normalized) {
    return {
      valid: false,
      normalized,
      error: 'Username is required.',
    };
  }
  if (/\s/.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Username cannot contain spaces.',
    };
  }
  if (normalized.length < USERNAME_MIN) {
    return {
      valid: false,
      normalized,
      error: `Username must be at least ${USERNAME_MIN} characters.`,
    };
  }
  if (normalized.length > USERNAME_MAX) {
    return {
      valid: false,
      normalized,
      error: `Username cannot exceed ${USERNAME_MAX} characters.`,
    };
  }
  if (!USERNAME_REGEX.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Use only lowercase letters (a-z), numbers (0-9), and underscores (_).',
    };
  }
  return { valid: true, normalized, error: null };
}

export function isValidGender(val: unknown): val is ProfileGender {
  return val === 'male' || val === 'female' || val === 'prefer_not_to_say';
}

export function isProfileComplete(
  profile:
    | {
        displayName?: string | null;
        username?: string | null;
        normalizedUsername?: string | null;
        gender?: unknown;
        profileCompleted?: boolean;
      }
    | null
    | undefined
): boolean {
  if (!profile || profile.profileCompleted !== true) return false;
  const nameCheck = validateDisplayName(profile.displayName ?? '');
  if (!nameCheck.valid) return false;
  const usernameCheck = validateUsernameFormat(
    profile.username || profile.normalizedUsername || ''
  );
  if (!usernameCheck.valid) return false;
  if (!isValidGender(profile.gender)) return false;
  return true;
}
