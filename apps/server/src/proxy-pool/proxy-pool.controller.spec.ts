import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, ParseUUIDPipe, UnauthorizedException } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of } from 'rxjs';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { UserProxyPoolController } from './user-proxy-pool.controller';
import { AdminProxyPoolController } from './admin-proxy-pool.controller';
import { ProxyPoolService } from './proxy-pool.service';
import { ProxyPoolNoStoreInterceptor } from './proxy-pool-no-store.interceptor';
import { parseProxyPoolLineIds, QueryProxyPoolNodesDto } from './dto/query-proxy-pool-nodes.dto';
import { QueryProxyPoolExportDto } from './dto/query-proxy-pool-export.dto';

const id = '11111111-1111-4111-8111-111111111111';
const context = (handler: object, controller: object, request: object): ExecutionContext => ({
  getHandler: () => handler, getClass: () => controller,
  switchToHttp: () => ({ getRequest: () => request })
}) as ExecutionContext;

describe('ProxyPool HTTP DTO and guard contracts', () => {
  it.each([QueryProxyPoolNodesDto, QueryProxyPoolExportDto])('严格lineIds DTO %p', async (Dto) => {
    for (const value of ['', null, [], 'bad', `${id},`, Array(201).fill(id).join(',')]) {
      expect(await validate(plainToInstance(Dto, { lineIds: value }))).not.toHaveLength(0);
    }
    expect(await validate(plainToInstance(Dto, { keyId: id, lineIds: `${id},${id}` }))).toHaveLength(0);
    expect(parseProxyPoolLineIds(`${id},${id}`)).toEqual([id]);
    expect(parseProxyPoolLineIds(undefined)).toBeUndefined();
    expect(await validate(plainToInstance(Dto, { keyId: '' }))).not.toHaveLength(0);
  });

  it('export格式/协议/token受强校验且路径参数为UUID', async () => {
    expect(await validate(plainToInstance(QueryProxyPoolExportDto, { format: 'wrong', protocol: 'https', token: '' }))).toHaveLength(3);
    expect(await validate(plainToInstance(QueryProxyPoolExportDto, { token: id }))).toHaveLength(0);
    await expect(new ParseUUIDPipe().transform('bad', { type: 'param' })).rejects.toThrow();
  });

  it('nodes绑定当前用户与DTO，export缺登录/token拒绝', async () => {
    const service = { listEndpoints: jest.fn(), exportForToken: jest.fn(), exportForUser: jest.fn() };
    const controller = new UserProxyPoolController(service as unknown as ProxyPoolService);
    const query = { keyId: id, lineIds: id };
    controller.listEndpoints({ id: 'user' }, query);
    expect(service.listEndpoints).toHaveBeenCalledWith('user', query);
    await expect(controller.export(undefined, {}, { setHeader: jest.fn() } as never)).rejects.toThrow(UnauthorizedException);
  });

  it('全局JWT默认保护nodes/keys，export仅允许可选登录，管理端拒绝USER', async () => {
    const guard = new JwtAuthGuard(new Reflector());
    const base = Object.getPrototypeOf(JwtAuthGuard.prototype) as { canActivate: (ctx: ExecutionContext) => Promise<boolean> };
    const authenticate = jest.spyOn(base, 'canActivate').mockRejectedValue(new UnauthorizedException());
    try {
      await expect(guard.canActivate(context(UserProxyPoolController.prototype.listEndpoints, UserProxyPoolController, { headers: {} }))).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context(UserProxyPoolController.prototype.listKeys, UserProxyPoolController, { headers: {} }))).rejects.toThrow(UnauthorizedException);
      expect(await guard.canActivate(context(UserProxyPoolController.prototype.export, UserProxyPoolController, { headers: {} }))).toBe(true);
      authenticate.mockResolvedValue(true);
      await expect(guard.canActivate(context(AdminProxyPoolController.prototype.overview, AdminProxyPoolController, { user: { role: 'USER' }, headers: {} }))).rejects.toThrow(ForbiddenException);
      expect(await guard.canActivate(context(AdminProxyPoolController.prototype.overview, AdminProxyPoolController, { user: { role: 'ADMIN' }, headers: {} }))).toBe(true);
    } finally { authenticate.mockRestore(); }
  });

  it('所有Key/list/export响应设置no-store，包含失败调用前的headers', () => {
    for (const controller of [UserProxyPoolController, AdminProxyPoolController]) {
      expect(Reflect.getMetadata(INTERCEPTORS_METADATA, controller)).toContain(ProxyPoolNoStoreInterceptor);
    }
    const response = { setHeader: jest.fn() };
    const ctx = { switchToHttp: () => ({ getResponse: () => response }) } as ExecutionContext;
    new ProxyPoolNoStoreInterceptor().intercept(ctx, { handle: () => of(null) });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
  });
});
