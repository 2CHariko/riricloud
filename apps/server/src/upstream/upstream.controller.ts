import { BadGatewayException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/roles.decorator';
import {
  CreateUpstreamSubscriptionDto,
  MaterializeUpstreamDto,
  PreviewUpstreamDto,
  QueryUpstreamEntriesDto,
  QueryUpstreamSubscriptionDto,
  UpdateUpstreamSubscriptionDto
} from './dto/upstream.dto';
import { BadGatewayLikeError, UpstreamService } from './upstream.service';

/**
 * 上游订阅管理（v0.9.10）。
 *
 * 路由注册顺序很重要：所有静态路径（`entries` / `preview` / `import`）必须排在
 * `:id` 之前，否则会被参数路由吞掉。
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/upstreams')
export class UpstreamController {
  constructor(private readonly upstream: UpstreamService) {}

  @Get()
  @ApiOperation({ summary: '分页列出上游订阅源（只返回 host，不返回完整 URL）' })
  list(@Query() query: QueryUpstreamSubscriptionDto) {
    return this.upstream.list(query);
  }

  @Post()
  @ApiOperation({ summary: '创建上游订阅源（仅落库，不立即抓取）' })
  create(@Body() dto: CreateUpstreamSubscriptionDto) {
    return this.upstream.create(dto);
  }

  @Get('entries')
  @ApiOperation({ summary: '分页列出全部上游条目（含手工导入的单节点条目）' })
  listAllEntries(@Query() query: QueryUpstreamEntriesDto) {
    return this.upstream.listEntries(query);
  }

  @Post('preview')
  @ApiOperation({ summary: '导入预览（不落库）：返回可导入节点与逐条跳过原因' })
  async preview(@Body() dto: PreviewUpstreamDto) {
    try {
      return await this.upstream.preview(dto);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Post('import')
  @ApiOperation({ summary: '把订阅内容落库为上游条目（不创建线路）' })
  async importContent(@Body() dto: PreviewUpstreamDto) {
    try {
      return await this.upstream.importEntries(dto);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Post('entries/materialize')
  @ApiOperation({ summary: '把选中的上游条目生成为用户可连线路（每条生成出口线路 + 入口线路）' })
  materialize(@Body() dto: MaterializeUpstreamDto) {
    return this.upstream.materialize(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '上游订阅详情与条目前 100 条摘要' })
  detail(@Param('id') id: string) {
    return this.upstream.detail(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新上游订阅源名称、地址、周期或开关' })
  update(@Param('id') id: string, @Body() dto: UpdateUpstreamSubscriptionDto) {
    return this.upstream.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除上游订阅源；条目被线路引用时返回 409' })
  remove(@Param('id') id: string) {
    return this.upstream.remove(id);
  }

  @Get(':id/entries')
  @ApiOperation({ summary: '分页列出指定订阅的条目（含是否已物化为线路）' })
  listEntries(@Param('id') id: string, @Query() query: QueryUpstreamEntriesDto) {
    return this.upstream.listEntries({ ...query, subscriptionId: id });
  }

  @Post(':id/sync')
  @ApiOperation({ summary: '立即抓取并对账；上游故障返回 502 且不影响既有线路' })
  async sync(@Param('id') id: string) {
    try {
      return await this.upstream.sync(id, { manual: true });
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /** 抓取/上游故障与参数错误区分：前者是外部依赖问题，语义上属于 502。 */
  private mapError(error: unknown): unknown {
    if (error instanceof BadGatewayLikeError) {
      return new BadGatewayException(error.message);
    }
    return error;
  }
}
