import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res, UnauthorizedException, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { OptionalAuth } from '../auth/optional-auth.decorator';
import { Public } from '../auth/public.decorator';
import { CreateProxyKeyDto } from './dto/create-proxy-key.dto';
import { QueryProxyPoolExportDto } from './dto/query-proxy-pool-export.dto';
import { UpdateProxyKeyDto } from './dto/update-proxy-key.dto';
import { ProxyPoolService } from './proxy-pool.service';
import { QueryProxyPoolNodesDto } from './dto/query-proxy-pool-nodes.dto';
import { ProxyPoolNoStoreInterceptor } from './proxy-pool-no-store.interceptor';

// 直连代理池用户端：凭据管理、节点检索与多格式导出（契约见 docs/API_AND_PROTOCOLS.md §5）
@ApiTags('user')
@ApiBearerAuth()
@Controller('user/proxy-pool')
@UseInterceptors(ProxyPoolNoStoreInterceptor)
export class UserProxyPoolController {
  constructor(private readonly proxyPoolService: ProxyPoolService) {}

  @Get('keys')
  @ApiOperation({ summary: '列出当前账号的全部直连代理凭据' })
  listKeys(@CurrentUser() user: { id: string }) {
    return this.proxyPoolService.listKeys(user.id);
  }

  @Post('keys')
  @ApiOperation({ summary: '创建直连代理凭据（返回一次性可见的高熵用户名与密码）' })
  createKey(@CurrentUser() user: { id: string }, @Body() dto: CreateProxyKeyDto) {
    return this.proxyPoolService.createKey(user.id, dto);
  }

  @Patch('keys/:id')
  @ApiOperation({ summary: '更新凭据名称、来源 IP 白名单或启停状态' })
  updateKey(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProxyKeyDto
  ) {
    return this.proxyPoolService.updateKey(user.id, id, dto);
  }

  @Delete('keys/:id')
  @ApiOperation({ summary: '删除直连代理凭据（节点配置即时吊销）' })
  deleteKey(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.proxyPoolService.deleteKey(user.id, id);
  }

  @Post('keys/:id/rotate-password')
  @ApiOperation({ summary: '轮换凭据密码（旧密码立即失效）' })
  rotatePassword(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.proxyPoolService.rotatePassword(user.id, id);
  }

  @Post('keys/:id/rotate-token')
  @ApiOperation({ summary: '轮换免登录拉取令牌' })
  rotateToken(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.proxyPoolService.rotateExportToken(user.id, id);
  }

  @Get('nodes')
  @ApiOperation({ summary: '列出可用于直连代理池的 Mixed 节点端点' })
  listEndpoints(@CurrentUser() user: { id: string }, @Query() query: QueryProxyPoolNodesDto) {
    return this.proxyPoolService.listEndpoints(user.id, query);
  }

  // 免登录动态拉取：登录态 Cookie 或 ?token=<exportToken> 二选一（第三方爬虫框架定时同步）
  @Get('export')
  @Public()
  @OptionalAuth()
  @ApiOperation({ summary: '导出代理池列表（text / uri / json，支持免登录令牌拉取）' })
  async export(
    @CurrentUser() user: { id: string } | undefined,
    @Query() query: QueryProxyPoolExportDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const result = query.token
      ? await this.proxyPoolService.exportForToken(query.token, query)
      : user?.id
        ? await this.proxyPoolService.exportForUser(user.id, query)
        : null;
    if (!result) {
      throw new UnauthorizedException('缺少登录态或免登录拉取令牌');
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Proxy-Pool-Excluded-Count', result.excludedCount ?? 0);
    return result.body;
  }
}
