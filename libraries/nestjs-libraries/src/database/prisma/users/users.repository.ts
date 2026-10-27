import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { chunk } from 'lodash';
import { Prisma, Provider, Role, User } from '@prisma/client';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { UserDetailDto } from '@gitroom/nestjs-libraries/dtos/users/user.details.dto';
import { EmailNotificationsDto } from '@gitroom/nestjs-libraries/dtos/users/email-notifications.dto';
import { TimezoneDto } from '@gitroom/nestjs-libraries/dtos/users/timezone.dto';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';

@Injectable()
export class UsersRepository {
  constructor(
    private _user: PrismaRepository<'user'>,
    private _userEmail: PrismaRepository<'userEmail'>,
    private _userIdentity: PrismaRepository<'userIdentity'>,
    private _userOrg: PrismaRepository<'userOrganization'>,
    private _transaction: PrismaTransaction
  ) {}

  async switchUserCredentials(currentUserId: string, targetUserId: string) {
    const [users, emails, logins] = await Promise.all([
      this._user.model.user.findMany({
        where: { id: { in: [currentUserId, targetUserId] } },
      }),
      this._userEmail.model.userEmail.findMany({
        where: { userId: { in: [currentUserId, targetUserId] } },
        select: { id: true, userId: true },
      }),
      this._userIdentity.model.userIdentity.findMany({
        where: { userId: { in: [currentUserId, targetUserId] } },
        select: { id: true, userId: true },
      }),
    ]);
    const current = users.find((user) => user.id === currentUserId);
    const target = users.find((user) => user.id === targetUserId);

    if (!current || !target) {
      throw new Error('User not found');
    }

    const idsOf = (rows: { id: string; userId: string }[], userId: string) =>
      rows.filter((row) => row.userId === userId).map((row) => row.id);

    const currentCredentials = {
      email: current.email,
      password: current.password,
      providerName: current.providerName,
      providerId: current.providerId,
      account: current.account,
      connectedAccount: current.connectedAccount,
      activated: current.activated,
    };
    const targetCredentials = {
      email: target.email,
      password: target.password,
      providerName: target.providerName,
      providerId: target.providerId,
      account: target.account,
      connectedAccount: target.connectedAccount,
      activated: target.activated,
    };

    // (email, providerName) is unique and checked per-statement, so park the
    // current user on a throwaway email first, then fill each freed slot. The
    // sign-in rows travel with the credentials, otherwise the login would
    // still resolve to the account it was switched away from.
    await this._transaction.model.$transaction([
      this._user.model.user.update({
        where: { id: current.id },
        data: { email: `switch-${makeId(10)}-${current.email}` },
      }),
      this._user.model.user.update({
        where: { id: target.id },
        data: currentCredentials,
      }),
      this._user.model.user.update({
        where: { id: current.id },
        data: targetCredentials,
      }),
      this._userEmail.model.userEmail.updateMany({
        where: { id: { in: idsOf(emails, current.id) } },
        data: { userId: target.id },
      }),
      this._userEmail.model.userEmail.updateMany({
        where: { id: { in: idsOf(emails, target.id) } },
        data: { userId: current.id },
      }),
      this._userIdentity.model.userIdentity.updateMany({
        where: { id: { in: idsOf(logins, current.id) } },
        data: { userId: target.id },
      }),
      this._userIdentity.model.userIdentity.updateMany({
        where: { id: { in: idsOf(logins, target.id) } },
        data: { userId: current.id },
      }),
    ]);

    return {
      kept: { id: current.id, email: targetCredentials.email },
      switched: { id: target.id, email: currentCredentials.email },
    };
  }

  getImpersonateUser(name: string) {
    return this._user.model.user.findMany({
      where: {
        deletedAt: null,
        OR: [
          {
            name: {
              contains: name,
            },
          },
          {
            email: {
              contains: name,
            },
          },
          {
            id: {
              contains: name,
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
      },
      take: 10,
    });
  }

  getUserById(id: string) {
    return this._user.model.user.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });
  }

  // a person signs in with an address they proved, or with the primary address
  // of an email/password account, which an instance without an email provider
  // can never prove
  async getUserByEmail(email: string) {
    const found = await this._userEmail.model.userEmail.findUnique({
      where: {
        email: email.toLowerCase(),
      },
      select: {
        email: true,
        verifiedAt: true,
        user: {
          include: {
            picture: {
              select: {
                id: true,
                path: true,
              },
            },
          },
        },
      },
    });

    if (!found || found.user.deletedAt || !this.canSignInWith(found)) {
      return null;
    }

    return found.user;
  }

  // only email/password accounts sign in by address, so the unverified primary
  // address of a provider account is contact info, not a credential. A primary
  // address only counts for an account that finished activating, so a
  // registration nobody confirmed cannot hold an address hostage
  private canSignInWith(
    row: {
      email: string;
      verifiedAt: Date | null;
      user: { email: string; providerName: Provider };
    },
    holderActivated = true
  ) {
    return (
      !!row.verifiedAt ||
      (holderActivated &&
        row.user.providerName === Provider.LOCAL &&
        row.user.email.toLowerCase() === row.email)
    );
  }

  private isHeld(holder: {
    email: string;
    verifiedAt: Date | null;
    user: { email: string; providerName: Provider; activated: boolean };
  }) {
    return this.canSignInWith(holder, holder.user.activated);
  }

  private getEmailHolder(email: string) {
    return this._userEmail.model.userEmail.findUnique({
      where: {
        email: email.toLowerCase(),
      },
      select: {
        id: true,
        userId: true,
        email: true,
        verifiedAt: true,
        user: {
          select: {
            email: true,
            providerName: true,
            activated: true,
          },
        },
      },
    });
  }

  // reads only: the row of an address that is not held is released by the
  // registration itself, in the same transaction as the create, and only when
  // the new account proved the address or is local, which proves it at activation
  async getEmailClaim(
    email: string,
    options: { proven: boolean; provider: Provider }
  ): Promise<{ withEmail: boolean; releaseId?: string }> {
    if (!email) {
      return { withEmail: false };
    }

    const canClaim = options.proven || options.provider === Provider.LOCAL;
    const existing = await this.getEmailHolder(email);

    if (!existing) {
      return { withEmail: canClaim };
    }

    if (this.isHeld(existing) || !canClaim) {
      return { withEmail: false };
    }

    return { withEmail: true, releaseId: existing.id };
  }

  getUserWithActiveSubscriptionByEmail(email: string, excludeUserId: string) {
    return this._user.model.user.findFirst({
      where: {
        email,
        id: { not: excludeUserId },
        deletedAt: null,
        organizations: {
          some: {
            role: Role.SUPERADMIN,
            organization: {
              subscription: { is: { deletedAt: null } },
            },
          },
        },
      },
      select: { id: true, email: true, providerName: true },
    });
  }

  getUserByVerifiedEmail(email: string) {
    return this._user.model.user.findFirst({
      where: {
        emails: {
          some: {
            email: email.toLowerCase(),
            verifiedAt: { not: null },
          },
        },
        deletedAt: null,
      },
    });
  }

  // activating the account also proves the address the activation link was sent to
  async activateUser(id: string) {
    const [user] = await this._transaction.model.$transaction([
      this._user.model.user.update({
        where: {
          id,
        },
        data: {
          activated: true,
        },
      }),
      this._userEmail.model.userEmail.updateMany({
        where: {
          userId: id,
          verifiedAt: null,
        },
        data: {
          verifiedAt: new Date(),
        },
      }),
    ]);

    return user;
  }

  getUserByProvider(providerId: string, provider: Provider) {
    return this._user.model.user.findFirst({
      where: {
        identities: {
          some: {
            provider,
            providerId,
          },
        },
        deletedAt: null,
      },
    });
  }

  addIdentity(userId: string, provider: Provider, providerId: string) {
    return this._userIdentity.model.userIdentity.create({
      data: {
        userId,
        provider,
        providerId,
      },
      select: {
        id: true,
      },
    });
  }

  getPrimaryEmail(userId: string) {
    return this._user.model.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { email: true },
    });
  }

  getEmails(userId: string) {
    return this._userEmail.model.userEmail.findMany({
      where: {
        userId,
      },
      select: {
        id: true,
        email: true,
        verifiedAt: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  getEmailById(userId: string, id: string) {
    return this._userEmail.model.userEmail.findFirst({
      where: {
        id,
        userId,
      },
      select: {
        id: true,
        email: true,
        verifiedAt: true,
      },
    });
  }

  // the pending row of another account is left alone, the address only moves
  // when its link is clicked (see verifyEmail), so adding it cannot be used to
  // knock a pending address off somebody else's account
  async addEmail(userId: string, rawEmail: string) {
    const email = rawEmail.toLowerCase();
    const existing = await this.getEmailHolder(email);

    if (existing?.userId === userId) {
      return {
        email,
        row: { id: existing.id, verifiedAt: existing.verifiedAt },
      };
    }

    if (existing) {
      return this.isHeld(existing) ? null : { email, row: null };
    }

    try {
      const row = await this._userEmail.model.userEmail.create({
        data: {
          userId,
          email,
        },
        select: {
          id: true,
          verifiedAt: true,
        },
      });

      return { email, row };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return null;
      }

      throw err;
    }
  }

  async verifyEmail(userId: string, rawEmail: string) {
    const email = rawEmail.toLowerCase();
    const [user, existing] = await Promise.all([
      this._user.model.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true },
      }),
      this.getEmailHolder(email),
    ]);
    if (!user) {
      return false;
    }

    try {
      if (!existing) {
        await this._userEmail.model.userEmail.create({
          data: {
            userId,
            email,
            verifiedAt: new Date(),
          },
          select: {
            id: true,
          },
        });

        return true;
      }

      if (existing.userId !== userId && this.isHeld(existing)) {
        return false;
      }

      if (existing.userId === userId && existing.verifiedAt) {
        return true;
      }

      // conditional on the row still being unverified and with the owner read
      // above, so a parallel verification cannot be overwritten
      const { count } = await this._userEmail.model.userEmail.updateMany({
        where: {
          id: existing.id,
          userId: existing.userId,
          verifiedAt: null,
        },
        data: {
          userId,
          verifiedAt: new Date(),
        },
      });

      return count > 0;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return false;
      }

      throw err;
    }
  }

  removeEmail(userId: string, id: string) {
    return this._userEmail.model.userEmail.deleteMany({
      where: {
        id,
        userId,
      },
    });
  }

  async deleteAccount(userId: string) {
    const user = await this._user.model.user.findUnique({
      where: {
        id: userId,
      },
    });

    if (!user || user.deletedAt) {
      return;
    }

    const [deleted] = await this._transaction.model.$transaction([
      this._user.model.user.update({
        where: {
          id: userId,
        },
        data: this.deletedUserData(user),
      }),
      ...this.detachLogins(userId),
    ]);

    return deleted;
  }

  // Hash the identifying fields instead of removing the row, the random
  // suffix keeps [email, providerName] unique if the same email is deleted
  // more than once
  private deletedUserData(user: User): Prisma.UserUncheckedUpdateInput {
    const hash = (value: string) =>
      createHash('md5').update(value).digest('hex');

    return {
      email: `deleted_${hash(user.email.toLowerCase())}_${makeId(5)}`,
      password: null,
      name: user.name ? hash(user.name) : null,
      lastName: user.lastName ? hash(user.lastName) : null,
      providerId: user.providerId ? hash(user.providerId) : null,
      bio: null,
      ip: null,
      agent: null,
      account: null,
      pictureId: null,
      deletedAt: new Date(),
    };
  }

  // the addresses and external logins are what let a person sign in, so they
  // must go with the account instead of staying bound to a deleted row
  private detachLogins(userId: string) {
    return [
      this._userEmail.model.userEmail.deleteMany({
        where: {
          userId,
        },
      }),
      this._userIdentity.model.userIdentity.deleteMany({
        where: {
          userId,
        },
      }),
    ];
  }

  // moves everything a person can sign in with, and every membership, onto one
  // account, then retires the other rows the same way deleteAccount does
  async mergeUsers(targetId: string, sourceIds: string[]) {
    const target = await this.getUserById(targetId);
    if (!target) {
      throw new Error('Target user not found');
    }

    const sources = await this._user.model.user.findMany({
      where: {
        id: { in: sourceIds.filter((id) => id !== targetId) },
        deletedAt: null,
      },
    });

    const rank: Record<Role, number> = {
      [Role.USER]: 0,
      [Role.ADMIN]: 1,
      [Role.SUPERADMIN]: 2,
    };
    let targetHasPassword = !!target.password;
    for (const source of sources) {
      const [targetOrgs, sourceOrgs] = await Promise.all([
        this._userOrg.model.userOrganization.findMany({
          where: { userId: targetId },
        }),
        this._userOrg.model.userOrganization.findMany({
          where: { userId: source.id },
        }),
      ]);

      // a membership the target already holds is dropped. A disabled source
      // membership adds nothing, an enabled one re-enables a disabled target
      // and brings its role, otherwise the higher role is kept
      const memberships = sourceOrgs.flatMap((membership) => {
        const existing = targetOrgs.find(
          (p) => p.organizationId === membership.organizationId
        );
        if (!existing) {
          return [
            this._userOrg.model.userOrganization.update({
              where: { id: membership.id },
              data: { userId: targetId },
            }),
          ];
        }

        const reEnable = existing.disabled && !membership.disabled;
        return [
          this._userOrg.model.userOrganization.delete({
            where: { id: membership.id },
          }),
          ...(!membership.disabled &&
          (reEnable || rank[membership.role] > rank[existing.role])
            ? [
                this._userOrg.model.userOrganization.update({
                  where: { id: existing.id },
                  data: {
                    role: membership.role,
                    ...(reEnable ? { disabled: false } : {}),
                  },
                }),
              ]
            : []),
        ];
      });

      // the operator merging the accounts vouches for the address the source
      // signed in with, and the target needs some password to keep using it
      const copyPassword = !targetHasPassword && !!source.password;
      targetHasPassword ||= copyPassword;

      await this._transaction.model.$transaction([
        this._userEmail.model.userEmail.updateMany({
          where: {
            userId: source.id,
            verifiedAt: null,
            email: source.email.toLowerCase(),
          },
          data: { verifiedAt: new Date() },
        }),
        this._userEmail.model.userEmail.updateMany({
          where: { userId: source.id },
          data: { userId: targetId },
        }),
        ...(copyPassword
          ? [
              this._user.model.user.update({
                where: { id: targetId },
                data: { password: source.password },
                select: { id: true },
              }),
            ]
          : []),
        this._userIdentity.model.userIdentity.updateMany({
          where: { userId: source.id },
          data: { userId: targetId },
        }),
        ...memberships,
        this._user.model.user.update({
          where: { id: source.id },
          data: this.deletedUserData(source),
        }),
      ]);
    }

    return sources.map((source) => ({ id: source.id, email: source.email }));
  }

  // accounts created before the UserEmail / UserIdentity tables existed get
  // their rows here, so it only touches users that still miss them and is cheap
  // to run at every start. A login already owned by another account is reported
  // instead of moved, those accounts need a merge. Only addresses of the
  // trusted providers, which always assert theirs, are marked verified, other
  // providers get no address row.
  async backfillIdentities(trustedProviders: Provider[]) {
    const conflicts: { userId: string; login: string; ownerId: string }[] = [];

    // wallet and farcaster accounts keep a pseudo value in User.email
    const users = await this._user.model.user.findMany({
      where: {
        deletedAt: null,
        OR: [
          {
            providerName: { not: Provider.LOCAL },
            providerId: { not: null },
            NOT: { providerId: '' },
            identities: { none: {} },
          },
          {
            email: { contains: '@' },
            NOT: { email: { startsWith: 'deleted_' } },
            emails: { none: {} },
          },
        ],
      },
      select: {
        id: true,
        email: true,
        providerName: true,
        providerId: true,
        createdAt: true,
        _count: { select: { identities: true, emails: true } },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // local accounts sign in through their address, so they get it before a
    // provider account that happens to share it, which signs in via its identity
    const local = (user: { providerName: Provider }) =>
      user.providerName === Provider.LOCAL ? 0 : 1;
    users.sort((a, b) => local(a) - local(b));

    await this.createMissingRows(
      users.filter(
        (user) =>
          !user._count.identities &&
          user.providerName !== Provider.LOCAL &&
          !!user.providerId
      ),
      conflicts,
      {
        key: (user) => `${user.providerName}:${user.providerId}`,
        toRow: (user) => ({
          userId: user.id,
          provider: user.providerName,
          providerId: user.providerId!,
        }),
        findOwners: async (keys) =>
          (
            await this._userIdentity.model.userIdentity.findMany({
              where: {
                providerId: {
                  in: keys.map((k) => k.slice(k.indexOf(':') + 1)),
                },
              },
              select: { userId: true, provider: true, providerId: true },
            })
          ).map((row) => ({
            key: `${row.provider}:${row.providerId}`,
            userId: row.userId,
          })),
        createMany: (data) =>
          this._userIdentity.model.userIdentity.createMany({
            data,
            skipDuplicates: true,
          }),
      }
    );

    await this.createMissingRows(
      users.filter(
        (user) =>
          !user._count.emails &&
          user.email.includes('@') &&
          !user.email.startsWith('deleted_') &&
          (user.providerName === Provider.LOCAL ||
            trustedProviders.includes(user.providerName))
      ),
      conflicts,
      {
        key: (user) => user.email.toLowerCase(),
        toRow: (user) => ({
          userId: user.id,
          email: user.email.toLowerCase(),
          verifiedAt: trustedProviders.includes(user.providerName)
            ? user.createdAt
            : null,
        }),
        findOwners: async (keys) =>
          (
            await this._userEmail.model.userEmail.findMany({
              where: { email: { in: keys } },
              select: { userId: true, email: true },
            })
          ).map((row) => ({ key: row.email, userId: row.userId })),
        createMany: (data) =>
          this._userEmail.model.userEmail.createMany({
            data,
            skipDuplicates: true,
          }),
      }
    );

    return conflicts;
  }

  // looks up who already owns the keys, reports those as conflicts (also when
  // two users of the batch share a key) and creates the rest
  private async createMissingRows<
    U extends { id: string },
    R extends { userId: string }
  >(
    users: U[],
    conflicts: { userId: string; login: string; ownerId: string }[],
    {
      key,
      toRow,
      findOwners,
      createMany,
    }: {
      key: (user: U) => string;
      toRow: (user: U) => R;
      findOwners: (
        keys: string[]
      ) => Promise<{ key: string; userId: string }[]>;
      createMany: (rows: R[]) => Promise<unknown>;
    }
  ) {
    const owners = new Map<string, string>();
    for (const part of chunk(users, 500)) {
      for (const row of await findOwners(part.map(key))) {
        owners.set(row.key, row.userId);
      }
    }

    const rows: R[] = [];
    for (const user of users) {
      const login = key(user);
      const ownerId = owners.get(login);
      if (ownerId) {
        conflicts.push({ userId: user.id, login, ownerId });
        continue;
      }

      owners.set(login, user.id);
      rows.push(toRow(user));
    }

    for (const part of chunk(rows, 500)) {
      await createMany(part);
    }
  }

  updatePassword(id: string, password: string) {
    return this._user.model.user.update({
      where: {
        id,
      },
      data: {
        password: AuthService.hashPassword(password),
      },
      select: {
        id: true,
      },
    });
  }

  changeAudienceSize(userId: string, audience: number) {
    return this._user.model.user.update({
      where: {
        id: userId,
      },
      data: {
        audience,
      },
    });
  }

  async getPersonal(userId: string) {
    const user = await this._user.model.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        name: true,
        bio: true,
        picture: {
          select: {
            id: true,
            path: true,
          },
        },
      },
    });

    return user;
  }

  async changePersonal(userId: string, body: UserDetailDto) {
    await this._user.model.user.update({
      where: {
        id: userId,
      },
      data: {
        name: body.fullname,
        bio: body.bio,
        picture: body.picture
          ? {
              connect: {
                id: body.picture.id,
              },
            }
          : {
              disconnect: true,
            },
      },
    });
  }

  async getEmailNotifications(userId: string) {
    return this._user.model.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        sendSuccessEmails: true,
        sendFailureEmails: true,
        sendStreakEmails: true,
      },
    });
  }

  async updateEmailNotifications(userId: string, body: EmailNotificationsDto) {
    await this._user.model.user.update({
      where: {
        id: userId,
      },
      data: {
        sendSuccessEmails: body.sendSuccessEmails,
        sendFailureEmails: body.sendFailureEmails,
        sendStreakEmails: body.sendStreakEmails,
      },
    });
  }

  async updateTimezone(userId: string, body: TimezoneDto) {
    await this._user.model.user.update({
      where: {
        id: userId,
      },
      data: {
        timezoneName: body.timezoneName || null,
      },
      select: {
        id: true,
      },
    });
  }
}
