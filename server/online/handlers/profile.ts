import { z } from 'zod';
import {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_REGEX,
} from '../../../src/shared/ProfileValidation';
import { authenticateRequest, enforceRateLimit } from '../firebaseAdmin';
import {
  ApiRequest,
  ApiResponse,
  getMethod,
  getQueryParam,
  parseValidatedBody,
  sendError,
} from '../http';
import {
  checkUsernameAvailability,
  completeUserProfile,
  ensureUserProfile,
  fetchUserMatchHistory,
  updateUserProfile,
} from '../roomData';

const displayNameSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .refine(
    (s) => s.length >= DISPLAY_NAME_MIN,
    `Name must be at least ${DISPLAY_NAME_MIN} characters.`
  )
  .refine(
    (s) => s.length <= DISPLAY_NAME_MAX,
    `Name cannot exceed ${DISPLAY_NAME_MAX} characters.`
  );

const usernameSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => s.length >= USERNAME_MIN, `Username must be at least ${USERNAME_MIN} characters.`)
  .refine((s) => s.length <= USERNAME_MAX, `Username cannot exceed ${USERNAME_MAX} characters.`)
  .refine(
    (s) => USERNAME_REGEX.test(s),
    'Use only lowercase letters (a-z), numbers (0-9), and underscores (_).'
  );

const genderSchema = z.enum(['male', 'female', 'prefer_not_to_say']);

const completeProfileSchema = z.object({
  displayName: displayNameSchema,
  username: usernameSchema,
  gender: genderSchema,
});

const patchProfileSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    username: usernameSchema.optional(),
    nickname: usernameSchema.optional(),
    gender: genderSchema.optional(),
  })
  .refine(
    (obj) =>
      obj.displayName !== undefined ||
      obj.username !== undefined ||
      obj.nickname !== undefined ||
      obj.gender !== undefined,
    'Provide at least one profile field to update.'
  );

export async function handleProfileMe(req: ApiRequest, res: ApiResponse): Promise<void> {
  const method = getMethod(req);
  if (method !== 'GET' && method !== 'PATCH') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET or PATCH.');
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.error);
    return;
  }

  const { db, user } = auth.ctx;

  if (method === 'GET') {
    try {
      const profile = await ensureUserProfile(db, user);
      const includeHistory = getQueryParam(req, 'includeHistory') === '1';
      if (includeHistory) {
        const matchHistory = await fetchUserMatchHistory(db, user.uid, 15);
        res.status(200).json({ ok: true, profile, matchHistory });
        return;
      }
      res.status(200).json({ ok: true, profile });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load profile.';
      sendError(res, 500, 'PROFILE_LOAD_FAILED', msg);
    }
    return;
  }

  const allowed = await enforceRateLimit(db, `profile_patch:${user.uid}`, 60, 15);
  if (!allowed) {
    sendError(res, 429, 'RATE_LIMITED', 'Too many profile updates. Please wait a moment.');
    return;
  }

  const bodyRes = await parseValidatedBody(req, patchProfileSchema);
  if (bodyRes.error || !bodyRes.data) {
    sendError(res, 400, 'INVALID_PROFILE_INPUT', bodyRes.error ?? 'Invalid profile update.');
    return;
  }

  try {
    const result = await updateUserProfile(db, user, bodyRes.data);
    if (!result.ok) {
      sendError(res, result.status, result.code, result.error);
      return;
    }

    res.status(200).json({ ok: true, profile: result.profile });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update profile.';
    sendError(res, 500, 'PROFILE_UPDATE_FAILED', msg);
  }
}

export async function handleProfileComplete(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (getMethod(req) !== 'POST') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.error);
    return;
  }

  const { db, user } = auth.ctx;

  const allowed = await enforceRateLimit(db, `profile_complete:${user.uid}`, 60, 15);
  if (!allowed) {
    sendError(res, 429, 'RATE_LIMITED', 'Too many attempts. Please wait a moment.');
    return;
  }

  const bodyRes = await parseValidatedBody(req, completeProfileSchema);
  if (bodyRes.error || !bodyRes.data) {
    sendError(res, 400, 'INVALID_PROFILE_INPUT', bodyRes.error ?? 'Invalid profile data.');
    return;
  }

  try {
    const result = await completeUserProfile(db, user, bodyRes.data);
    if (!result.ok) {
      sendError(res, result.status, result.code, result.error);
      return;
    }

    res.status(200).json({ ok: true, profile: result.profile });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to complete profile setup.';
    sendError(res, 500, 'PROFILE_COMPLETE_FAILED', msg);
  }
}

export async function handleCheckUsername(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (getMethod(req) !== 'GET') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is allowed.');
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.error);
    return;
  }

  const { db, user } = auth.ctx;

  const allowed = await enforceRateLimit(db, `username_check:${user.uid}`, 60, 60);
  if (!allowed) {
    sendError(res, 429, 'RATE_LIMITED', 'Checking too fast. Please wait a moment.');
    return;
  }

  const rawUsername = getQueryParam(req, 'username') ?? '';

  try {
    const check = await checkUsernameAvailability(db, user.uid, rawUsername);
    res.status(200).json({
      ok: true,
      valid: check.valid,
      available: check.available,
      normalized: check.normalized,
      reason: check.reason,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to verify username.';
    sendError(res, 500, 'USERNAME_CHECK_FAILED', msg);
  }
}
