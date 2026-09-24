/**
 * DAIWT coffee shop - global chain edition.
 *
 * One app, three roles of infrastructure:
 *   - lakebase()  : all app data (Postgres + pgvector), OBO per-user pools + RLS
 *   - serving()   : Foundation Model API (embeddings for semantic menu search)
 *   - agents()    : the barista agent, hosted on this app (no agent endpoint)
 */
import { createApp, lakebase, server, serving } from '@databricks/appkit';
import { agents } from '@databricks/appkit/beta';
import { barista } from './agents/barista';
import { initializeDatabase } from './db';
import { registerCoffeeRoutes } from './routes';
import type { EmbeddingsInvoker } from './lib/embed';

const appkit = await createApp({
  plugins: [
    agents({ agents: { barista } }),
    lakebase(),
    serving({ endpoints: { embeddings: { env: 'EMBEDDING_ENDPOINT_NAME' } } }),
    server(),
  ],
  async onPluginsReady(handle) {
    /** Uniform invoker for the embeddings alias, used by bootstrap + routes. */
    const embeddings: EmbeddingsInvoker = {
      invoke: async (_alias, body) => {
        try {
          const data = await handle.serving('embeddings').invoke(body);
          return { ok: true as const, data };
        } catch (e) {
          return {
            ok: false as const,
            status: 500,
            message: e instanceof Error ? e.message : String(e),
          };
        }
      },
    };
    const spDb = {
      query: async <T = any>(t: string, v?: unknown[]) => {
        const r = await handle.lakebase.query(t, v);
        return { rows: r.rows as T[], rowCount: r.rowCount };
      },
    };
    await initializeDatabase(spDb, embeddings);
    registerCoffeeRoutes(handle, embeddings);
  },
}).catch((e) => {
  console.error(e);
  process.exit(1);
});

export type AppHandle = NonNullable<typeof appkit>;
