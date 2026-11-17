import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { MirrorPublicController } from './mirror-public.controller';
import { MirrorService } from './mirror.service';

describe('MirrorPublicController route matching', () => {
  let app: INestApplication;
  let port: number;
  const proxy = jest.fn((_slug: string, _token: string | undefined, _request: Request, response: Response) => response.end());
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [MirrorPublicController], providers: [{ provide: MirrorService, useValue: { proxy } }] }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => app?.close());
  beforeEach(() => proxy.mockClear());

  it.each(['GET', 'HEAD'])('routes %s share URLs before the slug wildcard', async (method) => {
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path: '/mirror/share/test-token/release/asset.bin?tag=v1', method, agent: false }, (response) => { response.resume(); response.on('end', resolve); });
      request.on('error', reject); request.end();
    });
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(proxy.mock.calls[0][0]).toBe('');
    expect(proxy.mock.calls[0][1]).toBe('test-token');
    expect(proxy.mock.calls[0][2].params.path).toEqual(['release', 'asset.bin']);
    expect(proxy.mock.calls[0][2].method).toBe(method);
  });
});
