import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ControlledToolApiModule } from './controlled-tool-api/controlled-tool-api.module';
import { HealthController } from './health/health.controller';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ControlledToolApiModule,
    TelegramModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
