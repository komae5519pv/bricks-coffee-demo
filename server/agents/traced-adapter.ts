/**
 * Lazy, MLflow-traced wrapper around the barista's DatabricksAdapter.
 *
 * Two responsibilities:
 *   1. Root AGENT span per chat turn — traceAgentTurn around adapter.run().
 *   2. LLM span per model-serving round trip — the adapter's `streamBody`
 *      field (public by design) is replaced with traceLlmStream(), which
 *      pass-throughs the SSE stream while recording it.
 *
 * Construction is lazy: barista.ts is imported by routes/tests outside the
 * workspace, so no workspace client may be built at module import time. The
 * inner adapter is created on the first chat request and reused after.
 */
import { DatabricksAdapter } from '@databricks/appkit/beta';
import type { AgentAdapter, AgentInput, AgentRunContext, AgentEvent } from '@databricks/appkit/beta';
import { traceAgentTurn, traceLlmStream } from '../lib/tracing';

/** Extract the last user message text for the root span inputs. */
function lastUserText(messages: AgentInput['messages']): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return null;
}

interface StreamBodyCapable {
  streamBody: (body: unknown, signal?: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
}

let adapterPromise: Promise<AgentAdapter> | null = null;

function buildAdapter(model: string): Promise<AgentAdapter> {
  adapterPromise ??= (async () => {
    const inner = await DatabricksAdapter.fromModelServing(model);
    // One LLM span per HTTP round trip. `streamBody` is a public instance
    // field on DatabricksAdapter (documented extension point), so replacing
    // it needs no monkey-patching of internals.
    const capable = inner as unknown as StreamBodyCapable;
    const original = capable.streamBody.bind(inner);
    capable.streamBody = (body, signal) => traceLlmStream(model, body, signal, original);
    return inner;
  })();
  return adapterPromise;
}

/**
 * The traced adapter handed to createAgent({ model }). Satisfies the
 * AgentAdapter contract while deferring all real construction to first use.
 */
export function createTracedBaristaAdapter(model: string): AgentAdapter {
  return {
    run(input: AgentInput, context: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
      const inner = (async function* (): AsyncGenerator<AgentEvent, void, unknown> {
        const adapter = await buildAdapter(model);
        yield* adapter.run(input, context);
      })();
      return traceAgentTurn('barista.turn', { input: lastUserText(input.messages) }, inner);
    },
  };
}

/** Test hook: drop the cached adapter so each test gets a fresh one. */
export function resetTracedAdapterForTests(): void {
  adapterPromise = null;
}
