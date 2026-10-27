import { HttpException, Injectable } from '@nestjs/common';
import {
  NewUserBody,
  NewUserEmail,
  OrganizationRepository,
} from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { AddTeamMemberDto } from '@gitroom/nestjs-libraries/dtos/settings/add.team.member.dto';
import { AdminAddTeamMemberDto } from '@gitroom/nestjs-libraries/dtos/settings/admin.add.team.member.dto';
import { pricing } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/pricing';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import dayjs from 'dayjs';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import {
  Organization,
  Prisma,
  ShortLinkPreference,
  User,
} from '@prisma/client';
import { UsersRepository } from '@gitroom/nestjs-libraries/database/prisma/users/users.repository';
import { AutopostService } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.service';

@Injectable()
export class OrganizationService {
  constructor(
    private _organizationRepository: OrganizationRepository,
    private _notificationsService: NotificationService,
    private _usersRepository: UsersRepository
  ) {}
  // withEmail is false when the address is held by another account, or is
  // pending there and this registration cannot claim it. releaseId is the
  // pending row the registration takes over, it is deleted with the create.
  private async getNewUserEmail(body: NewUserBody): Promise<NewUserEmail> {
    // proof of an address can only come from a provider, never from the request
    const { withEmail, releaseId } = await this._usersRepository.getEmailClaim(
      body.email,
      {
        proven: body.provider !== 'LOCAL' && !!body.emailVerified,
        provider: body.provider,
      }
    );

    // a local account without an email row could never sign in
    if (body.provider === 'LOCAL' && !withEmail) {
      throw new Error('Email already exists');
    }

    return {
      hasEmail: this._notificationsService.hasEmailProvider(),
      withEmail,
      releaseId,
    };
  }

  // the pending row was verified or the address was taken since it was read
  private mapEmailRace(err: unknown) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      (err.code === 'P2025' || err.code === 'P2002')
    ) {
      return new Error('Email already exists');
    }

    return err;
  }

  async createOrgAndUser(body: NewUserBody, ip: string, userAgent: string) {
    try {
      return await this._organizationRepository.createOrgAndUser(
        body,
        await this.getNewUserEmail(body),
        ip,
        userAgent
      );
    } catch (err) {
      throw this.mapEmailRace(err);
    }
  }

  async createUserInOrg(
    body: NewUserBody,
    invite: { id: string; orgId: string; role: 'USER' | 'ADMIN' },
    ip: string,
    userAgent: string
  ) {
    try {
      return await this._organizationRepository.createUserInOrg(
        body,
        invite,
        await this.getNewUserEmail(body),
        ip,
        userAgent
      );
    } catch (err) {
      throw this.mapEmailRace(err);
    }
  }

  getOrgForInvite(id: string, orgId: string) {
    return this._organizationRepository.getOrgForInvite(id, orgId);
  }

  async getCount() {
    return this._organizationRepository.getCount();
  }

  async createMaxUser(id: string, name: string, saasName: string, email: string) {
    return this._organizationRepository.createMaxUser(id, name, saasName, email);
  }

  addUserToOrg(
    userId: string,
    id: string,
    orgId: string,
    role: 'USER' | 'ADMIN'
  ) {
    return this._organizationRepository.addUserToOrg(userId, id, orgId, role);
  }

  getOrgById(id: string) {
    return this._organizationRepository.getOrgById(id);
  }

  getOrgByIdWithSubscription(id: string) {
    return this._organizationRepository.getOrgByIdWithSubscription(id);
  }

  getAccountOverview(orgId: string) {
    return this._organizationRepository.getAccountOverview(orgId);
  }

  getOrgByApiKey(api: string) {
    return this._organizationRepository.getOrgByApiKey(api);
  }

  async canUseSuperAdminApi(orgId: string) {
    const [superAdmin, privilegedOther] = await Promise.all([
      this._organizationRepository.getSuperAdminUser(orgId),
      this._organizationRepository.getPrivilegedNonSuperAdminUser(orgId),
    ]);

    return !!superAdmin && !privilegedOther;
  }

  getUserOrg(id: string) {
    return this._organizationRepository.getUserOrg(id);
  }

  getOrgsByUserId(userId: string) {
    return this._organizationRepository.getOrgsByUserId(userId);
  }

  updateApiKey(orgId: string) {
    return this._organizationRepository.updateApiKey(orgId);
  }

  getTeam(orgId: string) {
    return this._organizationRepository.getTeam(orgId);
  }

  async setStreak(organizationId: string, type: 'start' | 'end') {
    return this._organizationRepository.setStreak(organizationId, type);
  }

  async getLastPublishDate(organizationId: string) {
    return this._organizationRepository.getLastPublishDate(organizationId);
  }

  getOrgByCustomerId(customerId: string) {
    return this._organizationRepository.getOrgByCustomerId(customerId);
  }

  async inviteTeamMember(org: Organization, user: User, body: AddTeamMemberDto) {
    const timeLimit = dayjs().add(2, 'day').format('YYYY-MM-DD HH:mm:ss');
    const id = makeId(5);
    // only the invite fields, the body can carry undeclared properties
    const url =
      process.env.FRONTEND_URL +
      `/?org=${AuthService.signJWT({
        email: body.email,
        role: body.role,
        orgId: org.id,
        timeLimit,
        id,
      })}`;
    if (body.sendEmail) {
      const inviter = user.name
        ? `${user.name} (${user.email})`
        : user.email;
      await this._notificationsService.sendEmail(
        body.email,
        `${user.name || user.email} invited you to join "${org.name}"`,
        `${inviter} has invited you to join the "${org.name}" team.<br /><a href="${url}">Accept the invitation</a> to get started.<br />The link will expire in 2 days.`
      );
    }
    return { url };
  }

  async addTeamMemberByEmail(org: Organization, body: AdminAddTeamMemberDto) {
    const tier =
      // @ts-ignore
      org?.subscription?.subscriptionTier ||
      (!process.env.STRIPE_PUBLISHABLE_KEY ? 'ULTIMATE' : 'FREE');

    if (!pricing[tier].team_members) {
      throw new HttpException(
        'The organization plan does not include team members',
        400
      );
    }

    // a provider account may have no email row, so fall back to User.email
    const found = await this._usersRepository.getUserByEmail(body.email);
    const users = found
      ? [found]
      : await this._organizationRepository.getUsersByEmail(body.email);
    if (!users.length) {
      throw new HttpException('No Postiz account found for this email', 400);
    }

    if (users.length > 1) {
      throw new HttpException(
        'Multiple accounts exist for this email (different login providers)',
        400
      );
    }

    const [user] = users;

    const userOrgs = await this._organizationRepository.getOrgsByUserId(
      user.id
    );
    if (userOrgs.some((current) => current.id === org.id)) {
      throw new HttpException(
        'User is already a member of this organization',
        400
      );
    }

    const added = await this._organizationRepository.addUserToOrg(
      user.id,
      makeId(5),
      org.id,
      body.role as 'USER' | 'ADMIN'
    );

    if (!added) {
      throw new HttpException(
        'Could not add the user to the organization',
        400
      );
    }

    return { added: true };
  }

  async deleteTeamMember(org: Organization, userId: string) {
    const userOrgs = await this._organizationRepository.getOrgsByUserId(userId);
    const findOrgToDelete = userOrgs.find((orgUser) => orgUser.id === org.id);
    if (!findOrgToDelete) {
      throw new Error('User is not part of this organization');
    }

    // @ts-ignore
    const myRole = org.users[0].role;
    const userRole = findOrgToDelete.users[0].role;
    const myLevel = myRole === 'USER' ? 0 : myRole === 'ADMIN' ? 1 : 2;
    const userLevel = userRole === 'USER' ? 0 : userRole === 'ADMIN' ? 1 : 2;

    if (myLevel < userLevel) {
      throw new Error('You do not have permission to delete this user');
    }

    return this._organizationRepository.deleteTeamMember(org.id, userId);
  }

  disableOrEnableNonSuperAdminUsers(orgId: string, disable: boolean) {
    return this._organizationRepository.disableOrEnableNonSuperAdminUsers(
      orgId,
      disable
    );
  }

  getShortlinkPreference(orgId: string) {
    return this._organizationRepository.getShortlinkPreference(orgId);
  }

  updateShortlinkPreference(orgId: string, shortlink: ShortLinkPreference) {
    return this._organizationRepository.updateShortlinkPreference(
      orgId,
      shortlink
    );
  }
}
