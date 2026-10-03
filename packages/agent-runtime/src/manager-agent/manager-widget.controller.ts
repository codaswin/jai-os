import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import { ManagerAgentService } from './manager-agent.service';
import { TwentyCurrentUserService } from './twenty-current-user.service';

const widgetMessageBodySchema = z.object({ text: z.string().min(1) });

// The first entry point into agent-runtime other than Telegram's own
// long-polling connection (ticket #45) — ops/Caddyfile exposes only
// /agent-api/widget/* publicly, nothing else on this service. Every request
// here is independently re-verified against Twenty on every call; nothing
// about a prior request (or the widget's own UI toggle) is trusted.
@Controller('widget')
export class ManagerWidgetController {
  constructor(
    private readonly twentyCurrentUser: TwentyCurrentUserService,
    private readonly managerAgent: ManagerAgentService,
  ) {}

  @Post('message')
  async postMessage(
    @Headers('authorization') authorizationHeader: string | undefined,
    @Body() rawBody: unknown,
  ): Promise<{ reply: string }> {
    const token = extractBearerToken(authorizationHeader);

    if (!token) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    // Re-checked on every single request, never cached — a token valid a
    // minute ago, or a role that was Admin a minute ago, might not be now.
    // This is the one place that actually enforces the access boundary; the
    // widget's own sidebar visibility is a convenience, not a check.
    const currentUser = await this.twentyCurrentUser.verifyToken(token);

    if (!currentUser) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (!currentUser.canAccessFullAdminPanel) {
      throw new ForbiddenException('Only an Admin may reach the Manager agent');
    }

    const parsedBody = widgetMessageBodySchema.safeParse(rawBody);

    if (!parsedBody.success) {
      throw new BadRequestException('Request body must be { text: string } with a non-empty text');
    }

    // The verified Twenty user ID is the conversation key — never a
    // client-supplied value, consistent with never trusting anything the
    // client asserts about its own identity. All CRM access still happens
    // under the Manager's own service scope via handleMessage, never under
    // this token, which is used only to get this far.
    const result = await this.managerAgent.handleMessage({
      channel: 'widget',
      conversationKey: currentUser.id,
      text: parsedBody.data.text,
    });

    return { reply: result.reply };
  }
}

function extractBearerToken(authorizationHeader: string | undefined): string | null {
  const match = authorizationHeader ? /^Bearer (.+)$/i.exec(authorizationHeader) : null;

  return match ? match[1] : null;
}
