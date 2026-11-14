import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiRequest, createNodeApiResponse } from '../../server/online/http';
import { handleProfileComplete } from '../../server/online/handlers/profile';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleProfileComplete(req as ApiRequest, createNodeApiResponse(res));
}
