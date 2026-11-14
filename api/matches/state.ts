import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiRequest, createNodeApiResponse } from '../../server/online/http';
import { handleMatchState } from '../../server/online/handlers/matches';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleMatchState(req as ApiRequest, createNodeApiResponse(res));
}
