import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiRequest, createNodeApiResponse } from '../server/online/http';
import { handleHealth } from '../server/online/handlers/health';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleHealth(req as ApiRequest, createNodeApiResponse(res));
}
