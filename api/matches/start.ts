import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiRequest, createNodeApiResponse } from '../../server/online/http';
import { handleMatchStart } from '../../server/online/handlers/matches';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleMatchStart(req as ApiRequest, createNodeApiResponse(res));
}
