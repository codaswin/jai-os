import { Module } from '@nestjs/common';

import { ControlledToolApiService } from './controlled-tool-api.service';
import { TwentyGraphqlClientService } from './twenty-graphql-client.service';

@Module({
  providers: [ControlledToolApiService, TwentyGraphqlClientService],
  exports: [ControlledToolApiService],
})
export class ControlledToolApiModule {}
