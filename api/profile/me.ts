import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiRequest, createNodeApiResponse } from '../../server/online/http';
import { handleProfileMe } from '../../server/online/handlers/profile';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleProfileMe(req as ApiRequest, createNodeApiResponse(res));
}
