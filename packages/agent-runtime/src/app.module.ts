import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ControlledToolApiModule } from './controlled-tool-api/controlled-tool-api.module';
import { HealthController } from './health/health.controller';
import { LlmModule } from './llm/llm.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ControlledToolApiModule,
    TelegramModule,
    LlmModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
