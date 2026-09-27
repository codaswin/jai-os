import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3100;

  // Without this, Nest never calls onModuleDestroy on SIGTERM/SIGINT — every
  // graceful-shutdown hook in this app (Telegram's poll-drain, the agent
  // graph's checkpointer.end(), and now the queue/worker close below) is
  // otherwise dead code outside of tests.
  app.enableShutdownHooks();

  await app.listen(port);
}

bootstrap();
