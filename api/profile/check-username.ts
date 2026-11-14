import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiRequest, createNodeApiResponse } from '../../server/online/http';
import { handleCheckUsername } from '../../server/online/handlers/profile';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleCheckUsername(req as ApiRequest, createNodeApiResponse(res));
}
