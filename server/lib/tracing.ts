/**
 * MLflow tracing for the barista agent (production observability story).
 *
 * One chat turn becomes one MLflow trace:
 *
 *     barista.turn (AGENT, root)
 *     ├── llm databricks-kimi-k3 (LLM)   — one per model-serving round-trip
 *     ├── search_menu (TOOL)             — one per tool execution
 *     └── ...
 *
 * Traces land in a Databricks-hosted MLflow experiment (MLFLOW_EXPERIMENT_NAME,
 * default /Shared/daiwt-coffee-shop-barista) and are viewable in the workspace
 * MLflow UI (experiment -> Traces tab).
 *
 * Implementation note (why not mlflow-tracing's init()/withSpan): the official
 * TS SDK's init() starts its own OpenTelemetry NodeSDK and registers it as the
 * GLOBAL tracer provider. AppKit also runs a NodeSDK (its OTLP platform
 * telemetry). OTel globals are first-one-wins: whichever NodeSDK registers
 * first captures every auto-instrumented span. If MLflow wins, AppKit's
 * HTTP/Express spans would be exported into the MLflow experiment as noise
 * (one "trace" per HTTP request) and AppKit's own telemetry would go dark; if
 * AppKit wins, MLflow spans silently become no-ops. So instead we reuse the
 * SDK's building blocks — MlflowClient, MlflowSpanExporter, trace entities,
 * the InMemoryTraceManager glue — behind a DEDICATED, non-global
 * BasicTracerProvider, and drive it with explicit spans only. No global
 * registration, no auto-instrumentation, no interference with AppKit.
 *
 * Failure policy: tracing is observability, never on the critical path. Any
 * error in span creation/export is logged and swallowed; the chat path must
 * never fail because tracing did.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  BasicTracerProvider,
  type SpanProcessor,
  type ReadableSpan,
  type Span as SdkSpan,
} from '@opentelemetry/sdk-trace-base';
import { trace as otelTrace, ROOT_CONTEXT, type Context, type Span as OtelSpan } from '@opentelemetry/api';

// Deep imports into the official mlflow-tracing SDK (CJS, no exports map, so
// subpaths resolve). We intentionally do NOT import its index: that pulls in
// init()/getTracer, which assume the global-provider setup described above.
import { MlflowClient } from 'mlflow-tracing/dist/clients/index.js';
import { createAuthProvider } from 'mlflow-tracing/dist/auth/index.js';
import { MlflowSpanExporter } from 'mlflow-tracing/dist/exporters/mlflow.js';
import { InMemoryTraceManager } from 'mlflow-tracing/dist/core/trace_manager.js';
import { createAndRegisterMlflowSpan } from 'mlflow-tracing/dist/core/api.js';
import { TraceInfo } from 'mlflow-tracing/dist/core/entities/trace_info.js';
import { createTraceLocationFromExperimentId } from 'mlflow-tracing/dist/core/entities/trace_location.js';
import { TraceState, fromOtelStatus } from 'mlflow-tracing/dist/core/entities/trace_state.js';
import { SpanStatusCode } from 'mlflow-tracing/dist/core/entities/span_status.js';
import {
  SpanAttributeKey,
  TraceMetadataKey,
  TRACE_ID_PREFIX,
  TRACE_SCHEMA_VERSION,
  type SpanType,
} from 'mlflow-tracing/dist/core/constants.js';
import {
  aggregateUsageFromSpans,
  convertHrTimeToMs,
  deduplicateSpanNamesInPlace,
} from 'mlflow-tracing/dist/core/utils/index.js';
import type { LiveSpan } from 'mlflow-tracing/dist/core/entities/span.js';

const logger = {
  warn: (msg: string, err?: unknown) => console.warn(`[tracing] ${msg}`, err ?? ''),
  info: (msg: string) => console.log(`[tracing] ${msg}`),
};

/** Max chars of JSON kept in a single span inputs/outputs payload. */
const PAYLOAD_CAP = 4000;

/**
 * Slim replacement for the SDK's MlflowSpanProcessor: identical trace
 * semantics (root span opens a trace, children join it, root end exports),
 * but takes the experiment id as a constructor arg instead of reading the
 * SDK's global config — which only exists after init(), and init() is exactly
 * what we avoid (it would start the global NodeSDK).
 */
class CoffeeMlflowSpanProcessor implements SpanProcessor {
  constructor(
    private readonly exporter: MlflowSpanExporter,
    private readonly experimentId: string
  ) {}

  onStart(span: SdkSpan): void {
    const tm = InMemoryTraceManager.getInstance();
    const otelTraceId = span.spanContext().traceId;
    let traceId: string;
    if (!span.parentSpanContext?.spanId) {
      traceId = `${TRACE_ID_PREFIX}${otelTraceId}`;
      const info = new TraceInfo({
        traceId,
        traceLocation: createTraceLocationFromExperimentId(this.experimentId),
        requestTime: convertHrTimeToMs(span.startTime),
        executionDuration: 0,
        state: TraceState.IN_PROGRESS,
        traceMetadata: { [TraceMetadataKey.SCHEMA_VERSION]: TRACE_SCHEMA_VERSION },
        tags: {},
        assessments: [],
      });
      tm.registerTrace(otelTraceId, info);
    } else {
      const found = tm.getMlflowTraceIdFromOtelId(otelTraceId);
      if (!found) {
        logger.warn(`no trace registered for child span "${span.name}" — skipped`);
        return;
      }
      traceId = found;
    }
    span.setAttribute(SpanAttributeKey.TRACE_ID, JSON.stringify(traceId));
    // Registers the MLflow span wrapper in the trace manager so the span can
    // be fetched for setInputs/setOutputs/setSpanType by the caller.
    createAndRegisterMlflowSpan(span);
  }

  onEnd(span: ReadableSpan): void {
    if (span.parentSpanContext?.spanId) return; // only root end exports
    const tm = InMemoryTraceManager.getInstance();
    const traceId = tm.getMlflowTraceIdFromOtelId(span.spanContext().traceId);
    const trace = traceId ? tm.getTrace(traceId) : null;
    if (!trace) {
      logger.warn(`no trace found for root span "${span.name}" — export skipped`);
      return;
    }
    let state = fromOtelStatus(span.status.code);
    if (state === TraceState.STATE_UNSPECIFIED) state = TraceState.OK;
    trace.info.state = state;
    trace.info.executionDuration = convertHrTimeToMs(span.endTime) - trace.info.requestTime;
    const spans = Array.from(trace.spanDict.values());
    deduplicateSpanNamesInPlace(spans);
    const usage = aggregateUsageFromSpans(spans);
    if (usage) trace.info.traceMetadata[TraceMetadataKey.TOKEN_USAGE] = JSON.stringify(usage);
    this.exporter.export([span], () => undefined);
  }

  async forceFlush(): Promise<void> {
    await this.exporter.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.exporter.shutdown();
  }
}

/** A live span under instrumentation. Opaque outside this module. */
export interface TracedSpan {
  readonly name: string;
  readonly traceId: string;
}

interface ActiveSpan extends TracedSpan {
  otel: OtelSpan;
  mlflow: LiveSpan;
  startMs: number;
  /**
   * Local end marker. NB: LiveSpan.endTime can't be used for this — the
   * OTel SDK initializes Span.endTime to [0,0], not null, so an unended
   * span reads as "ended" through that getter.
   */
  ended: boolean;
}

export interface TracingStatus {
  enabled: boolean;
  reason: string | null;
  experiment_name: string | null;
  experiment_id: string | null;
  experiment_url: string | null;
  recent_traces: Array<{
    trace_id: string;
    name: string;
    url: string | null;
    started_at: string;
    duration_ms: number | null;
    status: 'OK' | 'ERROR' | 'IN_PROGRESS';
  }>;
}

interface Backend {
  provider: BasicTracerProvider;
  processor: CoffeeMlflowSpanProcessor;
  experimentId: string;
  experimentName: string;
  host: string | null;
  /** Auth headers for MLflow REST calls (eval-run lookup). Null in tests. */
  getHeaders: (() => Promise<Record<string, string>>) | null;
}

let backend: Backend | null = null;
let disabledReason: string | null = 'initTracing() not called yet';
const rootSpanContext = new AsyncLocalStorage<ActiveSpan>();
const recentTraces: TracingStatus['recent_traces'] = [];
const RECENT_TRACES_MAX = 20;

/**
 * Keep span payloads small: menu search results and long transcripts can be
 * tens of KB; MLflow span attributes are not the place for them.
 */
function capPayload(value: unknown, maxChars = PAYLOAD_CAP): unknown {
  if (value == null) return value;
  let json: string;
  try {
    json = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '[unserializable payload]';
  }
  return json.length <= maxChars ? value : `${json.slice(0, maxChars)}…(truncated)`;
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}

function toLiveSpan(name: string, otel: OtelSpan): ActiveSpan | null {
  try {
    const tm = InMemoryTraceManager.getInstance();
    const otelTraceId = otel.spanContext().traceId;
    const traceId = tm.getMlflowTraceIdFromOtelId(otelTraceId) ?? `${TRACE_ID_PREFIX}${otelTraceId}`;
    const mlflow = tm.getSpan(traceId, otel.spanContext().spanId);
    if (!mlflow) {
      logger.warn(`span "${name}" was not registered by the processor`);
      return null;
    }
    return { name, traceId, otel, mlflow, startMs: Date.now(), ended: false };
  } catch (e) {
    logger.warn(`failed to resolve live span "${name}"`, e);
    return null;
  }
}

function startSpan(name: string, spanType: SpanType, inputs: unknown, parent: ActiveSpan | null): ActiveSpan | null {
  if (!backend) return null;
  try {
    const tracer = backend.provider.getTracer('barista');
    const parentCtx: Context = parent ? otelTrace.setSpan(ROOT_CONTEXT, parent.otel) : ROOT_CONTEXT;
    const otel = tracer.startSpan(name, {}, parentCtx);
    const span = toLiveSpan(name, otel);
    if (!span) {
      otel.end();
      return null;
    }
    span.mlflow.setSpanType(spanType);
    if (inputs !== undefined) span.mlflow.setInputs(capPayload(inputs));
    return span;
  } catch (e) {
    logger.warn(`failed to start span "${name}"`, e);
    return null;
  }
}

function endSpan(span: ActiveSpan, opts: { outputs?: unknown; error?: unknown }): void {
  if (span.ended) return;
  span.ended = true;
  try {
    if (opts.error != null) {
      const err = opts.error instanceof Error ? opts.error : new Error(errorMessage(opts.error));
      span.mlflow.recordException(err);
      // Must be the enum: LiveSpan.end() only preserves STATUS_CODE_ERROR;
      // any other value (incl. the bare string 'ERROR') is overwritten to OK.
      span.mlflow.setStatus(SpanStatusCode.ERROR, err.message);
    }
    if (opts.outputs !== undefined) span.mlflow.setOutputs(capPayload(opts.outputs));
    span.mlflow.end();
  } catch (e) {
    logger.warn(`failed to end span "${span.name}"`, e);
  }
}

function recordRecentTrace(span: ActiveSpan, status: 'OK' | 'ERROR'): void {
  const host = backend?.host;
  const experimentId = backend?.experimentId;
  recentTraces.unshift({
    trace_id: span.traceId,
    name: span.name,
    url: host && experimentId ? `${host}/ml/experiments/${experimentId}/traces/${span.traceId}` : null,
    started_at: new Date(span.startMs).toISOString(),
    duration_ms: Date.now() - span.startMs,
    status,
  });
  if (recentTraces.length > RECENT_TRACES_MAX) recentTraces.length = RECENT_TRACES_MAX;
}

/**
 * Build the tracing backend from an already-resolved experiment. Exported
 * for tests: pass a mock MlflowClient to verify export wiring without a
 * workspace.
 */
export function createMlflowBackend(opts: {
  client: MlflowClient;
  experimentId: string;
  experimentName: string;
  host?: string | null;
  getHeaders?: (() => Promise<Record<string, string>>) | null;
}): void {
  const exporter = new MlflowSpanExporter(opts.client);
  const processor = new CoffeeMlflowSpanProcessor(exporter, opts.experimentId);
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  backend = {
    provider,
    processor,
    experimentId: opts.experimentId,
    experimentName: opts.experimentName,
    host: opts.host ?? null,
    getHeaders: opts.getHeaders ?? null,
  };
  disabledReason = null;
}

/** Test hook: tear down the backend so each test starts clean. */
export async function resetTracingForTests(): Promise<void> {
  if (backend) await backend.provider.shutdown().catch(() => undefined);
  backend = null;
  disabledReason = 'initTracing() not called yet';
  recentTraces.length = 0;
  evalCache = null;
}

// ---------------------------------------------------------------------------
// Latest evaluation run (offline eval scores for the status page).
// ---------------------------------------------------------------------------

export interface EvalRunSummary {
  run_id: string;
  run_name: string | null;
  url: string | null;
  started_at: string;
  metrics: Record<string, number>;
}

const EVAL_CACHE_TTL_MS = 60_000;
let evalCache: { at: number; value: EvalRunSummary | null } | null = null;

interface RunsSearchResponse {
  runs?: Array<{
    info?: { run_id?: string; run_name?: string; start_time?: number | string };
    data?: { metrics?: Array<{ key: string; value: number }> };
  }>;
}

/**
 * Most recent MLflow run in the experiment that carries aggregated metrics
 * (i.e. an mlflow.genai.evaluate run — trace exports create no runs). Cached
 * for 60s; any failure returns null (status page must never break on this).
 */
export async function getLatestEvalRun(): Promise<EvalRunSummary | null> {
  if (!backend?.host || !backend.getHeaders) return null;
  if (evalCache && Date.now() - evalCache.at < EVAL_CACHE_TTL_MS) return evalCache.value;
  let value: EvalRunSummary | null = null;
  try {
    const resp = await fetch(`${backend.host}/api/2.0/mlflow/runs/search`, {
      method: 'POST',
      headers: { ...(await backend.getHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        experiment_ids: [backend.experimentId],
        max_results: 20,
        order_by: ['start_time DESC'],
      }),
    });
    if (resp.ok) {
      const body = (await resp.json()) as RunsSearchResponse;
      for (const run of body.runs ?? []) {
        const metrics = Object.fromEntries((run.data?.metrics ?? []).map((m) => [m.key, m.value]));
        const runId = run.info?.run_id;
        if (!runId || Object.keys(metrics).length === 0) continue;
        const startMs = Number(run.info?.start_time ?? 0);
        value = {
          run_id: runId,
          run_name: run.info?.run_name ?? null,
          url: `${backend.host}/ml/experiments/${backend.experimentId}/runs/${runId}`,
          started_at: new Date(startMs).toISOString(),
          metrics,
        };
        break;
      }
    }
  } catch (e) {
    logger.warn('latest eval run lookup failed', e);
  }
  evalCache = { at: Date.now(), value };
  return value;
}

export function isTracingEnabled(): boolean {
  return backend !== null;
}

export function getTracingStatus(): TracingStatus {
  return {
    enabled: backend !== null,
    reason: disabledReason,
    experiment_name: backend?.experimentName ?? null,
    experiment_id: backend?.experimentId ?? null,
    experiment_url:
      backend?.host && backend.experimentId ? `${backend.host}/ml/experiments/${backend.experimentId}` : null,
    recent_traces: [...recentTraces],
  };
}

/**
 * Resolve the tracking URI: explicit MLFLOW_TRACKING_URI wins; otherwise
 * local dev (DATABRICKS_CONFIG_PROFILE set) targets that CLI profile and the
 * in-app runtime falls back to ambient auth (Apps injects SP credentials).
 */
function resolveTrackingUri(): string {
  if (process.env.MLFLOW_TRACKING_URI) return process.env.MLFLOW_TRACKING_URI;
  const profile = process.env.DATABRICKS_CONFIG_PROFILE;
  return profile ? `databricks://${profile}` : 'databricks';
}

/** Experiment name -> id via the MLflow REST API; creates it if missing. */
async function resolveExperimentId(
  headers: () => Promise<Record<string, string>>,
  host: string,
  name: string
): Promise<string> {
  const authHeaders = await headers();
  const getResp = await fetch(
    `${host}/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(name)}`,
    { headers: authHeaders }
  );
  if (getResp.ok) {
    const body = (await getResp.json()) as { experiment?: { experiment_id?: string } };
    const id = body.experiment?.experiment_id;
    if (id) return id;
  }
  if (getResp.status !== 404) {
    throw new Error(`get-by-name failed (${getResp.status}): ${await getResp.text()}`);
  }
  const createResp = await fetch(`${host}/api/2.0/mlflow/experiments/create`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!createResp.ok) {
    throw new Error(`experiment create failed (${createResp.status}): ${await createResp.text()}`);
  }
  const created = (await createResp.json()) as { experiment_id?: string };
  if (!created.experiment_id) throw new Error('experiment create returned no id');
  logger.info(`created MLflow experiment "${name}" (id ${created.experiment_id})`);
  return created.experiment_id;
}

/**
 * Initialize tracing from the environment. Never throws: on any failure the
 * app keeps running untraced and the reason is surfaced on /api/status.
 *
 * Env:
 *   MLFLOW_TRACING_ENABLED   '0'/'false' to disable (default: enabled)
 *   MLFLOW_EXPERIMENT_NAME   default /Shared/daiwt-coffee-shop-barista
 *   MLFLOW_TRACKING_URI      default derived from DATABRICKS_CONFIG_PROFILE
 */
export async function initTracing(): Promise<TracingStatus> {
  const enabledEnv = (process.env.MLFLOW_TRACING_ENABLED ?? '').toLowerCase();
  if (enabledEnv === '0' || enabledEnv === 'false') {
    disabledReason = 'disabled by MLFLOW_TRACING_ENABLED';
    return getTracingStatus();
  }
  const experimentName = process.env.MLFLOW_EXPERIMENT_NAME ?? '/Shared/daiwt-coffee-shop-barista';
  try {
    const trackingUri = resolveTrackingUri();
    const auth = createAuthProvider({ trackingUri });
    const host = auth.getHost().replace(/\/$/, '');
    const experimentId = await resolveExperimentId(auth.getHeadersProvider(), host, experimentName);
    createMlflowBackend({
      client: new MlflowClient({ trackingUri, authProvider: auth }),
      experimentId,
      experimentName,
      host,
      getHeaders: auth.getHeadersProvider(),
    });
    logger.info(`tracing to experiment "${experimentName}" (id ${experimentId}) on ${host}`);
  } catch (e) {
    disabledReason = e instanceof Error ? e.message : String(e);
    logger.warn(`init failed, tracing disabled: ${disabledReason}`);
  }
  return getTracingStatus();
}

/** Flush pending trace exports (called on shutdown). */
export async function flushTracing(): Promise<void> {
  if (!backend) return;
  try {
    await backend.processor.forceFlush();
  } catch (e) {
    logger.warn('flush failed', e);
  }
}

// ---------------------------------------------------------------------------
// Span helpers used by the agent adapter and tool wrappers.
// ---------------------------------------------------------------------------

/**
 * Wrap one chat turn (one adapter.run generator) in the root AGENT span.
 * Re-yields every event; accumulates assistant text + tool call names for the
 * span outputs. Each inner next() runs inside the turn's AsyncLocalStorage
 * context so tool/LLM wrappers deeper in the call stack find their parent.
 */
export async function* traceAgentTurn<T>(
  turnName: string,
  inputs: unknown,
  inner: AsyncGenerator<T, void, unknown>
): AsyncGenerator<T, void, unknown> {
  const root = startSpan(turnName, 'AGENT' as SpanType, inputs, null);
  if (!root) {
    yield* inner;
    return;
  }
  let text = '';
  const toolCalls: string[] = [];
  let failed = false;
  try {
    while (true) {
      const step = await rootSpanContext.run(root, () => inner.next());
      if (step.done) break;
      const ev = step.value as { type?: string; content?: string; name?: string };
      if (ev?.type === 'message_delta' && typeof ev.content === 'string') text += ev.content;
      else if (ev?.type === 'message' && typeof ev.content === 'string') text = ev.content;
      else if (ev?.type === 'tool_call' && typeof ev.name === 'string') toolCalls.push(ev.name);
      yield step.value;
    }
  } catch (e) {
    failed = true;
    endSpan(root, { error: e });
    recordRecentTrace(root, 'ERROR');
    throw e;
  } finally {
    if (!failed && !root.ended) {
      endSpan(root, { outputs: { output: capPayload(text), tool_calls: toolCalls } });
      recordRecentTrace(root, 'OK');
    }
  }
}

/**
 * Wrap one tool execution in a TOOL span. Outside a traced turn (or when
 * tracing is disabled) the tool just runs — tracing is never required.
 */
export async function traceToolCall<T>(toolName: string, args: unknown, fn: () => Promise<T>): Promise<T> {
  const root = rootSpanContext.getStore();
  const span = root ? startSpan(toolName, 'TOOL' as SpanType, args, root) : null;
  if (!span) return fn();
  try {
    const result = await fn();
    endSpan(span, { outputs: result });
    return result;
  } catch (e) {
    endSpan(span, { error: e });
    throw e;
  }
}

/**
 * Wrap one model-serving round trip in an LLM span. The returned stream is a
 * pass-through that accumulates the SSE text/tool calls and ends the span
 * exactly when the model stream closes — before the adapter (and therefore
 * the root span) finishes, so the trace always contains the complete LLM span.
 */
export async function traceLlmStream(
  model: string,
  requestBody: unknown,
  signal: AbortSignal | undefined,
  streamBody: (body: unknown, signal?: AbortSignal) => Promise<ReadableStream<Uint8Array>>
): Promise<ReadableStream<Uint8Array>> {
  const root = rootSpanContext.getStore();
  const span = root ? startSpan(`llm ${model}`, 'CHAT_MODEL' as SpanType, requestBody, root) : null;
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await streamBody(requestBody, signal);
  } catch (e) {
    if (span) endSpan(span, { error: e });
    throw e;
  }
  if (!span) return stream;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let text = '';
  const toolNames: string[] = [];
  let usage: unknown = null;

  /** Best-effort parse of OpenAI-compatible SSE chunks for span outputs. */
  const accumulate = (chunk: Uint8Array): void => {
    sseBuffer += decoder.decode(chunk, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim()) as {
          choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ function?: { name?: string } }> } }>;
          usage?: unknown;
        };
        const delta = parsed.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') text += delta.content;
        for (const tc of delta?.tool_calls ?? []) {
          const name = tc?.function?.name;
          if (name && !toolNames.includes(name)) toolNames.push(name);
        }
        if (parsed.usage) usage = parsed.usage;
      } catch {
        // partial line or non-JSON payload — span output is best-effort
      }
    }
  };

  const finish = (error?: unknown): void => {
    if (error != null) endSpan(span, { error });
    else endSpan(span, { outputs: { content: capPayload(text), tool_calls: toolNames, usage } });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        accumulate(value);
        controller.enqueue(value);
      } catch (e) {
        finish(e);
        controller.error(e);
      }
    },
    async cancel(reason) {
      finish(reason instanceof Error ? reason : new Error(String(reason)));
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
