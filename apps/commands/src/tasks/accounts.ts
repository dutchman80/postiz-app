import { Command, Positional } from 'nestjs-command';
import { Injectable } from '@nestjs/common';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';

@Injectable()
export class AccountsTask {
  constructor(private _usersService: UsersService) {}

  @Command({
    command: 'accounts:merge <target> <sources..>',
    describe:
      'Move the sign-in emails, logins and memberships of the source users onto the target user and retire the sources',
  })
  async merge(
    @Positional({ name: 'target', type: 'string' }) target: string,
    @Positional({ name: 'sources', type: 'string' }) sources: string | string[]
  ) {
    const merged = await this._usersService.mergeUsers(
      target,
      Array.isArray(sources) ? sources : [sources]
    );
    for (const user of merged) {
      console.log(`Merged ${user.email} (${user.id}) into ${target}`);
    }
    return true;
  }
}
