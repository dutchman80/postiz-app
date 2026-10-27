import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
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
    const current = await this._user.model.user.findUnique({
      where: { id: currentUserId },
    });
    const target = await this._user.model.user.findUnique({
      where: { id: targetUserId },
    });

    if (!current || !target) {
      throw new Error('User not found');
    }

    const [currentEmails, targetEmails, currentLogins, targetLogins] =
      await Promise.all([
        this._userEmail.model.userEmail.findMany({
          where: { userId: current.id },
          select: { id: true },
        }),
        this._userEmail.model.userEmail.findMany({
          where: { userId: target.id },
          select: { id: true },
        }),
        this._userIdentity.model.userIdentity.findMany({
          where: { userId: current.id },
          select: { id: true },
        }),
        this._userIdentity.model.userIdentity.findMany({
          where: { userId: target.id },
          select: { id: true },
        }),
      ]);

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
        where: { id: { in: currentEmails.map((row) => row.id) } },
        data: { userId: target.id },
      }),
      this._userEmail.model.userEmail.updateMany({
        where: { id: { in: targetEmails.map((row) => row.id) } },
        data: { userId: current.id },
      }),
      this._userIdentity.model.userIdentity.updateMany({
        where: { id: { in: currentLogins.map((row) => row.id) } },
        data: { userId: target.id },
      }),
      this._userIdentity.model.userIdentity.updateMany({
        where: { id: { in: targetLogins.map((row) => row.id) } },
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

  // a person signs in with an address they proved, or with the account's primary
  // address, which an instance without an email provider can never prove
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

  // a primary address only counts for an account that finished activating, so
  // a registration nobody confirmed cannot hold an address hostage
  private canSignInWith(
    row: {
      email: string;
      verifiedAt: Date | null;
      user: { email: string };
    },
    holderActivated = true
  ) {
    return (
      !!row.verifiedAt ||
      (holderActivated && row.user.email.toLowerCase() === row.email)
    );
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
            activated: true,
          },
        },
      },
    });
  }

  // an unverified address may be taken over by whoever proves it first, unless
  // the account holding it signs in with it
  async claimEmail(email: string) {
    if (!email) {
      return false;
    }

    const existing = await this.getEmailHolder(email);

    if (!existing) {
      return true;
    }

    if (this.canSignInWith(existing, existing.user.activated)) {
      return false;
    }

    await this._userEmail.model.userEmail.delete({
      where: {
        id: existing.id,
      },
      select: {
        id: true,
      },
    });

    return true;
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
  async addEmail(userId: string, email: string) {
    const existing = await this.getEmailHolder(email);

    if (existing?.userId === userId) {
      return {
        id: existing.id,
        email: existing.email,
        verifiedAt: existing.verifiedAt,
      };
    }

    if (existing) {
      return this.canSignInWith(existing, existing.user.activated)
        ? null
        : { id: null, email, verifiedAt: null };
    }

    try {
      return await this._userEmail.model.userEmail.create({
        data: {
          userId,
          email,
        },
        select: {
          id: true,
          email: true,
          verifiedAt: true,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return null;
      }

      throw err;
    }
  }

  async verifyEmail(userId: string, email: string) {
    if (!(await this.getUserById(userId))) {
      return false;
    }

    const existing = await this.getEmailHolder(email);

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

      if (
        existing.userId !== userId &&
        this.canSignInWith(existing, existing.user.activated)
      ) {
        return false;
      }

      if (existing.userId === userId && existing.verifiedAt) {
        return true;
      }

      await this._userEmail.model.userEmail.update({
        where: {
          id: existing.id,
        },
        data: {
          userId,
          verifiedAt: new Date(),
        },
        select: {
          id: true,
        },
      });

      return true;
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

    const rank = { USER: 0, ADMIN: 1, SUPERADMIN: 2 };
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

      // a membership the target already holds is dropped, keeping the higher role
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

        return [
          this._userOrg.model.userOrganization.delete({
            where: { id: membership.id },
          }),
          ...(rank[membership.role] > rank[existing.role]
            ? [
                this._userOrg.model.userOrganization.update({
                  where: { id: existing.id },
                  data: { role: membership.role },
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
  // instead of moved, those accounts need a merge.
  async backfillIdentities() {
    const conflicts: { userId: string; login: string; ownerId: string }[] = [];

    const missingIdentity = await this._user.model.user.findMany({
      where: {
        deletedAt: null,
        providerName: { not: Provider.LOCAL },
        identities: { none: {} },
      },
      select: {
        id: true,
        providerName: true,
        providerId: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
    const identityUsers = missingIdentity.filter((user) => !!user.providerId);
    const identityOwners = new Map<string, string>();
    for (const part of this.chunks(identityUsers)) {
      const owned = await this._userIdentity.model.userIdentity.findMany({
        where: {
          providerId: { in: part.map((user) => user.providerId!) },
        },
        select: { userId: true, provider: true, providerId: true },
      });
      for (const row of owned) {
        identityOwners.set(`${row.provider}:${row.providerId}`, row.userId);
      }
    }

    const identities: Prisma.UserIdentityCreateManyInput[] = [];
    for (const user of identityUsers) {
      const login = `${user.providerName}:${user.providerId}`;
      const ownerId = identityOwners.get(login);
      if (ownerId) {
        conflicts.push({ userId: user.id, login, ownerId });
        continue;
      }

      identityOwners.set(login, user.id);
      identities.push({
        userId: user.id,
        provider: user.providerName,
        providerId: user.providerId!,
      });
    }
    for (const part of this.chunks(identities)) {
      await this._userIdentity.model.userIdentity.createMany({
        data: part,
        skipDuplicates: true,
      });
    }

    // local accounts sign in through their address, so they get it before a
    // provider account that happens to share it, which signs in via its identity
    await this.backfillEmails(true, conflicts);
    await this.backfillEmails(false, conflicts);

    return conflicts;
  }

  private async backfillEmails(
    local: boolean,
    conflicts: { userId: string; login: string; ownerId: string }[]
  ) {
    const missingEmail = await this._user.model.user.findMany({
      where: {
        deletedAt: null,
        providerName: local ? Provider.LOCAL : { not: Provider.LOCAL },
        emails: { none: {} },
      },
      select: {
        id: true,
        email: true,
        providerName: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
    // wallet and farcaster accounts keep a pseudo value in User.email
    const users = missingEmail
      .map((user) => ({ ...user, email: user.email.toLowerCase() }))
      .filter((user) => user.email.includes('@'));

    const owners = new Map<string, string>();
    for (const part of this.chunks(users)) {
      const owned = await this._userEmail.model.userEmail.findMany({
        where: {
          email: { in: part.map((user) => user.email) },
        },
        select: { userId: true, email: true },
      });
      for (const row of owned) {
        owners.set(row.email, row.userId);
      }
    }

    const emails: Prisma.UserEmailCreateManyInput[] = [];
    for (const user of users) {
      const ownerId = owners.get(user.email);
      if (ownerId) {
        conflicts.push({ userId: user.id, login: user.email, ownerId });
        continue;
      }

      owners.set(user.email, user.id);
      emails.push({
        userId: user.id,
        email: user.email,
        verifiedAt: this.provenAt(user),
      });
    }
    for (const part of this.chunks(emails)) {
      await this._userEmail.model.userEmail.createMany({
        data: part,
        skipDuplicates: true,
      });
    }
  }

  private chunks<T>(list: T[], size = 500) {
    return Array.from({ length: Math.ceil(list.length / size) }, (_, index) =>
      list.slice(index * size, (index + 1) * size)
    );
  }

  // only an address somebody proved counts as verified: Google and Apple always
  // assert theirs. A local account's activated flag is no proof (instances
  // without an email provider activate everyone), so those stay unverified and
  // keep signing in through the primary rule until they verify from settings.
  private provenAt(user: { providerName: Provider; createdAt: Date }) {
    if (
      user.providerName === Provider.GOOGLE ||
      user.providerName === Provider.APPLE
    ) {
      return user.createdAt;
    }

    return null;
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
