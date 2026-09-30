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
  Res
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../common/roles.decorator';
import { UpstreamService } from './upstream.service';
import { CreateUpstreamDto } from './dto/create-upstream.dto';
import { UpdateUpstreamDto } from './dto/update-upstream.dto';
import { QueryUpstreamDto } from './dto/query-upstream.dto';
import { QueryUpstreamNodeDto } from './dto/query-upstream-node.dto';
import { SetNodeDirectSubDto } from './dto/set-node-direct-sub.dto';
import { ExportUpstreamNodesDto } from './dto/export-upstream-nodes.dto';
import { UpstreamNodeStatus } from '../common/constants';

@ApiTags('Admin Upstream Subscriptions')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/upstream')
export class UpstreamController {
  constructor(private readonly upstreamService: UpstreamService) {}

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
  @ApiOperation({ summary: '导出上游节点为 URI 文本或 JSON' })
  async exportNodes(@Query() query: ExportUpstreamNodesDto, @Res() res: Response) {
    const result = await this.upstreamService.exportNodes(query);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('X-Total-Count', String(result.count));
    res.send(result.body);
  }

  @Post('probe-all')
  @ApiOperation({ summary: '对所有或指定订阅的在线节点执行并发连通性测速' })
  probeAll(@Query('subscriptionId') subscriptionId?: string) {
    return this.upstreamService.probeAll(subscriptionId);
  }

  @Get(':id')
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

  @Put('nodes/:nodeId/direct-sub')
  @ApiOperation({ summary: '切换是否直接合并入用户客户端订阅' })
  setDirectSub(
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() dto: SetNodeDirectSubDto
  ) {
    return this.upstreamService.setNodeDirectSub(nodeId, dto.isDirectSub);
  }

  @Put('nodes/:nodeId/status')
  @ApiOperation({ summary: '启用或禁用指定上游节点' })
  setStatus(
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body('status') status: UpstreamNodeStatus
  ) {
    return this.upstreamService.setNodeStatus(nodeId, status);
  }

  @Post('nodes/:nodeId/probe')
  @ApiOperation({ summary: '单节点连通性握手测速' })
  probeNode(@Param('nodeId', ParseUUIDPipe) nodeId: string) {
    return this.upstreamService.probeNode(nodeId);
  }
}
