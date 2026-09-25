/**
 * DAIWT coffee shop - global chain edition.
 *
 * One app, three roles of infrastructure:
 *   - lakebase()  : all app data (Postgres + pgvector), OBO per-user pools + RLS
 *   - serving()   : Foundation Model API (embeddings for semantic menu search)
 *   - agents()    : the barista agent, hosted on this app (no agent endpoint)
 */
import { createApp, lakebase, server, serving, toPlugin } from '@databricks/appkit';
import { agents } from '@databricks/appkit/beta';
import { barista, setBaristaEmbeddings } from './agents/barista';
import { CoffeeToolsPlugin, setCoffeeToolsDb } from './plugins/coffee-tools';
import { initializeDatabase } from './db';
import { registerCoffeeRoutes } from './routes';
import type { EmbeddingsInvoker } from './lib/embed';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- runtime value unused; kept for the exported type
const appkit = await createApp({
  plugins: [
    agents({ agents: { barista } }),
    lakebase(),
    serving({ endpoints: { embeddings: { env: 'EMBEDDING_ENDPOINT_NAME' } } }),
    server(),
    toPlugin(CoffeeToolsPlugin)(),
  ],
  async onPluginsReady(handle) {
    /**
     * Uniform invoker for the embeddings alias, used by bootstrap + routes.
     * The serving plugin's invoke() already returns the { ok, data | error }
     * envelope that EmbeddingsInvoker expects — pass it through unchanged
     * (wrapping it again nests the body one level too deep).
     */
    const embeddings: EmbeddingsInvoker = {
      invoke: (_alias, body) =>
        handle.serving('embeddings').invoke(body) as ReturnType<EmbeddingsInvoker['invoke']>,
    };
    const spDb = {
      query: async <T = unknown>(t: string, v?: unknown[]) => {
        const r = await handle.lakebase.query(t, v);
        return { rows: r.rows as T[], rowCount: r.rowCount };
      },
    };
    setBaristaEmbeddings(embeddings);
    setCoffeeToolsDb({
      query: async <T = unknown>(t: string, v?: unknown[]) => {
        const r = await handle.lakebase.query(t, v);
        return { rows: r.rows as T[], rowCount: r.rowCount };
      },
    });
    await initializeDatabase(spDb, embeddings);
    registerCoffeeRoutes(handle, embeddings);
  },
}).catch((e) => {
  console.error(e);
  process.exit(1);
});

export type AppHandle = NonNullable<typeof appkit>;
