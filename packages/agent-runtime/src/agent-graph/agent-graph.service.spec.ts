import { ConfigService } from '@nestjs/config';

import { AgentGraphService, incrementCount } from './agent-graph.service';

describe('incrementCount', () => {
  it('increments the checkpointed count by one', () => {
    expect(incrementCount({ count: 0 })).toEqual({ count: 1 });
    expect(incrementCount({ count: 5 })).toEqual({ count: 6 });
  });
});

jest.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  PostgresSaver: { fromConnString: jest.fn() },
}));

describe('AgentGraphService.getCheckpointer', () => {
  const configService = { getOrThrow: () => 'postgres://fake' } as unknown as ConfigService;

  function buildService(setup: () => Promise<void>) {
    const { PostgresSaver } = jest.requireMock('@langchain/langgraph-checkpoint-postgres');
    PostgresSaver.fromConnString.mockReturnValue({ setup, end: jest.fn(), getTuple: jest.fn() });

    return new AgentGraphService(configService);
  }

  it('resolves with the checkpointer once setup succeeds', async () => {
    const service = buildService(() => Promise.resolve());

    service.onModuleInit();

    const checkpointer = await service.getCheckpointer();

    expect(checkpointer).toBeDefined();
  });

  it('throws instead of silently handing back an unusable checkpointer when setup() fails', async () => {
    const service = buildService(() => Promise.reject(new Error('agent DB unreachable')));

    service.onModuleInit();

    await expect(service.getCheckpointer()).rejects.toThrow('agent DB unreachable');
  });
});
