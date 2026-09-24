import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DemoGraphState = Annotation.Root({
  count: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
});

export function incrementCount(
  state: typeof DemoGraphState.State,
): Partial<typeof DemoGraphState.State> {
  return { count: state.count + 1 };
}

// Fixed thread so every process boot resumes the same checkpointed run instead
// of starting a fresh thread each time — that's what proves persistence works.
const DEMO_THREAD_ID = 'agent-graph-demo';

@Injectable()
export class AgentGraphService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentGraphService.name);
  private readonly checkpointer: PostgresSaver;

  constructor(configService: ConfigService) {
    this.checkpointer = PostgresSaver.fromConnString(
      configService.getOrThrow<string>('AGENT_DB_URL'),
    );
  }

  onModuleInit(): void {
    // Fire-and-forget: an unreachable/unprovisioned agent DB must not block the
    // rest of the app (Telegram, /healthz) from starting.
    void this.initializeAndRunDemo();
  }

  async onModuleDestroy(): Promise<void> {
    await this.checkpointer.end();
  }

  private async initializeAndRunDemo(): Promise<void> {
    try {
      await this.checkpointer.setup();

      const count = await this.runDemo();

      this.logger.log(
        `Agent graph checkpoint demo: count is now ${count} (resumed from the last checkpoint, if one existed)`,
      );
    } catch (error) {
      this.logger.error(
        'Agent graph checkpoint demo failed',
        error instanceof Error ? error.stack : error,
      );
    }
  }

  async runDemo(): Promise<number> {
    const graph = new StateGraph(DemoGraphState)
      .addNode('increment', incrementCount)
      .addEdge(START, 'increment')
      .addEdge('increment', END)
      .compile({ checkpointer: this.checkpointer });

    const result = await graph.invoke(
      {},
      { configurable: { thread_id: DEMO_THREAD_ID } },
    );

    return result.count;
  }
}
