import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError, ZodSchema } from 'zod';

export interface ApiRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

export interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
  setHeader: (name: string, value: string | string[]) => void;
  end: (chunk?: string) => void;
}

export function createNodeApiResponse(res: ServerResponse): ApiResponse {
  const wrapper: ApiResponse = {
    status(code: number) {
      res.statusCode = code;
      return wrapper;
    },
    json(payload: unknown) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
      }
      res.end(JSON.stringify(payload));
    },
    setHeader(name: string, value: string | string[]) {
      res.setHeader(name, value);
    },
    end(chunk?: string) {
      res.end(chunk);
    },
  };
  return wrapper;
}

export function sendError(
  res: ApiResponse,
  statusCode: number,
  code: string,
  error: string
): void {
  res.status(statusCode).json({ ok: false, code, error });
}

export function getMethod(req: ApiRequest): string {
  return (req.method ?? 'GET').toUpperCase();
}

export function getQueryParam(req: ApiRequest, key: string): string | undefined {
  if (req.query && key in req.query) {
    const val = req.query[key];
    return Array.isArray(val) ? val[0] : val;
  }
  if (req.url) {
    const parsed = new URL(req.url, 'http://localhost');
    return parsed.searchParams.get(key) ?? undefined;
  }
  return undefined;
}

export function getBearerToken(req: ApiRequest): string | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export async function readJsonBody(req: ApiRequest & IncomingMessage): Promise<unknown> {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      return req.body.length > 0 ? JSON.parse(req.body) : {};
    }
    return req.body;
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_BODY_BYTES = 64 * 1024;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

export async function parseValidatedBody<T>(
  req: ApiRequest,
  schema: ZodSchema<T>
): Promise<{ data?: T; error?: string }> {
  try {
    const raw = await readJsonBody(req as ApiRequest & IncomingMessage);
    const parsed = schema.parse(raw);
    return { data: parsed };
  } catch (err) {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      return { error: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid payload.' };
    }
    if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
      return { error: 'Request payload is too large.' };
    }
    if (err instanceof Error && err.message === 'INVALID_JSON') {
      return { error: 'Malformed JSON body.' };
    }
    return { error: 'Invalid request payload.' };
  }
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Generates an unambiguous 6-character room code using CSPRNG (`crypto.randomInt`). */
export function generateSecureRoomCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_ALPHABET[crypto.randomInt(0, ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

const memoryRateMap = new Map<string, { windowStart: number; count: number }>();

export function checkInMemoryRateLimit(
  key: string,
  windowSeconds: number,
  maxRequests: number
): boolean {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const entry = memoryRateMap.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    memoryRateMap.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= maxRequests) {
    return false;
  }
  entry.count += 1;
  return true;
}
