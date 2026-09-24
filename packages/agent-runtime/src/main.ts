import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { setupTracing } from './tracing/tracing';

async function bootstrap() {
  // Best-effort: tracing is observability, not a functional dependency — the
  // Telegram bot and Controlled Tool API must still start if Phoenix is down
  // or unreachable, same as every other non-critical-infra path in this app.
  try {
    await setupTracing();
  } catch (error) {
    new Logger('Tracing').error(
      'Failed to set up tracing, continuing without it',
      error instanceof Error ? error.stack : error,
    );
  }

  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3100;

  await app.listen(port);
}

bootstrap();
