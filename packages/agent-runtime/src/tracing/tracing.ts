import { SEMRESATTRS_PROJECT_NAME } from '@arizeai/openinference-semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { registerTelemetry } from 'ai';

// One project so every generate() call (via registerTelemetry below) and
// every Controlled Tool API call (via traceTool, see controlled-tool-api)
// land in the same Phoenix dashboard, not two separate ones.
const PROJECT_NAME = 'jai-os-agent-runtime';

// @ai-sdk/otel and @arizeai/openinference-vercel ship ESM-only (no CJS
// "require" export condition), unlike this file's other imports. A plain
// `await import(...)` doesn't help — under module: "commonjs" TypeScript
// downlevels it to `Promise.resolve().then(() => require(...))`, which hits
// the same resolution failure. Going through `Function` hides the specifier
// from that downleveling, so this stays a genuine dynamic import Node's
// loader resolves at runtime.
const importEsm = <TModule>(specifier: string): Promise<TModule> =>
  (new Function('specifier', 'return import(specifier)') as (s: string) => Promise<TModule>)(
    specifier,
  );

export async function setupTracing(): Promise<void> {
  const collectorEndpoint =
    process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006/v1/traces';

  const [
    { isOpenInferenceSpan, OpenInferenceBatchSpanProcessor },
    { OpenTelemetry },
  ] = await Promise.all([
    importEsm<typeof import('@arizeai/openinference-vercel')>('@arizeai/openinference-vercel'),
    importEsm<typeof import('@ai-sdk/otel')>('@ai-sdk/otel'),
  ]);

  const tracerProvider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [SEMRESATTRS_PROJECT_NAME]: PROJECT_NAME,
    }),
    spanProcessors: [
      new OpenInferenceBatchSpanProcessor({
        exporter: new OTLPTraceExporter({ url: collectorEndpoint }),
        // The Vercel AI SDK's own spans aren't OpenInference-tagged until this
        // processor converts them; traceTool's spans already are. Either way,
        // this keeps out anything neither of those two paths produced.
        spanFilter: isOpenInferenceSpan,
      }),
    ],
  });

  tracerProvider.register();

  registerTelemetry(
    new OpenTelemetry({
      usage: true,
      providerMetadata: true,
    }),
  );
}
