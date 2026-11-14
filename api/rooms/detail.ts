import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiRequest, createNodeApiResponse } from '../../server/online/http';
import { handleRoomDetail } from '../../server/online/handlers/rooms';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleRoomDetail(req as ApiRequest, createNodeApiResponse(res));
}
