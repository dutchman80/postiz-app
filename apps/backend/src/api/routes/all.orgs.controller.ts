import { Controller, Get, HttpException, Query } from '@nestjs/common';
import { HttpForbiddenException } from '@gitroom/nestjs-libraries/services/exception.filter';
import { ApiTags } from '@nestjs/swagger';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { GetOrgIdsFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';

dayjs.extend(utc);

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

  private assertOrgScope(orgIds: string[]) {
    // Prisma treats `{ in: undefined }` as no filter, so fail closed.
    if (!Array.isArray(orgIds) || orgIds.length === 0) {
      throw new HttpForbiddenException();
    }
  }

  private parseDate(value: string) {
    const day = value.slice(0, 10);
    const date = dayjs.utc(value);
    const calendarDay = dayjs.utc(day);
    return date.isValid() &&
      calendarDay.isValid() &&
      calendarDay.format('YYYY-MM-DD') === day
      ? date
      : null;
  }

  @Get('/posts')
  async getPosts(
    @GetOrgIdsFromRequest() orgIds: string[],
    @Query() query: GetPostsDto
  ) {
    this.assertOrgScope(orgIds);
    // Aggregate path only; the shared getPosts path is unbounded, see issue #13.
    // 45 days = longest calendar month view (31 days) plus margin.
    // Parse each input once. dayjs rolls impossible dates over (2026-02-30
    // becomes 2026-03-02), so the calendar part is validated on its own,
    // independent of the UTC instant (an offset can move that to another day).
    const start = this.parseDate(query.startDate);
    const end = this.parseDate(query.endDate);
    if (!start || !end) {
      throw new HttpException('Invalid date range', 400);
    }
    if (
      end.isBefore(start) ||
      end.diff(start, 'day', true) > 45 ||
      // Safety bound for the aggregate route while issue #13 tracks the
      // recurring-post expansion.
      end.isAfter(dayjs().add(2, 'year'))
    ) {
      throw new HttpException('Invalid date range', 400);
    }
    return this._postsService.getPostsForOrganizationsMinified(orgIds, query);
  }

  @Get('/integrations')
  async getIntegrations(@GetOrgIdsFromRequest() orgIds: string[]) {
    this.assertOrgScope(orgIds);
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
