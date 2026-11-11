import './types';
import { handleApi } from './api';
import { runScheduled } from './engine';

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, ctx, url);
    // Static assets (the dashboard PWA) are normally served before the Worker runs.
    return env.ASSETS.fetch(req);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      runScheduled(env, controller.scheduledTime).catch((e) => {
        console.error('Scheduled run failed:', (e as Error)?.stack ?? e);
        throw e;
      }),
    );
  },
} satisfies ExportedHandler<Env>;
