import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { getRequestBaseUrl } from '../common/public-url';
import { QueryBinaryDeploymentDto } from '../binaries/dto/query-binary-resource.dto';
import { CreateNodeDto } from './dto/create-node.dto';
import { UpdateNodeDto } from './dto/update-node.dto';
import { ProbeNodeDto } from './dto/probe-node.dto';
import { BatchUpgradeNodeDto } from './dto/batch-upgrade-node.dto';
import { UpgradeNodeDto } from './dto/upgrade-node.dto';
import { LogDiagnosticsDto } from './dto/log-diagnostics.dto';
import { NodesService } from './nodes.service';

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/nodes')
export class NodesController {
  constructor(private readonly nodesService: NodesService) {}

  @Get()
  list() {
    return this.nodesService.list();
  }

  // 注意：/:id 之前注册，避免 reality-keypair 被当作节点 id
  @Post('reality-keypair')
  @Header('Cache-Control', 'no-store')
  generateRealityKeypair() {
    return this.nodesService.realityKeypair();
  }

  @Get(':id/offline-package')
  async downloadOfflinePackage(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('platform') platform: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.nodesService.generateOfflinePackage(id, platform, getRequestBaseUrl(request));
    response.setHeader('Content-Type', result.mimeType);
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(result.stream);
  }

  @Get(':id/install-script')
  async downloadInstallScript(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('platform') platform: string | undefined,
    @Query('format') format: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.nodesService.generateInstallScript(id, platform, format, getRequestBaseUrl(request));
    response.setHeader('Content-Type', result.mimeType);
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
    response.setHeader('Cache-Control', 'no-store');
    return result.content;
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.nodesService.detail(id, getRequestBaseUrl(request));
  }

  @Post()
  create(@Body() dto: CreateNodeDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    return this.nodesService.create(dto, user.id, getRequestBaseUrl(request));
  }


  @Post(':id/log-diagnostics')
  enableLogDiagnostics(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LogDiagnosticsDto,
    @CurrentUser() user: { id: string }
  ) {
    return this.nodesService.enableLogDiagnostics(id, dto.level, user.id);
  }

  @Delete(':id/log-diagnostics')
  disableLogDiagnostics(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }) {
    return this.nodesService.disableLogDiagnostics(id, user.id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateNodeDto) {
    return this.nodesService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.nodesService.remove(id);
  }

  @Post(':id/diagnostics-snapshot')
  diagnosticsSnapshot(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }) {
    return this.nodesService.requestDiagnosticsSnapshot(id, user.id);
  }

  @Post(':id/reload')
  reload(@Param('id') id: string) {
    return this.nodesService.requestReload(id);
  }

  @Post(':id/rotate-token')
  rotateToken(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    return this.nodesService.rotateToken(id, user.id, getRequestBaseUrl(request));
  }

  @Post(':id/upgrade')
  upgrade(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpgradeNodeDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    return this.nodesService.requestUpgrade(id, dto, getRequestBaseUrl(request), user.id);

  }
  @Post('batch-upgrade')
  batchUpgrade(@Body() dto: BatchUpgradeNodeDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    return this.nodesService.requestBatchUpgrade(dto, getRequestBaseUrl(request), user.id);
  }

  @Post(':id/probe')
  probe(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProbeNodeDto) {
    return this.nodesService.requestProbe(id, dto);
  }

  @Post(':id/restart-agent')
  restartAgent(@Param('id', ParseUUIDPipe) id: string) {
    return this.nodesService.requestRestart(id);
  }

  @Get(':id/tasks')
  listTasks(@Param('id', ParseUUIDPipe) id: string, @Query() query: QueryBinaryDeploymentDto) {
    return this.nodesService.listTasks(id, query);
  }

  @Get(':id/tasks/:taskId')
  taskStatus(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.nodesService.taskStatus(id, taskId);
  }

  @Post(':id/tasks/:taskId/retry')
  retryTask(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @CurrentUser() user: { id: string }) {
    return this.nodesService.retryUpgrade(id, taskId, user.id);
  }

  @Post(':id/tasks/:taskId/rollback')
  rollbackTask(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    return this.nodesService.rollbackUpgrade(id, taskId, getRequestBaseUrl(request), user.id);
  }

}
