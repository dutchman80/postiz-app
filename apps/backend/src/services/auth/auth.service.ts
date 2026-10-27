import { Injectable } from '@nestjs/common';
import { Prisma, Provider, User } from '@prisma/client';
import { CreateOrgUserDto } from '@gitroom/nestjs-libraries/dtos/auth/create.org.user.dto';
import { LoginUserDto } from '@gitroom/nestjs-libraries/dtos/auth/login.user.dto';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { NewUserBody } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { AuthProviderManager } from '@gitroom/backend/services/auth/providers/providers.manager';
import dayjs from 'dayjs';
import { ForgotReturnPasswordDto } from '@gitroom/nestjs-libraries/dtos/auth/forgot-return.password.dto';
import { EmailService } from '@gitroom/nestjs-libraries/services/email.service';
import { NewsletterService } from '@gitroom/nestjs-libraries/newsletter/newsletter.service';

@Injectable()
export class AuthService {
  constructor(
    private _userService: UsersService,
    private _organizationService: OrganizationService,
    private _emailService: EmailService,
    private _providerManager: AuthProviderManager
  ) {}
  async canRegister(provider: string) {
    if (
      process.env.DISABLE_REGISTRATION !== 'true' ||
      provider === Provider.GENERIC
    ) {
      return true;
    }

    return (await this._organizationService.getCount()) === 0;
  }

  async routeAuth(
    provider: Provider,
    body: CreateOrgUserDto | LoginUserDto,
    ip: string,
    userAgent: string,
    addToOrg?: boolean | { orgId: string; role: 'USER' | 'ADMIN'; id: string }
  ) {
    if (provider === Provider.LOCAL) {
      if (process.env.DISALLOW_PLUS && body.email.includes('+')) {
        throw new Error('Email with plus sign is not allowed');
      }
      if (body instanceof CreateOrgUserDto) {
        body.email = body.email.toLowerCase();
      }
      const user = await this._userService.getUserByEmail(body.email);
      if (body instanceof CreateOrgUserDto) {
        if (user) {
          throw new Error('Email already exists');
        }

        if (!(await this.canRegister(provider))) {
          throw new Error('Registration is disabled');
        }

        const { user: created, addedOrg } = await this.createUser(
          { ...body, emailVerified: false },
          await this.getUsableInvite(addToOrg),
          ip,
          userAgent
        );

        const obj = { addedOrg, jwt: await this.jwt(created) };
        await this._emailService.sendEmailSync(
          body.email,
          'Activate your account',
          `Click <a href="${process.env.FRONTEND_URL}/auth/activate/${obj.jwt}">here</a> to activate your account`
        );
        return obj;
      }

      if (
        !user?.password ||
        !AuthChecker.comparePassword(body.password, user.password)
      ) {
        throw new Error('Invalid user name or password');
      }

      if (!user.activated) {
        throw new Error('User is not activated');
      }

      return { addedOrg: false, jwt: await this.jwt(user) };
    }

    const invite = await this.getUsableInvite(addToOrg);
    const { user, addedOrg: registeredOrg } =
      await this.loginOrRegisterProvider(
        provider,
        body as CreateOrgUserDto,
        ip,
        userAgent,
        invite
      );

    const addedOrg =
      registeredOrg ||
      (invite
        ? await this._organizationService.addUserToOrg(
            user.id,
            invite.id,
            invite.orgId,
            invite.role
          )
        : false);
    return { addedOrg, jwt: await this.jwt(user) };
  }

  async getInviteOrganization(cookie?: string) {
    const invite = await this.getUsableInvite(this.getOrgFromCookie(cookie));
    return { name: invite?.name || null };
  }

  private async getUsableInvite(
    addToOrg?: boolean | { orgId: string; role: 'USER' | 'ADMIN'; id: string }
  ) {
    if (!addToOrg || typeof addToOrg === 'boolean') {
      return null;
    }

    const organization = await this._organizationService.getOrgForInvite(
      addToOrg.id,
      addToOrg.orgId
    );

    return organization ? { ...addToOrg, name: organization.name } : null;
  }

  // a login the account already knows, or a provider-verified address that a
  // verified account already owns: the latter attaches the login to that account
  private async findProviderUser(
    provider: Provider,
    providerUser: { id: string; email: string; emailVerified?: boolean }
  ) {
    const user = await this._userService.getUserByProvider(
      providerUser.id,
      provider
    );
    if (user) {
      return user;
    }

    if (!providerUser.email || !providerUser.emailVerified) {
      return null;
    }

    const linked = await this._userService.getUserByVerifiedEmail(
      providerUser.email
    );
    if (!linked) {
      return null;
    }

    try {
      await this._userService.addIdentity(linked.id, provider, providerUser.id);
    } catch (err) {
      // only a parallel sign-in attaching the same login a moment ago is fine
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return (
          (await this._userService.getUserByProvider(
            providerUser.id,
            provider
          )) || linked
        );
      }

      throw err;
    }
    return linked;
  }

  // a usable invite puts the new user straight into the inviting organization,
  // otherwise registration creates the user's own organization named after the company
  private async createUser(
    body: NewUserBody,
    invite: { orgId: string; role: 'USER' | 'ADMIN'; id: string } | null,
    ip: string,
    userAgent: string
  ) {
    if (invite) {
      const create = await this._organizationService.createUserInOrg(
        body,
        invite,
        ip,
        userAgent
      );

      return {
        organizationId: create.organizationId,
        user: create.user,
        addedOrg: create,
      };
    }

    if (!body.company) {
      throw new Error(
        body.invited
          ? 'This invite is no longer valid, refresh the page to sign up without it'
          : 'Company name is required'
      );
    }

    const create = await this._organizationService.createOrgAndUser(
      body,
      ip,
      userAgent
    );

    return {
      organizationId: create.id,
      user: create.users[0].user,
      addedOrg: false as const,
    };
  }

  public getOrgFromCookie(cookie?: string) {
    if (!cookie) {
      return false;
    }

    try {
      const getOrg: any = AuthChecker.verifyJWT(cookie);
      if (
        typeof getOrg.orgId !== 'string' ||
        typeof getOrg.id !== 'string' ||
        !['USER', 'ADMIN'].includes(getOrg.role) ||
        !getOrg.timeLimit ||
        dayjs(getOrg.timeLimit).isBefore(dayjs())
      ) {
        return false;
      }

      return getOrg as {
        email: string;
        role: 'USER' | 'ADMIN';
        orgId: string;
        id: string;
      };
    } catch (err) {
      return false;
    }
  }

  private async loginOrRegisterProvider(
    provider: Provider,
    body: CreateOrgUserDto,
    ip: string,
    userAgent: string,
    invite: { orgId: string; role: 'USER' | 'ADMIN'; id: string } | null
  ) {
    const providerInstance = this._providerManager.getProvider(provider);
    const providerUser = await providerInstance.getUser(body.providerToken);

    if (!providerUser) {
      throw new Error('Invalid provider token');
    }

    const user = await this.findProviderUser(provider, providerUser);
    if (user) {
      return { user, addedOrg: false as const };
    }

    if (!(await this.canRegister(provider))) {
      throw new Error('Registration is disabled');
    }

    const {
      organizationId,
      user: createdUser,
      addedOrg,
    } = await this.createUser(
      {
        company: body.company,
        email: providerUser.email,
        password: '',
        provider,
        providerId: providerUser.id,
        emailVerified: providerUser.emailVerified,
        invited: body.invited,
        datafast_visitor_id: body.datafast_visitor_id,
      },
      invite,
      ip,
      userAgent
    );

    this._track('register', providerUser.email, body.datafast_visitor_id).catch(
      (err) => {}
    );

    await NewsletterService.register(providerUser.email);

    try {
      if (providerInstance?.postRegistration) {
        await providerInstance.postRegistration(
          body.providerToken,
          organizationId
        );
      }
    } catch (err) {
      // Don't fail registration if postRegistration fails
    }

    return { user: createdUser, addedOrg };
  }

  private async _track(
    name: string,
    email: string,
    datafast_visitor_id: string
  ) {
    if (email && datafast_visitor_id && process.env.DATAFAST_API_KEY) {
      try {
        await fetch('https://datafa.st/api/v1/goals', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.DATAFAST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            datafast_visitor_id: datafast_visitor_id,
            name: name,
            metadata: {
              email,
            },
          }),
        });
      } catch (err) {}
    }
  }

  // any address the account can sign in with can reset its password, which is
  // also how an account created through a provider gets a password login
  async forgot(email: string) {
    const user = await this._userService.getUserByEmail(email);
    if (!user) {
      return false;
    }

    const resetValues = AuthChecker.signJWT({
      id: user.id,
      expires: dayjs().add(20, 'minutes').format('YYYY-MM-DD HH:mm:ss'),
    });

    await this._emailService.sendEmailSync(
      email,
      'Reset your password',
      `You have requested to reset your password. <br />Click <a href="${process.env.FRONTEND_URL}/auth/forgot/${resetValues}">here</a> to reset your password<br />The link will expire in 20 minutes`
    );
  }

  forgotReturn(body: ForgotReturnPasswordDto) {
    const user = AuthChecker.verifyJWT(body.token) as {
      id: string;
      expires: string;
    };
    if (typeof user.id !== 'string' || dayjs(user.expires).isBefore(dayjs())) {
      return false;
    }

    return this._userService.updatePassword(user.id, body.password);
  }

  verifyEmail(code: string) {
    return this._userService.verifyEmail(code);
  }

  async activate(code: string, tracking: string) {
    const user = AuthChecker.verifyJWT(code) as {
      id: string;
      activated: boolean;
      email: string;
    };
    if (user.id && !user.activated) {
      const getUserAgain = await this._userService.getUserById(user.id);
      if (!getUserAgain || getUserAgain.activated) {
        return false;
      }
      await this._userService.activateUser(user.id);
      user.activated = true;
      this._track('register', user.email, tracking).catch((err) => {});
      await NewsletterService.register(user.email);
      return this.jwt(user as any);
    }

    return false;
  }

  async resendActivationEmail(email: string) {
    const user = await this._userService.getUserByEmail(email);

    if (!user) {
      throw new Error('User not found');
    }

    if (user.activated) {
      throw new Error('Account is already activated');
    }

    const jwt = await this.jwt(user);

    await this._emailService.sendEmailSync(
      user.email,
      'Activate your account',
      `Click <a href="${process.env.FRONTEND_URL}/auth/activate/${jwt}">here</a> to activate your account`
    );

    return true;
  }

  oauthLink(provider: string, query?: any) {
    const providerInstance = this._providerManager.getProvider(provider);
    return providerInstance.generateLink(query);
  }

  async checkExists(
    provider: string,
    code: string,
    redirectUri?: string,
    state?: string,
    stateCookie?: string
  ) {
    // the mobile app passes redirect_uri and keeps no cookies, the web flow
    // never passes it, so the state nonce is only enforced for the web flow
    if (
      !process.env.NOT_SECURED &&
      !redirectUri &&
      (!state || state !== stateCookie)
    ) {
      throw new Error('Invalid state');
    }

    const providerInstance = this._providerManager.getProvider(provider);
    const token = await providerInstance.getToken(code, redirectUri);
    const user = await providerInstance.getUser(token);
    if (!user) {
      throw new Error('Invalid user');
    }
    const checkExists = await this.findProviderUser(provider as Provider, user);
    if (checkExists) {
      return { jwt: await this.jwt(checkExists) };
    }

    return { token };
  }

  private async jwt(user: User) {
    if (user.password) {
      delete user.password;
    }
    return AuthChecker.signJWT(user);
  }
}
