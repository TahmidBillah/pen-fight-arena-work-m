import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRequest, ApiResponse } from './server/online/http';
import { handleHealth } from './server/online/handlers/health';
import {
  handleCheckUsername,
  handleProfileComplete,
  handleProfileMe,
} from './server/online/handlers/profile';
import {
  handleRoomCreate,
  handleRoomDetail,
  handleRoomJoin,
  handleRoomLeave,
  handleRoomReady,
} from './server/online/handlers/rooms';
import {
  handleMatchFinish,
  handleMatchStart,
  handleMatchState,
  handleMatchSubmitShot,
} from './server/online/handlers/matches';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type HandlerFn = (req: ApiRequest, res: ApiResponse) => Promise<void>;

function adaptExpressHandler(handler: HandlerFn) {
  return async (req: Request, res: Response) => {
    const apiReq: ApiRequest = {
      method: req.method,
      url: req.originalUrl,
      headers: req.headers,
      body: req.body,
      query: req.query as Record<string, string | string[] | undefined>,
    };

    const apiRes: ApiResponse = {
      status(code: number) {
        res.status(code);
        return apiRes;
      },
      json(payload: unknown) {
        res.setHeader('Cache-Control', 'no-store');
        res.json(payload);
      },
      setHeader(name: string, value: string | string[]) {
        res.setHeader(name, value);
      },
      end(chunk?: string) {
        res.end(chunk);
      },
    };

    try {
      await handler(apiReq, apiRes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Internal server error.';
      if (!res.headersSent) {
        res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: msg });
      }
    }
  };
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.all('/api/health', adaptExpressHandler(handleHealth));
  app.all('/api/profile/me', adaptExpressHandler(handleProfileMe));
  app.all('/api/profile/complete', adaptExpressHandler(handleProfileComplete));
  app.all('/api/profile/check-username', adaptExpressHandler(handleCheckUsername));
  app.all('/api/rooms/create', adaptExpressHandler(handleRoomCreate));
  app.all('/api/rooms/join', adaptExpressHandler(handleRoomJoin));
  app.all('/api/rooms/detail', adaptExpressHandler(handleRoomDetail));
  app.all('/api/rooms/ready', adaptExpressHandler(handleRoomReady));
  app.all('/api/rooms/leave', adaptExpressHandler(handleRoomLeave));
  app.all('/api/matches/start', adaptExpressHandler(handleMatchStart));
  app.all('/api/matches/submit-shot', adaptExpressHandler(handleMatchSubmitShot));
  app.all('/api/matches/state', adaptExpressHandler(handleMatchState));
  app.all('/api/matches/finish', adaptExpressHandler(handleMatchFinish));

  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Pen Fight Arena server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
