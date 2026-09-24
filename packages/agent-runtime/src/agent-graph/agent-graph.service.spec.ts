import { incrementCount } from './agent-graph.service';

describe('incrementCount', () => {
  it('increments the checkpointed count by one', () => {
    expect(incrementCount({ count: 0 })).toEqual({ count: 1 });
    expect(incrementCount({ count: 5 })).toEqual({ count: 6 });
  });
});
