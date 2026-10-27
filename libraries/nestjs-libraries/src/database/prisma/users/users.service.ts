import { Injectable, Logger } from '@nestjs/common';
import { UsersRepository } from '@gitroom/nestjs-libraries/database/prisma/users/users.repository';
import { Provider, Role } from '@prisma/client';
import { UserDetailDto } from '@gitroom/nestjs-libraries/dtos/users/user.details.dto';
import { EmailNotificationsDto } from '@gitroom/nestjs-libraries/dtos/users/email-notifications.dto';
import { TimezoneDto } from '@gitroom/nestjs-libraries/dtos/users/timezone.dto';
import { OrganizationRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import dayjs from 'dayjs';

@Injectable()
export class UsersService {
  constructor(
    private _usersRepository: UsersRepository,
    private _organizationRepository: OrganizationRepository,
    private _integrationRepository: IntegrationRepository,
    private _notificationService: NotificationService
  ) {}

  private readonly _logger = new Logger(UsersService.name);

  getUserByEmail(email: string) {
    return this._usersRepository.getUserByEmail(email);
  }

  getUserById(id: string) {
    return this._usersRepository.getUserById(id);
  }

  getUserWithActiveSubscriptionByEmail(email: string, excludeUserId: string) {
    return this._usersRepository.getUserWithActiveSubscriptionByEmail(
      email,
      excludeUserId
    );
  }

  getImpersonateUser(name: string) {
    return this._organizationRepository.getImpersonateUser(name);
  }

  getUserByProvider(providerId: string, provider: Provider) {
    return this._usersRepository.getUserByProvider(providerId, provider);
  }

  getUserByVerifiedEmail(email: string) {
    return this._usersRepository.getUserByVerifiedEmail(email);
  }

  addIdentity(userId: string, provider: Provider, providerId: string) {
    return this._usersRepository.addIdentity(userId, provider, providerId);
  }

  getEmails(userId: string) {
    return this._usersRepository.getEmails(userId);
  }

  async addEmail(userId: string, email: string) {
    this.assertEmailSending();

    const added = await this._usersRepository.addEmail(userId, email);
    if (!added) {
      throw new Error('This email address is already in use');
    }

    if (added.row?.verifiedAt) {
      throw new Error('This email address is already on your account');
    }

    await this.sendEmailVerification(userId, added.email);

    return { id: added.row?.id || null };
  }

  async resendEmailVerification(userId: string, id: string) {
    this.assertEmailSending();

    const email = await this._usersRepository.getEmailById(userId, id);
    if (!email) {
      throw new Error('Email address not found');
    }

    if (email.verifiedAt) {
      throw new Error('Email address is already verified');
    }

    await this.sendEmailVerification(userId, email.email);
  }

  async verifyEmail(token: string) {
    try {
      const payload = AuthService.verifyJWT(token) as {
        email: string;
        userId: string;
        expires: string;
      };
      if (
        typeof payload.email !== 'string' ||
        typeof payload.userId !== 'string' ||
        dayjs(payload.expires).isBefore(dayjs())
      ) {
        return false;
      }

      return await this._usersRepository.verifyEmail(
        payload.userId,
        payload.email
      );
    } catch (err) {
      return false;
    }
  }

  async removeEmail(userId: string, id: string) {
    const [primary, email] = await Promise.all([
      this._usersRepository.getPrimaryEmail(userId),
      this._usersRepository.getEmailById(userId, id),
    ]);
    if (!email) {
      throw new Error('Email address not found');
    }

    if (email.email === primary?.email.toLowerCase()) {
      throw new Error('The primary email address cannot be removed');
    }

    await this._usersRepository.removeEmail(userId, id);
  }

  private assertEmailSending() {
    if (!this._notificationService.hasEmailProvider()) {
      throw new Error('Email sending is not configured on this instance');
    }
  }

  private async sendEmailVerification(userId: string, email: string) {
    const token = AuthService.signJWT({
      email,
      userId,
      expires: dayjs().add(2, 'day').format('YYYY-MM-DD HH:mm:ss'),
    });

    await this._notificationService.sendEmail(
      email,
      'Verify your email address',
      `Click <a href="${process.env.FRONTEND_URL}/auth/verify-email/${token}">here</a> to add this email address to your account.<br />The link will expire in 2 days.`
    );
  }

  mergeUsers(targetId: string, sourceIds: string[]) {
    return this._usersRepository.mergeUsers(targetId, sourceIds);
  }

  backfillIdentities(trustedProviders: Provider[]) {
    return this._usersRepository.backfillIdentities(trustedProviders);
  }

  async switchUser(
    currentUserId: string,
    targetUserId: string,
    adminId: string
  ) {
    const { kept, switched } =
      await this._usersRepository.switchUserCredentials(
        currentUserId,
        targetUserId
      );

    this._logger.log(
      `User login switch performed by admin ${adminId}: account ${
        kept.id
      } login ${switched.email} -> ${kept.email}; account ${
        switched.id
      } login ${kept.email} -> ${switched.email}`
    );

    // the swap is already committed; a notification failure must not fail it
    if (this._notificationService.hasEmailProvider()) {
      await Promise.all(
        [kept, switched].map((account) =>
          this._notificationService
            .sendEmail(
              account.email,
              'Your Postiz login was changed',
              `An administrator changed the login for your Postiz account. ` +
                `You can now sign in using ${account.email}. ` +
                `Your subscription and plan were not changed by this switch — ` +
                `if you intended to cancel a subscription, please do that ` +
                `separately from your billing settings.`
            )
            .catch((err) =>
              this._logger.error(`Failed to notify ${account.email}`, err)
            )
        )
      );
    }

    return { kept, switched };
  }

  async getOrgsToDeleteForAccount(userId: string) {
    const orgs = await this._organizationRepository.getOrgsByUserId(userId);
    const ownedOrgs = orgs.filter(
      (org) => org.users[0].role === Role.SUPERADMIN
    );

    const teams = await Promise.all(
      ownedOrgs.map((org) => this._organizationRepository.getTeam(org.id))
    );

    return ownedOrgs.filter(
      (org, index) =>
        !teams[index]?.users?.some(
          (member) =>
            member.user.id !== userId && member.role === Role.SUPERADMIN
        )
    );
  }

  async getDeleteAccountInfo(userId: string) {
    const ownedOrgs = await this.getOrgsToDeleteForAccount(userId);
    const teams = await Promise.all(
      ownedOrgs.map((org) => this._organizationRepository.getTeam(org.id))
    );

    return {
      hasSubscription: ownedOrgs.some((org) => !!org.subscription),
      hasAdditionalMembers: teams.some((team) =>
        team?.users?.some((member) => member.user.id !== userId)
      ),
    };
  }

  async deleteAccount(userId: string) {
    const deletedOrgs = await this.getOrgsToDeleteForAccount(userId);
    const orgs = await this._organizationRepository.getOrgsByUserId(userId);

    for (const org of orgs) {
      if (deletedOrgs.some((deletedOrg) => deletedOrg.id === org.id)) {
        const team = await this._organizationRepository.getTeam(org.id);
        for (const member of team?.users || []) {
          if (member.user.id !== userId) {
            await this._organizationRepository.deleteTeamMember(
              org.id,
              member.user.id
            );
          }
        }

        await this._integrationRepository.deleteIntegrationsForAccount(org.id);
        await this._organizationRepository.deleteOrganization(org.id);
      } else {
        await this._organizationRepository.deleteTeamMember(org.id, userId);
      }
    }

    await this._usersRepository.deleteAccount(userId);

    this._logger.log(
      `Account ${userId} deleted, organizations removed: ${deletedOrgs
        .map((org) => org.id)
        .join(', ')}`
    );

    return { deletedOrgs };
  }

  activateUser(id: string) {
    return this._usersRepository.activateUser(id);
  }

  updatePassword(id: string, password: string) {
    return this._usersRepository.updatePassword(id, password);
  }

  getPersonal(userId: string) {
    return this._usersRepository.getPersonal(userId);
  }

  changePersonal(userId: string, body: UserDetailDto) {
    return this._usersRepository.changePersonal(userId, body);
  }

  getEmailNotifications(userId: string) {
    return this._usersRepository.getEmailNotifications(userId);
  }

  updateEmailNotifications(userId: string, body: EmailNotificationsDto) {
    return this._usersRepository.updateEmailNotifications(userId, body);
  }

  updateTimezone(userId: string, body: TimezoneDto) {
    return this._usersRepository.updateTimezone(userId, body);
  }
}
