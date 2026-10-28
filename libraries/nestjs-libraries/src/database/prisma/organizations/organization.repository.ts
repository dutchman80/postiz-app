import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  Prisma,
  Role,
  ShortLinkPreference,
  SubscriptionTier,
} from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { chunk } from 'lodash';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { CreateOrgUserDto } from '@gitroom/nestjs-libraries/dtos/auth/create.org.user.dto';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';

export type NewUserBody = Omit<CreateOrgUserDto, 'providerToken'> & {
  providerId?: string;
  emailVerified?: boolean;
};

export type NewUserEmail = {
  hasEmail: boolean;
  withEmail: boolean;
  releaseId?: string;
};

@Injectable()
export class OrganizationRepository {
  constructor(
    private _organization: PrismaRepository<'organization'>,
    private _userOrg: PrismaRepository<'userOrganization'>,
    private _user: PrismaRepository<'user'>,
    private _transaction: PrismaTransaction
  ) {}

  createMaxUser(id: string, name: string, saasName: string, email: string) {
    const userEmail = email
      ? email.split('@').join(`+${saasName}@`)
      : `${saasName}+` + makeId(10) + '@postiz.com';
    const userName = name ? `${name}###${id}` : `Unnamed User###${id}`;
    const data: Prisma.OrganizationCreateInput = {
      ...this.orgData(userName),
      isTrailing: false,
      subscription: {
        create: {
          totalChannels: 1000000,
          subscriptionTier: 'ULTIMATE',
          isLifetime: true,
          period: 'YEARLY',
        },
      },
      users: {
        create: {
          role: Role.SUPERADMIN,
          user: {
            create: {
              activated: true,
              email: userEmail,
              name: userName,
              providerName: 'LOCAL',
              password: AuthService.hashPassword(makeSecureId(500)),
              timezone: 0,
              emails: {
                create: {
                  email: userEmail.toLowerCase(),
                },
              },
            },
          },
        },
      },
    };

    return this._transaction.model.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        select: {
          id: true,
          apiKey: true,
          users: {
            select: {
              userId: true,
            },
          },
        },
        data,
      });
      await this.createPersonalOrg(tx, organization.users[0].userId);

      return { id: organization.id, apiKey: organization.apiKey };
    });
  }

  getOrgByApiKey(api: string) {
    return this._organization.model.organization.findFirst({
      where: {
        apiKey: api,
        deletedAt: null,
      },
      include: {
        subscription: {
          select: {
            subscriptionTier: true,
            totalChannels: true,
            isLifetime: true,
          },
        },
      },
    });
  }

  getCount() {
    return this._organization.model.organization.count();
  }

  getSuperAdminUser(orgId: string) {
    return this._userOrg.model.userOrganization.findFirst({
      where: {
        organizationId: orgId,
        disabled: false,
        user: {
          isSuperAdmin: true,
          deletedAt: null,
        },
      },
    });
  }

  getPrivilegedNonSuperAdminUser(orgId: string) {
    return this._userOrg.model.userOrganization.findFirst({
      where: {
        organizationId: orgId,
        disabled: false,
        role: {
          in: [Role.SUPERADMIN, Role.ADMIN],
        },
        user: {
          isSuperAdmin: false,
          deletedAt: null,
        },
      },
    });
  }

  getUserOrg(id: string) {
    return this._userOrg.model.userOrganization.findFirst({
      where: {
        id,
      },
      select: {
        user: true,
        organization: {
          include: {
            users: {
              select: {
                id: true,
                disabled: true,
                role: true,
                userId: true,
              },
            },
            subscription: {
              select: {
                subscriptionTier: true,
                totalChannels: true,
                isLifetime: true,
              },
            },
          },
        },
      },
    });
  }

  getImpersonateUser(name: string) {
    return this._userOrg.model.userOrganization.findMany({
      where: {
        OR: [
          {
            organizationId: {
              contains: name,
            },
          },
          {
            organization: {
              OR: [
                {
                  paymentId: {
                    equals: name,
                  },
                },
                {
                  subscription: {
                    identifier: {
                      equals: name,
                    },
                  },
                },
                {
                  Integration: {
                    some: {
                      id: name,
                    },
                  },
                },
                {
                  post: {
                    some: {
                      id: name,
                    },
                  },
                },
              ],
            },
          },
          {
            user: {
              OR: [
                {
                  name: {
                    contains: name,
                    mode: 'insensitive',
                  },
                },
                {
                  email: {
                    contains: name,
                    mode: 'insensitive',
                  },
                },
                {
                  id: {
                    contains: name,
                  },
                },
              ],
            },
          },
        ],
      },
      select: {
        id: true,
        role: true,
        disabled: true,
        organization: {
          select: {
            id: true,
            name: true,
            paymentId: true,
            deletedAt: true,
            subscription: {
              select: {
                subscriptionTier: true,
                identifier: true,
                isLifetime: true,
                period: true,
                cancelAt: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            activated: true,
            providerName: true,
            deletedAt: true,
          },
        },
      },
    });
  }

  updateApiKey(orgId: string) {
    return this._organization.model.organization.update({
      where: {
        id: orgId,
      },
      data: {
        apiKey: AuthService.fixedEncryption(makeSecureId(20)),
      },
    });
  }

  async getOrgsByUserId(userId: string) {
    return this._organization.model.organization.findMany({
      orderBy: {
        createdAt: 'asc',
      },
      where: {
        deletedAt: null,
        users: {
          some: {
            userId,
          },
        },
      },
      include: {
        users: {
          where: {
            userId,
          },
          select: {
            disabled: true,
            role: true,
          },
        },
        subscription: {
          select: {
            subscriptionTier: true,
            totalChannels: true,
            isLifetime: true,
            createdAt: true,
          },
        },
      },
    });
  }

  async getOrgById(id: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id,
      },
    });
  }

  getOrgByIdWithSubscription(id: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id,
      },
      include: {
        subscription: {
          select: {
            subscriptionTier: true,
            totalChannels: true,
            isLifetime: true,
            createdAt: true,
          },
        },
      },
    });
  }

  async getAccountOverview(orgId: string) {
    const [organization, members] = await Promise.all([
      this._organization.model.organization.findUnique({
        where: {
          id: orgId,
        },
        select: {
          id: true,
          name: true,
          createdAt: true,
          deletedAt: true,
          allowTrial: true,
          isTrailing: true,
          subscription: {
            select: {
              subscriptionTier: true,
              period: true,
              identifier: true,
              totalChannels: true,
              isLifetime: true,
              cancelAt: true,
              createdAt: true,
              updatedAt: true,
              deletedAt: true,
            },
          },
        },
      }),
      this._userOrg.model.userOrganization.findMany({
        where: {
          organizationId: orgId,
        },
        orderBy: {
          createdAt: 'asc',
        },
        select: {
          role: true,
          disabled: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              email: true,
              activated: true,
              providerName: true,
              lastOnline: true,
              createdAt: true,
            },
          },
        },
      }),
    ]);

    if (!organization) {
      return null;
    }

    const owner = members.find((member) => member.role === Role.SUPERADMIN);
    const lastOnlineMax = members.reduce<Date | null>(
      (latest, member) =>
        !latest || member.user.lastOnline > latest
          ? member.user.lastOnline
          : latest,
      null
    );

    return {
      organization: {
        id: organization.id,
        name: organization.name,
        createdAt: organization.createdAt,
        deletedAt: organization.deletedAt,
        allowTrial: organization.allowTrial,
        isTrailing: organization.isTrailing,
      },
      subscription: organization.subscription || null,
      owner: owner
        ? {
            ...owner.user,
            role: owner.role,
            memberSince: owner.createdAt,
          }
        : null,
      users: {
        total: members.length,
        activated: members.filter((member) => member.user.activated).length,
        disabled: members.filter((member) => member.disabled).length,
        lastOnlineMax,
      },
    };
  }

  getUsersByEmail(email: string) {
    return this._user.model.user.findMany({
      where: {
        email: {
          equals: email,
          mode: 'insensitive',
        },
        deletedAt: null,
      },
    });
  }

  async getOrgForInvite(id: string, orgId: string) {
    const checkIfInviteExists = await this._user.model.user.findFirst({
      where: {
        inviteId: id,
      },
    });

    if (checkIfInviteExists) {
      return null;
    }

    const organization = await this._organization.model.organization.findFirst({
      where: {
        id: orgId,
      },
      select: {
        id: true,
        name: true,
        personalUserId: true,
        subscription: true,
      },
    });

    if (
      !organization ||
      organization.personalUserId ||
      (process.env.STRIPE_PUBLISHABLE_KEY &&
        organization.subscription?.subscriptionTier ===
          SubscriptionTier.STANDARD)
    ) {
      return null;
    }

    return { id: organization.id, name: organization.name };
  }

  async addUserToOrg(
    userId: string,
    id: string,
    orgId: string,
    role: 'USER' | 'ADMIN'
  ) {
    if (!(await this.getOrgForInvite(id, orgId))) {
      return false;
    }

    const create = await this._userOrg.model.userOrganization.create({
      data: {
        role,
        userId,
        organizationId: orgId,
      },
    });

    await this._user.model.user.update({
      where: {
        id: userId,
      },
      data: {
        inviteId: id,
      },
    });

    return create;
  }

  // the sign-in address is only marked verified when it was proven: a local
  // account proves it by activating, a provider account by the provider's word.
  // withEmail is false when another account still signs in with the address or
  // the sign-up cannot claim it, the new account then signs in through its
  // provider only.
  private newUserData(
    body: NewUserBody,
    { hasEmail, withEmail }: NewUserEmail,
    ip: string,
    userAgent: string
  ) {
    const activated = body.provider !== 'LOCAL' || !hasEmail;
    const email = (body.email || '').toLowerCase();

    return {
      activated,
      email: body.email,
      password: body.password ? AuthService.hashPassword(body.password) : '',
      providerName: body.provider,
      providerId: body.providerId || '',
      timezone: 0,
      ip,
      agent: userAgent,
      ...(withEmail && email.includes('@')
        ? {
            emails: {
              create: {
                email,
                // proof of an address can only come from a provider
                verifiedAt:
                  body.provider !== 'LOCAL' && body.emailVerified
                    ? new Date()
                    : null,
              },
            },
          }
        : {}),
      ...(body.providerId
        ? {
            identities: {
              create: {
                provider: body.provider,
                providerId: body.providerId,
              },
            },
          }
        : {}),
    };
  }

  // releaseId is the pending row of the address, deleted together with the
  // create so a failed registration never frees the address. A row verified in
  // the meantime is not deleted, which fails the whole transaction.
  private withRelease<T>(
    releaseId: string | undefined,
    create: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return this._transaction.model.$transaction(async (tx) => {
      if (releaseId) {
        await tx.userEmail.delete({
          where: { id: releaseId, verifiedAt: null },
          select: { id: true },
        });
      }

      return create(tx);
    });
  }

  private orgData(name: string) {
    return {
      name,
      apiKey: AuthService.fixedEncryption(makeSecureId(20)),
    };
  }

  // every user owns exactly one Personal organization, personalUserId is unique
  private personalOrgData(userId: string) {
    return {
      ...this.orgData('Personal'),
      allowTrial: true,
      isTrailing: true,
      personalUserId: userId,
    };
  }

  private createWithOwner(
    client: Pick<Prisma.TransactionClient, 'organization'>,
    data: Omit<Prisma.OrganizationUncheckedCreateInput, 'users'>,
    userId: string
  ) {
    return client.organization.create({
      data: {
        ...data,
        users: {
          create: {
            role: Role.SUPERADMIN,
            userId,
          },
        },
      },
      select: {
        id: true,
      },
    });
  }

  private createPersonalOrg(
    tx: Pick<Prisma.TransactionClient, 'organization'>,
    userId: string
  ) {
    return this.createWithOwner(tx, this.personalOrgData(userId), userId);
  }

  createOrganization(userId: string, name: string) {
    return this.createWithOwner(
      this._organization.model,
      // additional organizations get no trial, the Personal one carries the trial flags
      this.orgData(name),
      userId
    );
  }

  createUserWithPersonalOrg(
    body: NewUserBody,
    newUserEmail: NewUserEmail,
    ip: string,
    userAgent: string
  ) {
    const data = this.newUserData(body, newUserEmail, ip, userAgent);

    return this.withRelease(newUserEmail.releaseId, async (tx) => {
      const user = await tx.user.create({
        data,
      });
      const organization = await this.createPersonalOrg(tx, user.id);

      return { organizationId: organization.id, user };
    });
  }

  async backfillPersonalOrgs() {
    const users = await this._user.model.user.findMany({
      where: {
        deletedAt: null,
        personalOrganization: null,
      },
      select: {
        id: true,
      },
      orderBy: { id: 'asc' },
    });

    let created = 0;
    for (const part of chunk(users, 500)) {
      // the organization never exists without its owner membership
      created += await this._transaction.model.$transaction(async (tx) => {
        const orgs = await tx.organization.createManyAndReturn({
          data: part.map((user) => this.personalOrgData(user.id)),
          skipDuplicates: true,
          select: { id: true, personalUserId: true },
        });
        await tx.userOrganization.createMany({
          data: orgs.map((org) => ({
            organizationId: org.id,
            userId: org.personalUserId!,
            role: Role.SUPERADMIN,
          })),
          skipDuplicates: true,
        });

        return orgs.length;
      });
    }

    return created;
  }

  async createUserInOrg(
    body: NewUserBody,
    invite: { id: string; orgId: string; role: 'USER' | 'ADMIN' },
    newUserEmail: NewUserEmail,
    ip: string,
    userAgent: string
  ) {
    const data = this.newUserData(body, newUserEmail, ip, userAgent);

    return this.withRelease(newUserEmail.releaseId, async (tx) => {
      const created = await tx.userOrganization.create({
        data: {
          role: invite.role,
          organization: {
            connect: {
              id: invite.orgId,
            },
          },
          user: {
            create: {
              ...data,
              inviteId: invite.id,
            },
          },
        },
        select: {
          organizationId: true,
          user: true,
        },
      });
      await this.createPersonalOrg(tx, created.user.id);

      return created;
    });
  }

  getOrgByCustomerId(customerId: string) {
    return this._organization.model.organization.findFirst({
      where: {
        paymentId: customerId,
      },
    });
  }

  async setStreak(organizationId: string, type: 'start' | 'end') {
    try {
      await this._organization.model.organization.update({
        where: {
          id: organizationId,
          ...(type === 'start'
            ? {
                streakSince: null,
              }
            : {}),
        },
        data: {
          ...(type === 'end' ? { streakSince: null } : {}),
          ...(type === 'start' ? { streakSince: new Date() } : {}),
        },
      });
    } catch (err) {}
  }

  async getLastPublishDate(organizationId: string) {
    const org = await this._organization.model.organization.findUnique({
      where: {
        id: organizationId,
      },
      select: {
        post: {
          where: {
            state: 'PUBLISHED',
          },
          orderBy: {
            publishDate: 'desc',
          },
          take: 1,
          select: {
            publishDate: true,
          },
        },
      },
    });

    const publishDate = org?.post?.[0]?.publishDate;
    // Never in the future, the streak workflow sleeps until a day after it
    return publishDate ? Math.min(publishDate.getTime(), Date.now()) : null;
  }

  async getTeam(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id: orgId,
      },
      select: {
        users: {
          select: {
            role: true,
            user: {
              select: {
                email: true,
                id: true,
                sendSuccessEmails: true,
                sendFailureEmails: true,
                sendStreakEmails: true,
              },
            },
          },
        },
      },
    });
  }

  getAllUsersOrgs(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id: orgId,
      },
      select: {
        users: {
          select: {
            user: {
              select: {
                email: true,
                id: true,
                sendSuccessEmails: true,
                sendFailureEmails: true,
              },
            },
          },
        },
      },
    });
  }

  deleteOrganization(orgId: string) {
    return this._organization.model.organization.update({
      where: {
        id: orgId,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async deleteTeamMember(orgId: string, userId: string) {
    return this._userOrg.model.userOrganization.delete({
      where: {
        userId_organizationId: {
          userId,
          organizationId: orgId,
        },
      },
    });
  }

  disableOrEnableNonSuperAdminUsers(orgId: string, disable: boolean) {
    return this._userOrg.model.userOrganization.updateMany({
      where: {
        organizationId: orgId,
        role: {
          not: Role.SUPERADMIN,
        },
      },
      data: {
        disabled: disable,
      },
    });
  }

  getShortlinkPreference(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id: orgId,
      },
      select: {
        shortlink: true,
      },
    });
  }

  updateShortlinkPreference(orgId: string, shortlink: ShortLinkPreference) {
    return this._organization.model.organization.update({
      where: {
        id: orgId,
      },
      data: {
        shortlink,
      },
    });
  }
}
