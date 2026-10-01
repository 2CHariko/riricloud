import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/roles.decorator';
import { QueryAdminProxyKeysDto } from './dto/query-admin-proxy-keys.dto';
import { SetProxyKeyActiveDto } from './dto/set-proxy-key-active.dto';
import { ProxyPoolService } from './proxy-pool.service';
import { ProxyPoolNoStoreInterceptor } from './proxy-pool-no-store.interceptor';

// 直连代理池管理端：全局凭据审计与熔断（契约见 docs/API_AND_PROTOCOLS.md §5）
@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/proxy-pool')
@UseInterceptors(ProxyPoolNoStoreInterceptor)
export class AdminProxyPoolController {
  constructor(private readonly proxyPoolService: ProxyPoolService) {}

  @Get('overview')
  @ApiOperation({ summary: '直连代理池总览：凭据规模、累计流量与可用端点' })
  overview() {
    return this.proxyPoolService.adminOverview();
  }

  @Get('keys')
  @ApiOperation({ summary: '分页检索全部用户的直连代理凭据' })
  listKeys(@Query() query: QueryAdminProxyKeysDto) {
    return this.proxyPoolService.adminListKeys(query);
  }

  @Post('keys/:id/active')
  @ApiOperation({ summary: '启用或停用指定凭据（立即重下发节点配置）' })
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetProxyKeyActiveDto) {
    return this.proxyPoolService.adminSetKeyActive(id, dto.isActive);
  }

  @Delete('keys/:id')
  @ApiOperation({ summary: '强制删除指定凭据' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.proxyPoolService.adminDeleteKey(id);
  }
}
