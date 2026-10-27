import { Command, Positional } from 'nestjs-command';
import { Injectable } from '@nestjs/common';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';

@Injectable()
export class AccountsTask {
  constructor(private _usersService: UsersService) {}

  @Command({
    command: 'accounts:backfill-identities',
    describe:
      'Create the UserEmail / UserIdentity rows for users registered before those tables existed',
  })
  async backfill() {
    const conflicts = await this._usersService.backfillIdentities();
    for (const conflict of conflicts) {
      console.log(
        `Skipped ${conflict.login} for user ${conflict.userId}: already owned by user ${conflict.ownerId}, merge them with accounts:merge`
      );
    }
    console.log(`Done, ${conflicts.length} conflict(s)`);
    return true;
  }

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
