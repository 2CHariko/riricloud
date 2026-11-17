import { Controller, Get, Head, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OptionalAuth } from '../auth/optional-auth.decorator';
import { Public } from '../auth/public.decorator';
import { MirrorService } from './mirror.service';

@Public()
@OptionalAuth()
@Controller('mirror')
export class MirrorPublicController {
  constructor(private readonly mirrors: MirrorService) {}

  private user(request: Request) {
    return (request as Request & { user?: { id?: string; role?: string } }).user;
  }

  // 静态分享前缀必须先于 slug 通配路由登记，避免 Token 被当作普通路径。
  @Get('share/:token')
  share(@Param('token') token: string, @Req() request: Request, @Res() response: Response) {
    return this.mirrors.proxy('', token, request, response, this.user(request));
  }

  @Head('share/:token')
  shareHead(@Param('token') token: string, @Req() request: Request, @Res() response: Response) {
    return this.mirrors.proxy('', token, request, response, this.user(request));
  }

  @Get('share/:token/*path')
  sharePath(@Param('token') token: string, @Req() request: Request, @Res() response: Response) {
    return this.mirrors.proxy('', token, request, response, this.user(request));
  }

  @Head('share/:token/*path')
  sharePathHead(@Param('token') token: string, @Req() request: Request, @Res() response: Response) {
    return this.mirrors.proxy('', token, request, response, this.user(request));
  }

  @Get(':slug')
  access(@Param('slug') slug: string, @Req() request: Request, @Res() response: Response) {
    return this.mirrors.proxy(slug, undefined, request, response, this.user(request));
  }

  @Head(':slug')
  head(@Param('slug') slug: string, @Req() request: Request, @Res() response: Response) {
    return this.mirrors.proxy(slug, undefined, request, response, this.user(request));
  }

  @Get(':slug/*path')
  accessPath(@Param('slug') slug: string, @Req() request: Request, @Res() response: Response) {
    return this.mirrors.proxy(slug, undefined, request, response, this.user(request));
  }

  @Head(':slug/*path')
  headPath(@Param('slug') slug: string, @Req() request: Request, @Res() response: Response) {
    return this.mirrors.proxy(slug, undefined, request, response, this.user(request));
  }
}
