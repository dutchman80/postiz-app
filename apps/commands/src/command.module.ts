import { Module } from '@nestjs/common';
import { CommandModule as ExternalCommandModule } from 'nestjs-command';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { RefreshTokens } from './tasks/refresh.tokens';
import { ConfigurationTask } from './tasks/configuration';
import { AgentRun } from './tasks/agent.run';
import { AccountsTask } from './tasks/accounts';
import { AgentModule } from '@gitroom/nestjs-libraries/agent/agent.module';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';

@Module({
  // the database services need the Temporal client, the same as the backend
  imports: [
    ExternalCommandModule,
    DatabaseModule,
    AgentModule,
    getTemporalModule(false),
  ],
  controllers: [],
  providers: [RefreshTokens, ConfigurationTask, AgentRun, AccountsTask],
  get exports() {
    return [...this.imports, ...this.providers];
  },
})
export class CommandModule {}
