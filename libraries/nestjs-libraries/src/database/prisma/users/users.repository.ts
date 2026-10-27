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
    // current user on a throwaway email first, then fill each freed slot
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

  private canSignInWith(row: {
    email: string;
    verifiedAt: Date | null;
    user: { email: string };
  }) {
    return !!row.verifiedAt || row.user.email.toLowerCase() === row.email;
  }

  // an unverified address may be taken over by whoever proves it first, unless
  // the account holding it signs in with it
  async claimEmail(email: string) {
    if (!email) {
      return false;
    }

    const existing = await this._userEmail.model.userEmail.findUnique({
      where: {
        email: email.toLowerCase(),
      },
      select: {
        id: true,
        email: true,
        verifiedAt: true,
        user: {
          select: {
            email: true,
          },
        },
      },
    });

    if (!existing) {
      return true;
    }

    if (this.canSignInWith(existing)) {
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

  async addEmail(userId: string, email: string) {
    const existing = await this._userEmail.model.userEmail.findUnique({
      where: {
        email,
      },
      select: {
        id: true,
        userId: true,
        email: true,
        verifiedAt: true,
      },
    });

    if (existing?.userId === userId) {
      return existing;
    }

    if (!(await this.claimEmail(email))) {
      return null;
    }

    return this._userEmail.model.userEmail.create({
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
  }

  verifyEmail(userId: string, id: string) {
    return this._userEmail.model.userEmail.updateMany({
      where: {
        id,
        userId,
        verifiedAt: null,
      },
      data: {
        verifiedAt: new Date(),
      },
    });
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

      await this._transaction.model.$transaction([
        this._userEmail.model.userEmail.updateMany({
          where: { userId: source.id },
          data: { userId: targetId },
        }),
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
  async backfillIdentities(trustLocal: boolean) {
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
    });
    for (const user of missingIdentity) {
      if (!user.providerId) {
        continue;
      }

      const owner = await this._userIdentity.model.userIdentity.findUnique({
        where: {
          provider_providerId: {
            provider: user.providerName,
            providerId: user.providerId,
          },
        },
        select: { userId: true },
      });
      if (owner) {
        conflicts.push({
          userId: user.id,
          login: `${user.providerName}:${user.providerId}`,
          ownerId: owner.userId,
        });
        continue;
      }

      await this.addIdentity(user.id, user.providerName, user.providerId);
    }

    const missingEmail = await this._user.model.user.findMany({
      where: {
        deletedAt: null,
        emails: { none: {} },
      },
      select: {
        id: true,
        email: true,
        providerName: true,
        activated: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
    for (const user of missingEmail) {
      const email = user.email.toLowerCase();
      if (!email || email.startsWith('deleted_')) {
        continue;
      }

      const owner = await this._userEmail.model.userEmail.findUnique({
        where: { email },
        select: { userId: true },
      });
      if (owner) {
        conflicts.push({
          userId: user.id,
          login: email,
          ownerId: owner.userId,
        });
        continue;
      }

      await this._userEmail.model.userEmail.create({
        data: {
          userId: user.id,
          email,
          verifiedAt: this.provenAt(user, trustLocal),
        },
        select: { id: true },
      });
    }

    return conflicts;
  }

  // only an address somebody proved counts as verified: Google and Apple always
  // assert theirs, a local account proved it by activating through an email
  // (if the instance sends emails at all), nothing else is trusted
  private provenAt(
    user: { providerName: Provider; activated: boolean; createdAt: Date },
    trustLocal: boolean
  ) {
    if (
      user.providerName === Provider.GOOGLE ||
      user.providerName === Provider.APPLE
    ) {
      return user.createdAt;
    }

    if (user.providerName === Provider.LOCAL && user.activated && trustLocal) {
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
