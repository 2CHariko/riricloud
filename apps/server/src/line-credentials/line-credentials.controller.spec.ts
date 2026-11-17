import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { LineCredentialsController } from './line-credentials.controller';
import { LineCredentialsService } from './line-credentials.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { AUTH_COOKIE_NAME } from '../auth/auth-cookie';
import { getJwtSecret } from '../common/runtime-config';

describe('administrator relay credential HTTP authorization', () => {
  let app: INestApplication;
  let port: number;
  const id = randomUUID();
  const records = new Map([['admin', { id: 'admin', email: 'admin.fixture@example.com', role: 'ADMIN', isActive: true, sessionVersion: 1 }], ['user', { id: 'user', email: 'user.fixture@example.com', role: 'USER', isActive: true, sessionVersion: 1 }]]);
  const safe = { lineId: id, operationId: randomUUID(), state: 'STOPPING_ENTRY', activeVersion: 1, targetVersion: 2, accepted: false };
  const rotate = jest.fn(async () => safe);
  const status = jest.fn(async () => safe);
  const jwt = new JwtService({ secret: getJwtSecret() });
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [LineCredentialsController], providers: [JwtStrategy, { provide: PrismaService, useValue: { user: { findUnique: async ({ where }: { where: { id: string } }) => records.get(where.id) ?? null } } }, { provide: LineCredentialsService, useValue: { rotate, status } }] }).compile();
    app = module.createNestApplication();
    app.useGlobalGuards(new JwtAuthGuard(app.get(Reflector)));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  beforeEach(() => { rotate.mockClear(); status.mockClear(); });
  afterAll(async () => app?.close());
  const token = (sub: string, sessionVersion = 1) => jwt.sign({ sub, role: 'ADMIN', sessionVersion });
  async function request(method: string, resource: string, auth?: string) {
    return new Promise<{ code: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/admin/lines/' + resource, method, agent: false, headers: auth ? { Cookie: AUTH_COOKIE_NAME + '=' + auth } : {} }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ code: response.statusCode!, body }));
      }); req.on('error', reject); req.end();
    });
  }
  it.each(['GET', 'POST'])('rejects missing authentication for %s', async method => {
    expect((await request(method, id + '/credentials/' + (method === 'POST' ? 'rotate' : 'status'))).code).toBe(401);
    expect(rotate).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  });
  it('uses the persisted role instead of a forged ADMIN claim', async () => {
    expect((await request('POST', id + '/credentials/rotate', token('user'))).code).toBe(403);
    expect(rotate).not.toHaveBeenCalled();
  });
  it('rejects revoked sessions and malformed UUID paths before mutation', async () => {
    expect((await request('POST', id + '/credentials/rotate', token('admin', 0))).code).toBe(401);
    expect((await request('POST', 'invalid/credentials/rotate', token('admin'))).code).toBe(400);
    expect(rotate).not.toHaveBeenCalled();
  });
  it('returns asynchronous maintenance status and propagates authenticated operator identity', async () => {
    const result = await request('POST', id + '/credentials/rotate', token('admin'));
    expect(result.code).toBe(202); expect(JSON.parse(result.body)).toEqual(safe);
    expect(rotate).toHaveBeenCalledWith(id, 'admin');
    const current = await request('GET', id + '/credentials/status', token('admin'));
    expect(current.code).toBe(200); expect(JSON.parse(current.body)).toEqual(safe);
  });
});
