import { Controller, Get, HttpException, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { Request } from 'express';
import dayjs from 'dayjs';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';

@ApiTags('User')
@Controller('/user/all')
export class AllOrgsController {
  constructor(
    private _organizationService: OrganizationService,
    private _postsService: PostsService,
    private _integrationService: IntegrationService
  ) {}

  private orgIds(user: User, org: Organization, req: Request) {
    const impersonate = req.cookies.impersonate || req.headers.impersonate;
    return impersonate
      ? [org.id]
      : this._organizationService.getActiveOrgIdsByUserId(user.id);
  }

  private parsePostingTimes(postingTimes: string) {
    try {
      return JSON.parse(postingTimes);
    } catch {
      return [];
    }
  }

  @Get('/posts')
  async getPosts(
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request,
    @Query() query: GetPostsDto
  ) {
    // Aggregate path only; the shared getPosts path is unbounded, see issue #13.
    // 45 days = longest calendar month view (31 days) plus margin.
    if (dayjs(query.endDate).diff(dayjs(query.startDate), 'day', true) > 45) {
      throw new HttpException('Date range too large', 400);
    }
    return this._postsService.getPostsForOrganizationsMinified(
      await this.orgIds(user, org, req),
      query
    );
  }

  @Get('/integrations')
  async getIntegrations(
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request
  ) {
    return {
      integrations: (
        await this._integrationService.getIntegrationsForOrganizations(
          await this.orgIds(user, org, req)
        )
      ).map((p) => ({
        id: p.id,
        name: p.customName || p.name,
        originalName: p.name,
        picture: p.picture || '/no-picture.jpg',
        identifier: p.providerIdentifier,
        type: p.type,
        disabled: p.disabled,
        inBetweenSteps: p.inBetweenSteps,
        refreshNeeded: p.refreshNeeded,
        display: p.profile,
        time: this.parsePostingTimes(p.postingTimes),
        organization: {
          id: p.organization.id,
          name: p.organization.name,
          isPersonal: !!p.organization.personalUserId,
        },
      })),
    };
  }
}
