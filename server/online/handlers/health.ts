import { getFirebaseServerConfig } from '../firebaseAdmin';
import { ApiRequest, ApiResponse, getMethod, sendError } from '../http';

export async function handleHealth(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (getMethod(req) !== 'GET') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is allowed.');
    return;
  }

  const config = getFirebaseServerConfig();
  res.status(200).json({
    ok: true,
    firebaseConfigured: Boolean(config),
    serverTime: new Date().toISOString(),
  });
}
