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

// A separate, minimal graph for ticket #25's proof action: one node,
// checkpointed under thread_id = the action's own actionId (not this file's
// fixed DEMO_THREAD_ID), so each proof action run gets its own real,
// queryable checkpoint history. Deliberately not folded into DemoGraphState
// above — see this class's own CONTEXT.md entry on why runDemo isn't grown
// in place.
const ProofActionGraphState = Annotation.Root({
  payload: Annotation<unknown>(),
  proposedAt: Annotation<string>(),
});

function proposeProofAction(
  _state: typeof ProofActionGraphState.State,
): Partial<typeof ProofActionGraphState.State> {
  return { proposedAt: new Date().toISOString() };
}

@Injectable()
export class AgentGraphService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentGraphService.name);
  private readonly checkpointer: PostgresSaver;
  private initPromise: Promise<void> = Promise.resolve();
  // Distinct from a failed demo run (best-effort, logged and swallowed below)
  // — this tracks whether the checkpointer itself is actually usable, so a
  // real caller like getCheckpointer() can throw instead of silently handing
  // back a PostgresSaver whose setup() never completed.
  private checkpointerSetupError: Error | undefined;

  constructor(configService: ConfigService) {
    this.checkpointer = PostgresSaver.fromConnString(
      configService.getOrThrow<string>('AGENT_DB_URL'),
    );
  }

  onModuleInit(): void {
    // Fire-and-forget from the caller's perspective: an unreachable/
    // unprovisioned agent DB must not block the rest of the app (Telegram,
    // /healthz) from starting. Tracked here (not `void`) so onModuleDestroy
    // can wait for it before closing the pool it's still using.
    this.initPromise = this.initializeAndRunDemo();
  }

  async onModuleDestroy(): Promise<void> {
    await this.initPromise;
    await this.checkpointer.end();
  }

  private async initializeAndRunDemo(): Promise<void> {
    try {
      await this.checkpointer.setup();
    } catch (error) {
      // Recorded, not just logged: setup() failing means the checkpointer is
      // unusable for every caller, not only this file's own demo — swallowing
      // it the same way as a demo failure would let getCheckpointer() hand
      // back a checkpointer that silently fails on first real use instead of
      // surfacing the real problem to whoever's waiting on it.
      this.checkpointerSetupError =
        error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        'Agent graph checkpointer setup failed — the checkpointer is unusable',
        error instanceof Error ? error.stack : error,
      );

      return;
    }

    try {
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

  // Ticket #25: a real LangGraph checkpoint write tied to one specific
  // proof-action run, not this file's own fixed-thread demo above. Reuses
  // this.checkpointer (the same Postgres connection, same underlying
  // checkpoint tables — thread_id is what isolates one run from another,
  // not a separate connection or table set) rather than every caller
  // opening its own PostgresSaver, which this RAM-constrained deploy has no
  // spare connections for.
  async checkpointProofAction(threadId: string, payload: unknown): Promise<void> {
    await this.initPromise;

    const graph = new StateGraph(ProofActionGraphState)
      .addNode('propose', proposeProofAction)
      .addEdge(START, 'propose')
      .addEdge('propose', END)
      .compile({ checkpointer: this.checkpointer });

    await graph.invoke({ payload, proposedAt: '' }, { configurable: { thread_id: threadId } });
  }

  // Ticket #43: the Manager agent's own DeepAgents graph needs a checkpointer
  // too, and — same reasoning as checkpointProofAction above — reuses this
  // one Postgres connection rather than opening a new one. Async because
  // the checkpointer isn't safe to use until this.checkpointer.setup() (run
  // inside initializeAndRunDemo) has completed.
  async getCheckpointer(): Promise<PostgresSaver> {
    await this.initPromise;

    if (this.checkpointerSetupError) {
      throw this.checkpointerSetupError;
    }

    return this.checkpointer;
  }
}
