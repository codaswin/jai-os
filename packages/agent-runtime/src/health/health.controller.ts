import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('healthz')
  check() {
    return { status: 'ok' };
  }
}
