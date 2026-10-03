import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { type ManagerAgentService } from './manager-agent.service';
import { ManagerWidgetController } from './manager-widget.controller';
import { type TwentyCurrentUserService } from './twenty-current-user.service';

// 'ai', '@ai-sdk/fireworks', and '@ai-sdk/openai' all ship ESM-only output
// this project's jest config doesn't transform (same reason
// manager-agent.service.spec.ts mocks them) — loaded transitively because
// ManagerWidgetController imports the real LlmService class (NestJS DI needs
// the real constructor reference), even though this spec never constructs one.
jest.mock('ai', () => ({
  tool: jest.fn((spec: unknown) => spec),
}));
jest.mock('@ai-sdk/fireworks', () => ({
  createFireworks: jest.fn(() => jest.fn((modelId: string) => ({ modelId, provider: 'fireworks' }))),
}));
jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => jest.fn((modelId: string) => ({ modelId, provider: 'openai' }))),
}));

describe('ManagerWidgetController', () => {
  function buildController(overrides?: {
    verifyToken?: jest.Mock;
    handleMessage?: jest.Mock;
  }) {
    const twentyCurrentUser = {
      verifyToken: overrides?.verifyToken ?? jest.fn(),
    } as unknown as TwentyCurrentUserService;
    const managerAgent = {
      handleMessage: overrides?.handleMessage ?? jest.fn(),
    } as unknown as ManagerAgentService;

    return new ManagerWidgetController(twentyCurrentUser, managerAgent);
  }

  it('rejects a request with no Authorization header', async () => {
    const controller = buildController();

    await expect(controller.postMessage(undefined, { text: 'hi' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a malformed Authorization header', async () => {
    const controller = buildController();

    await expect(controller.postMessage('not-a-bearer-token', { text: 'hi' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an invalid or expired token, verified fresh every call', async () => {
    const verifyToken = jest.fn().mockResolvedValue(null);
    const controller = buildController({ verifyToken });

    await expect(controller.postMessage('Bearer expired-token', { text: 'hi' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(verifyToken).toHaveBeenCalledWith('expired-token');
  });

  it('rejects a logged-in Member (non-Admin) with 403, even with a crafted request bypassing the widget UI entirely', async () => {
    const verifyToken = jest.fn().mockResolvedValue({ id: 'member-1', canAccessFullAdminPanel: false });
    const handleMessage = jest.fn();
    const controller = buildController({ verifyToken, handleMessage });

    await expect(controller.postMessage('Bearer member-token', { text: 'hi' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('rejects a malformed body even for an authenticated Admin', async () => {
    const verifyToken = jest.fn().mockResolvedValue({ id: 'admin-1', canAccessFullAdminPanel: true });
    const controller = buildController({ verifyToken });

    await expect(controller.postMessage('Bearer admin-token', { text: '' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('routes an Admin request to handleMessage under the widget channel, keyed by the verified user id — never a client-supplied value', async () => {
    const verifyToken = jest.fn().mockResolvedValue({ id: 'admin-1', canAccessFullAdminPanel: true });
    const handleMessage = jest.fn().mockResolvedValue({ reply: 'Jane Doe is a lead.' });
    const controller = buildController({ verifyToken, handleMessage });

    const result = await controller.postMessage('Bearer admin-token', {
      text: 'Who is Jane Doe?',
      conversationKey: 'attacker-supplied-key',
    });

    expect(handleMessage).toHaveBeenCalledWith({
      channel: 'widget',
      conversationKey: 'admin-1',
      text: 'Who is Jane Doe?',
    });
    expect(result).toEqual({ reply: 'Jane Doe is a lead.' });
  });

  it('verifies the token on every call, never caching a prior result', async () => {
    const verifyToken = jest
      .fn()
      .mockResolvedValueOnce({ id: 'admin-1', canAccessFullAdminPanel: true })
      .mockResolvedValueOnce(null);
    const handleMessage = jest.fn().mockResolvedValue({ reply: 'ok' });
    const controller = buildController({ verifyToken, handleMessage });

    await controller.postMessage('Bearer admin-token', { text: 'first' });
    await expect(controller.postMessage('Bearer admin-token', { text: 'second' })).rejects.toThrow(
      UnauthorizedException,
    );

    expect(verifyToken).toHaveBeenCalledTimes(2);
  });
});
