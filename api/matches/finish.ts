import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiRequest, createNodeApiResponse } from '../../server/online/http';
import { handleMatchFinish } from '../../server/online/handlers/matches';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleMatchFinish(req as ApiRequest, createNodeApiResponse(res));
}
