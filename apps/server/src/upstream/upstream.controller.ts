import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  Res,
  Header,
  HttpCode
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../common/roles.decorator';
import { UpstreamService } from './upstream.service';
import { CreateUpstreamDto } from './dto/create-upstream.dto';
import { UpdateUpstreamDto } from './dto/update-upstream.dto';
import { QueryUpstreamDto } from './dto/query-upstream.dto';
import { QueryUpstreamNodeDto } from './dto/query-upstream-node.dto';
import { SetNodeStatusDto } from './dto/set-node-status.dto';
import { ExportUpstreamNodesDto } from './dto/export-upstream-nodes.dto';
import { ProbeUpstreamDto } from './dto/probe-upstream.dto';
import { ProbeTaskService } from '../probe/probe-task.service';
import { StartProbeDto } from '../probe/probe-task.dto';
import { CurrentUser } from '../auth/current-user.decorator';

@ApiTags('Admin Upstream Subscriptions')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/upstream')
export class UpstreamController {
  constructor(private readonly upstreamService: UpstreamService, private readonly tasks: ProbeTaskService) {}

  @Get()
  @ApiOperation({ summary: '分页查询上游订阅列表' })
  list(@Query() query: QueryUpstreamDto) {
    return this.upstreamService.list(query);
  }

  @Get('nodes')
  @ApiOperation({ summary: '查询上游节点列表' })
  listNodes(@Query() query: QueryUpstreamNodeDto) {
    return this.upstreamService.listNodes(query);
  }

  @Get('nodes/export')
  @ApiOperation({ summary: '导出上游连接为 URI、Sing-box JSON 或 Clash YAML' })
  @Header('Cache-Control', 'no-store')
  async exportNodes(@Query() query: ExportUpstreamNodesDto, @Res() res: Response) {
    const result = await this.upstreamService.exportNodes(query);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('X-Total-Count', String(result.count));
    res.send(result.body);
  }

  @Post('probe-all')
  @HttpCode(202)
  @ApiOperation({ summary: '创建上游节点端到端探针任务' })
  probeAll(@Query() query: ProbeUpstreamDto, @Body() dto: StartProbeDto, @CurrentUser() user: { id: string }) {
    return this.tasks.start(user.id, 'UPSTREAM_NODE', { subscriptionId: query.subscriptionId }, dto.policy);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '获取上游订阅详情' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.upstreamService.detail(id);
  }

  @Post()
  @ApiOperation({ summary: '创建上游订阅' })
  create(@Body() dto: CreateUpstreamDto) {
    return this.upstreamService.create(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: '修改上游订阅' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUpstreamDto) {
    return this.upstreamService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除上游订阅' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.upstreamService.remove(id);
  }

  @Post(':id/sync')
  @ApiOperation({ summary: '立即同步上游订阅' })
  sync(@Param('id', ParseUUIDPipe) id: string) {
    return this.upstreamService.sync(id);
  }

  @Get(':id/sync-status')
  @ApiOperation({ summary: '查询上游同步阶段和最后成功时间' })
  syncStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.upstreamService.syncStatus(id);
  }

  @Put('nodes/:nodeId/status')
  @ApiOperation({ summary: '启用或禁用指定上游节点' })
  setStatus(
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() dto: SetNodeStatusDto
  ) {
    return this.upstreamService.setNodeStatus(nodeId, dto.status);
  }

  @Post('nodes/:nodeId/probe')
  @HttpCode(202)
  @ApiOperation({ summary: '创建单节点端到端探针任务' })
  probeNode(@Param('nodeId', ParseUUIDPipe) nodeId: string, @Body() dto: StartProbeDto, @CurrentUser() user: { id: string }) {
    return this.tasks.start(user.id, 'UPSTREAM_NODE', { id: nodeId }, dto.policy);
  }
}
