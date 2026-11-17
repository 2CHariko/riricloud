import { Body, Controller, Delete, Get, Headers, NotFoundException, Optional, Param, Patch, Post, Query, Req, Res, StreamableFile, UnauthorizedException, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ImportBinaryDto } from './dto/import-binary.dto';
import { BinariesService } from './binaries.service';
import { BinariesInstallerService } from './installer.service';
import { BinaryResourcesService } from './binary-resources.service';
import { OfflinePackageService } from './offline-package.service';
import { BinaryResourceGithubImportDto, BinaryResourceImportDto, BinaryResourceUploadDto, TestGithubMirrorsDto } from './dto/binary-resource.dto';
import { BatchBinaryResourceDto } from './dto/batch-binary-resource.dto';
import { appendPublicPath, getRequestBaseUrl, resolvePublicBaseUrl, toWebSocketBaseUrl } from '../common/public-url';
import { decryptSecret } from '../common/secret-crypto';
import { SettingsService } from '../system/settings.service';
import { QueryBinaryDeploymentDto, QueryBinaryResourceDto } from './dto/query-binary-resource.dto';
import { UpdateBinaryResourceDto } from './dto/update-binary-resource.dto';

@ApiTags('binaries')
@Controller()
export class BinariesController {
  constructor(
    private readonly binaries: BinariesService,
    private readonly installer?: BinariesInstallerService,
    private readonly resources?: BinaryResourcesService,
    private readonly offlinePackage?: OfflinePackageService,
    @Optional() private readonly settingsService?: SettingsService
  ) {}

  // 节点离线安装包下载：支持 X-Agent-Token 鉴权，根据 UA 或 query 参数 platform 组装流式包
  @Public()
  @Get('downloads/agent-offline-package')
  async downloadOfflinePackage(
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('x-agent-token') headerToken: string | undefined,
    @Query('platform') platformQuery: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const node = await this.binaries.findNodeByToken(headerToken);
    if (!this.offlinePackage) throw new NotFoundException('离线安装包服务未启用');
    const platform = platformQuery || (userAgent ? this.binaries.resolveAgentTarget(userAgent).replace(/^agent-/, '') : 'linux-amd64');
    const decryptedToken = decryptSecret(node.agentToken);
    const result = await this.offlinePackage.generateOfflinePackageStream(
      {
        id: node.id,
        name: node.name,
        agentToken: decryptedToken,
        communicationMode: node.communicationMode,
        pollIntervalSecs: node.pollIntervalSecs,
        reachability: node.reachability,
        serverHost: node.serverHost,
        osArch: node.osArch
      },
      platform,
      getRequestBaseUrl(request)
    );
    response.setHeader('Content-Type', result.mimeType);
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(result.stream);
  }

  // 节点安装脚本：按下载 UA 或 platform/format 渲染（POSIX sh / PowerShell / Windows BAT），内嵌镜像测速与预编排凭据
  @Public()
  @Get('downloads/agent-installer')
  async agentInstaller(
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('x-agent-token') headerToken: string | undefined,
    @Query('token') queryToken: string | undefined,
    @Query('mode') modeQuery: string | undefined,
    @Query('format') formatQuery: string | undefined,
    @Query('platform') platformQuery: string | undefined,
    @Query('download') downloadQuery: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    if (queryToken !== undefined) throw new UnauthorizedException('AgentToken 仅允许通过 X-Agent-Token Header 传递');
    const node = await this.binaries.findNodeByToken(headerToken);
    const target = platformQuery ? `agent-${platformQuery}` : this.binaries.resolveAgentTarget(userAgent);
    const platform = target.replace(/^agent-/, '');
    const requestBaseUrl = getRequestBaseUrl(request);
    const settings = await this.settingsService?.getSettings();
    const publicBaseUrl = resolvePublicBaseUrl({
      configuredBaseUrl: settings?.publicBaseUrl,
      requestBaseUrl
    });

    const mode: 'ws' | 'http' = (modeQuery?.toLowerCase() === 'http' || (!modeQuery && node.communicationMode === 'HTTP')) ? 'http' : 'ws';
    const masterUrl = mode === 'http'
      ? publicBaseUrl
      : appendPublicPath(toWebSocketBaseUrl(publicBaseUrl), 'ws/agent');

    const preset = {
      agentToken: headerToken,
      masterUrl,
      mode
    };

    const isWindows = target.startsWith('agent-windows') || platform.startsWith('windows');
    const format = formatQuery?.toLowerCase() || (isWindows && downloadQuery === '1' ? 'bat' : undefined);

    let script: string;
    let contentType: string;
    let filename: string;

    if (format === 'bat' || (isWindows && format !== 'ps1' && formatQuery === 'bat')) {
      script = await this.installer!.renderWindowsInstallBat(platform, publicBaseUrl, preset);
      contentType = 'text/plain; charset=utf-8';
      filename = 'riri-install.bat';
    } else if (isWindows || format === 'ps1') {
      // UTF-8 BOM：Windows PowerShell 5.1 对无 BOM 脚本按 ANSI 读取，中文注释会破坏解析
      script = '﻿' + await this.installer!.renderPowershellScript(platform, publicBaseUrl, preset);
      contentType = 'text/plain; charset=utf-8';
      filename = 'riri-install.ps1';
    } else {
      script = await this.installer!.renderShellScript(platform, publicBaseUrl, preset);
      contentType = 'text/x-shellscript; charset=utf-8';
      filename = 'riri-install.sh';
    }

    if (downloadQuery === '1') {
      response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    }
    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    return script;
  }

  @Public()
  @Get('downloads/agent')
  async downloadAgent(
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('x-agent-token') headerToken: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    await this.binaries.authorizeDownload(headerToken);
    const target = this.binaries.resolveAgentTarget(userAgent);
    const asset = this.binaries.getAsset(target);
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', asset.size);
    response.setHeader('Content-Disposition', `attachment; filename="${asset.filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    return new StreamableFile(createReadStream(asset.path));
  }

  @Public()
  @Get('downloads/binaries/:target')
  async download(
    @Param('target') target: string,
    @Headers('x-agent-token') headerToken: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    await this.binaries.authorizeDownload(headerToken);
    const asset = this.binaries.getAsset(target);
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', asset.size);
    response.setHeader('Content-Disposition', `attachment; filename="${asset.filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    return new StreamableFile(createReadStream(asset.path));
  }

  @Public()
  @Get('downloads/binary-assets/:id')
  async downloadManagedAsset(
    @Param('id') id: string,
    @Headers('x-agent-token') headerToken: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    await this.binaries.authorizeDownload(headerToken);
    const managed = await this.resources!.getDownloadAsset(id);
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', managed.file?.size ?? managed.asset.size);
    response.setHeader('Content-Disposition', `attachment; filename="${managed.file?.name ?? managed.asset.filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    return new StreamableFile(createReadStream(managed.path));
  }

  @Public()
  @Get('downloads/binary-files/:id')
  async downloadManagedFile(
    @Param('id') id: string,
    @Headers('x-agent-token') headerToken: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    await this.binaries.authorizeDownload(headerToken);
    const managed = await this.resources!.getDownloadFile(id);
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', managed.file.size);
    response.setHeader('Content-Disposition', `attachment; filename="${managed.file.name}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    return new StreamableFile(createReadStream(managed.path));
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Get('admin/binaries/info')
  info() {
    return this.binaries.getInfo();
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('admin/binaries/import')
  import(@Body() dto: ImportBinaryDto) {
    return this.binaries.importRemote(dto);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Get('admin/binary-resources')
  listResources(@Query() query: QueryBinaryResourceDto) {
    return this.resources!.list(query);
  }

  // 注意：github-releases、github-import、github-mirrors/test 是固定路径，必须在 :id 动态路由之前注册
  @ApiBearerAuth()
  @Roles('ADMIN')
  @Get('admin/binary-resources/github-releases')
  listGithubReleases() {
    return this.resources!.listGithubReleases();
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('admin/binary-resources/github-mirrors/test')
  testGithubMirrors(@Body() dto: TestGithubMirrorsDto) {
    return this.resources!.testGithubMirrors(dto);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('admin/binary-resources/github-import')
  importGithubRelease(
    @Body() dto: BinaryResourceGithubImportDto,
    @CurrentUser() user: { id: string },
    @Req() request?: Request
  ) {
    return this.resources!.importFromGithubRelease(dto, user.id, this.createRequestAbortSignal(request));
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('admin/binary-resources/batch')
  batchResources(@Body() dto: BatchBinaryResourceDto, @CurrentUser() user: { id: string }) {
    return this.resources!.batch(dto, user.id);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Get('admin/binary-resources/:id/deployments')
  resourceDeployments(@Param('id') id: string, @Query() query: QueryBinaryDeploymentDto) {
    return this.resources!.deployments(id, query);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Get('admin/binary-resources/:id')
  resourceDetail(@Param('id') id: string) {
    return this.resources!.detail(id);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Patch('admin/binary-resources/:id')
  updateResource(@Param('id') id: string, @Body() dto: UpdateBinaryResourceDto, @CurrentUser() user: { id: string }) {
    return this.resources!.update(id, dto, user.id);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Delete('admin/binary-resources/:id')
  removeResource(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.resources!.remove(id, user.id);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('admin/binary-resources/import')
  importResource(
    @Body() dto: BinaryResourceImportDto,
    @CurrentUser() user: { id: string },
    @Req() request?: Request
  ) {
    return this.resources!.importRemote(dto, user.id, this.createRequestAbortSignal(request));
  }

  private createRequestAbortSignal(request?: Request): AbortSignal | undefined {
    if (!request) return undefined;
    const controller = new AbortController();
    request.once?.('aborted', () => controller.abort(new Error('客户端已取消请求')));
    request.res?.once?.('close', () => {
      if (!request.res?.writableEnded) {
        controller.abort(new Error('客户端连接已关闭，取消远程下载'));
      }
    });
    return controller.signal;
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('admin/binary-resources/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  uploadResource(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
    @Body() dto: BinaryResourceUploadDto,
    @CurrentUser() user: { id: string }
  ) {
    if (!file?.buffer) throw new Error('binary file is required');
    return this.resources!.upload(dto, file, user.id);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('admin/binary-resources/:id/activate')
  activateResource(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.resources!.activate(id, user.id);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('admin/binary-resources/:id/disable')
  disableResource(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.resources!.disable(id, user.id);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('admin/binary-resources/:id/retire')
  retireResource(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.resources!.retire(id, user.id);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('admin/binary-resources/:id/restore')
  restoreResource(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.resources!.restore(id, user.id);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post('admin/binary-resources/:id/default')
  setDefaultResource(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.resources!.setDefault(id, user.id);
  }
}
