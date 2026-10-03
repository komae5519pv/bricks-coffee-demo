/**
 * Unit tests for the MLflow tracing wrapper — the MLflow client is mocked,
 * no workspace is touched. Verifies:
 *   - one chat turn => one trace, AGENT root with LLM + TOOL children
 *   - LLM span outputs accumulate the streamed SSE text / tool calls
 *   - tool errors mark the span ERROR and still propagate
 *   - disabled tracing is a transparent no-op
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MlflowClient } from 'mlflow-tracing/dist/clients/index.js';
import { SpanStatusCode } from 'mlflow-tracing/dist/core/entities/span_status.js';
import type { LiveSpan } from 'mlflow-tracing/dist/core/entities/span.js';
import {
  createMlflowBackend,
  resetTracingForTests,
  flushTracing,
  getTracingStatus,
  isTracingEnabled,
  traceAgentTurn,
  traceToolCall,
  traceLlmStream,
  getLatestEvalRun,
} from './tracing';

interface UploadedTrace {
  info: { traceId: string; state: string };
  spans: LiveSpan[];
}

function mockClient() {
  const uploaded: UploadedTrace[] = [];
  const createTrace = vi.fn((info: { traceId: string }) => Promise.resolve(info));
  const uploadTraceData = vi.fn((info: { traceId: string }, data: { spans: LiveSpan[] }) => {
    uploaded.push({ info: info as UploadedTrace['info'], spans: data.spans });
    return Promise.resolve();
  });
  const client = { createTrace, uploadTraceData } as unknown as MlflowClient;
  return { client, uploaded, createTrace, uploadTraceData };
}

function setupBackend() {
  const { client, uploaded, createTrace, uploadTraceData } = mockClient();
  createMlflowBackend({
    client,
    experimentId: '424242',
    experimentName: '/Shared/daiwt-coffee-shop-barista',
    host: 'https://fevm-konomi-demo.cloud.databricks.com',
  });
  return { uploaded, createTrace, uploadTraceData };
}

/** SSE byte stream from pre-chunked payloads. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* consume */
  }
}

type TurnEvent =
  | { type: 'status'; status: string }
  | { type: 'message_delta'; content: string }
  | { type: 'tool_call'; callId: string; name: string; args: unknown }
  | { type: 'tool_result'; callId: string; result: unknown };

/** Simulates one adapter.run turn: LLM round trip, then a tool call. */
async function* fakeTurn(
  streamBody: () => Promise<ReadableStream<Uint8Array>>
): AsyncGenerator<TurnEvent, void, unknown> {
  yield { type: 'status', status: 'running' };
  const stream = await traceLlmStream(
    'databricks-kimi-k3',
    { messages: [{ role: 'user', content: 'おすすめは?' }] },
    undefined,
    streamBody
  );
  await drain(stream);
  const rows = await traceToolCall('search_menu', { store_id: 'TYO001', query: 'おすすめ' }, () =>
    Promise.resolve([{ sku: 'TYO001-DRIP-M' }])
  );
  yield { type: 'tool_call', callId: 'c1', name: 'search_menu', args: { store_id: 'TYO001' } };
  yield { type: 'tool_result', callId: 'c1', result: rows };
  yield { type: 'message_delta', content: 'おすすめは' };
  yield { type: 'message_delta', content: 'ドリップコーヒーです' };
}

async function runTurn(streamBody: () => Promise<ReadableStream<Uint8Array>>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const ev of traceAgentTurn('barista.turn', { input: 'おすすめは?' }, fakeTurn(streamBody))) {
    events.push(ev);
  }
  return events;
}

const sseChunks = [
  'data: {"choices":[{"delta":{"content":"ドリップ"}}]}\n\ndata: {"choices":[{"delta":{"content":"コーヒー"',
  '}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"search_menu"}}]}}]}\n\ndata: [DONE]\n\n',
];

beforeEach(async () => {
  await resetTracingForTests();
});

afterEach(async () => {
  await resetTracingForTests();
});

describe('traceAgentTurn + spans (mocked MLflow client)', () => {
  it('exports one trace with AGENT root and LLM/TOOL children per turn', async () => {
    const { uploaded, createTrace, uploadTraceData } = setupBackend();
    const events = await runTurn(() => Promise.resolve(sseStream(sseChunks)));
    await flushTracing();

    // every event still reaches the consumer
    expect(events.map((e) => e.type)).toEqual(['status', 'tool_call', 'tool_result', 'message_delta', 'message_delta']);

    expect(createTrace).toHaveBeenCalledTimes(1);
    expect(uploadTraceData).toHaveBeenCalledTimes(1);
    expect(uploaded).toHaveLength(1);

    const trace = uploaded[0];
    expect(trace.info.traceId).toMatch(/^tr-/);
    const byName = new Map(trace.spans.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual(['barista.turn', 'llm databricks-kimi-k3', 'search_menu']);

    const root = byName.get('barista.turn')!;
    expect(root.parentId).toBeNull();
    expect(root.spanType).toBe('AGENT');

    const llm = byName.get('llm databricks-kimi-k3')!;
    expect(llm.parentId).toBe(root.spanId);
    expect(llm.spanType).toBe('CHAT_MODEL');
    // SSE split mid-line across chunks must still accumulate cleanly
    expect(llm.outputs).toMatchObject({ content: 'ドリップコーヒー', tool_calls: ['search_menu'] });

    const tool = byName.get('search_menu')!;
    expect(tool.parentId).toBe(root.spanId);
    expect(tool.spanType).toBe('TOOL');
    expect(tool.inputs).toMatchObject({ store_id: 'TYO001' });
    expect(tool.outputs).toEqual([{ sku: 'TYO001-DRIP-M' }]);

    // root outputs aggregate the turn: assistant text + tool call names
    expect(root.outputs).toMatchObject({ output: 'おすすめはドリップコーヒーです', tool_calls: ['search_menu'] });
  });

  it('records the turn in getTracingStatus with a clickable trace URL', async () => {
    setupBackend();
    await runTurn(() => Promise.resolve(sseStream(sseChunks)));
    const status = getTracingStatus();
    expect(status.enabled).toBe(true);
    expect(status.experiment_url).toBe('https://fevm-konomi-demo.cloud.databricks.com/ml/experiments/424242');
    expect(status.recent_traces).toHaveLength(1);
    const t = status.recent_traces[0];
    expect(t.status).toBe('OK');
    expect(t.url).toBe(`https://fevm-konomi-demo.cloud.databricks.com/ml/experiments/424242/traces/${t.trace_id}`);
  });

  it('marks a failing tool span ERROR and rethrows', async () => {
    const { uploaded } = setupBackend();
    const boom = new Error('lakebase down');
    async function* failingTurn(): AsyncGenerator<TurnEvent, void, unknown> {
      yield { type: 'status', status: 'running' };
      await expect(traceToolCall('place_order', { store_id: 'TYO001' }, () => Promise.reject(boom))).rejects.toThrow(
        'lakebase down'
      );
      yield { type: 'message_delta', content: 'failed gracefully' };
    }
    for await (const _ of traceAgentTurn('barista.turn', { input: 'x' }, failingTurn())) {
      void _;
    }
    await flushTracing();
    const tool = uploaded[0].spans.find((s) => s.name === 'place_order')!;
    expect(tool.status.statusCode).toBe(SpanStatusCode.ERROR);
    expect(uploaded[0].spans.find((s) => s.name === 'barista.turn')!.status.statusCode).not.toBe(SpanStatusCode.ERROR);
  });

  it('marks the root span ERROR when the turn itself blows up', async () => {
    const { uploaded } = setupBackend();
    async function* explodingTurn(): AsyncGenerator<TurnEvent, void, unknown> {
      yield { type: 'status', status: 'running' };
      await Promise.reject(new Error('serving endpoint 500'));
    }
    await expect(
      (async () => {
        for await (const _ of traceAgentTurn('barista.turn', { input: 'x' }, explodingTurn())) {
          void _;
        }
      })()
    ).rejects.toThrow('serving endpoint 500');
    await flushTracing();
    const root = uploaded[0].spans.find((s) => s.name === 'barista.turn')!;
    expect(root.status.statusCode).toBe(SpanStatusCode.ERROR);
    expect(getTracingStatus().recent_traces[0].status).toBe('ERROR');
  });

  it('marks the LLM span ERROR when the stream fails mid-flight', async () => {
    const { uploaded } = setupBackend();
    const failingStream = () =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"abc"}}]}\n\n'));
            controller.error(new Error('connection reset'));
          },
        })
      );
    async function* turn(): AsyncGenerator<TurnEvent, void, unknown> {
      yield { type: 'status', status: 'running' };
      const stream = await traceLlmStream('databricks-kimi-k3', {}, undefined, failingStream);
      await expect(drain(stream)).rejects.toThrow('connection reset');
      yield { type: 'message_delta', content: '' };
    }
    for await (const _ of traceAgentTurn('barista.turn', { input: 'x' }, turn())) {
      void _;
    }
    await flushTracing();
    const llm = uploaded[0].spans.find((s) => s.name === 'llm databricks-kimi-k3')!;
    expect(llm.status.statusCode).toBe(SpanStatusCode.ERROR);
  });
});

describe('tracing disabled / no active turn', () => {
  it('passes events and results through with zero span machinery', async () => {
    expect(isTracingEnabled()).toBe(false);
    const events = await runTurn(() => Promise.resolve(sseStream(sseChunks)));
    expect(events).toHaveLength(5);
    // tools also work standalone (e.g. outside a traced turn)
    const result = await traceToolCall('get_stores', {}, () => Promise.resolve(['TYO001']));
    expect(result).toEqual(['TYO001']);
    expect(getTracingStatus().recent_traces).toHaveLength(0);
  });

  it('passes the LLM stream through untouched without a backend', async () => {
    const stream = await traceLlmStream('m', {}, undefined, () => Promise.resolve(sseStream(sseChunks)));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks).toHaveLength(2);
  });
});

describe('payload capping', () => {
  it('truncates oversized tool outputs instead of shipping megabytes to MLflow', async () => {
    const { uploaded } = setupBackend();
    const big = 'x'.repeat(20000);
    async function* turn(): AsyncGenerator<TurnEvent, void, unknown> {
      yield { type: 'status', status: 'running' };
      await traceToolCall('search_menu', {}, () => Promise.resolve(big));
      yield { type: 'message_delta', content: 'done' };
    }
    for await (const _ of traceAgentTurn('barista.turn', { input: 'x' }, turn())) {
      void _;
    }
    await flushTracing();
    const tool = uploaded[0].spans.find((s) => s.name === 'search_menu')!;
    expect(typeof tool.outputs).toBe('string');
    expect((tool.outputs as string).length).toBeLessThan(5000);
  });
});

describe('getLatestEvalRun (mocked MLflow REST)', () => {
  it('returns the most recent run with metrics, with run URL and 60s cache', async () => {
    const { client } = mockClient();
    createMlflowBackend({
      client,
      experimentId: '424242',
      experimentName: '/Shared/daiwt-coffee-shop-barista',
      host: 'https://ws.example.com',
      getHeaders: () => Promise.resolve({ Authorization: 'Bearer x' }),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          runs: [
            { info: { run_id: 'norun', run_name: 'empty', start_time: 300 }, data: { metrics: [] } },
            {
              info: { run_id: 'r2', run_name: 'eval-2', start_time: 200 },
              data: { metrics: [{ key: 'tool_call_correctness/mean', value: 0.9 }] },
            },
          ],
        }),
        { status: 200 }
      )
    );
    const first = await getLatestEvalRun();
    expect(first?.run_id).toBe('r2');
    expect(first?.url).toBe('https://ws.example.com/ml/experiments/424242/runs/r2');
    expect(first?.metrics['tool_call_correctness/mean']).toBe(0.9);
    // Second call hits the cache — no second fetch.
    const second = await getLatestEvalRun();
    expect(second?.run_id).toBe('r2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it('returns null when no headers provider is wired (tests/local mocks)', async () => {
    setupBackend();
    expect(await getLatestEvalRun()).toBeNull();
  });
});
