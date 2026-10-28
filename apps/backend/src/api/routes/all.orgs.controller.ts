import { Controller, Get, HttpException, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import dayjs from 'dayjs';
import { GetOrgIdsFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';

@ApiTags('User')
@Controller('/user/all')
export class AllOrgsController {
  constructor(
    private _postsService: PostsService,
    private _integrationService: IntegrationService
  ) {}

  private parsePostingTimes(postingTimes: string) {
    try {
      return JSON.parse(postingTimes);
    } catch {
      return [];
    }
  }

  @Get('/posts')
  async getPosts(
    @GetOrgIdsFromRequest() orgIds: string[],
    @Query() query: GetPostsDto
  ) {
    // Aggregate path only; the shared getPosts path is unbounded, see issue #13.
    // 45 days = longest calendar month view (31 days) plus margin.
    if (dayjs(query.endDate).diff(dayjs(query.startDate), 'day', true) > 45) {
      throw new HttpException('Date range too large', 400);
    }
    return this._postsService.getPostsForOrganizationsMinified(orgIds, query);
  }

  @Get('/integrations')
  async getIntegrations(@GetOrgIdsFromRequest() orgIds: string[]) {
    return {
      integrations: (
        await this._integrationService.getIntegrationsForOrganizations(orgIds)
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
