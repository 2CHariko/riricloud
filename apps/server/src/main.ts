import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { configureRequestBodyParser } from './common/request-body-parser';
import { applySecurityHeaders } from './common/security-headers';
import { shouldEnableSwagger } from './common/swagger-config';
import { registerWebStatic } from './static/web-static';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureRequestBodyParser(app);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api/v1', {
    // 镜像地址是面向外部客户端的资源 URL，不带管理 API 前缀；管理接口仍位于 /api/v1。
    exclude: [
      { path: 'mirror/:slug', method: RequestMethod.ALL },
      { path: 'mirror/:slug/*path', method: RequestMethod.ALL },
      { path: 'mirror/share/:token', method: RequestMethod.ALL },
      { path: 'mirror/share/:token/*path', method: RequestMethod.ALL }
    ]
  });
  // 默认所有端点需要 JWT，@Public() 显式放行（安全红线：服务端默认拒绝）
  app.useGlobalGuards(new JwtAuthGuard(app.get(Reflector)));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true
    })
  );
  const configuredOrigins = (process.env.CORS_ORIGINS || process.env.RIRICLOUD_PUBLIC_URL || '')
    .split(',')
    .map((origin) => normalizeCorsOrigin(origin))
    .filter((origin): origin is string => Boolean(origin));
  const developmentOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
  const productionLike = process.env.NODE_ENV === 'production' || process.env.RIRICLOUD_ENV === 'production';
  const allowedOrigins = productionLike ? configuredOrigins : [...new Set([...configuredOrigins, ...developmentOrigins])];
  app.enableCors({
    credentials: true,
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('CORS origin is not allowed'));
    }
  });
  app.use((request: { path?: string }, response: { setHeader: (name: string, value: string) => void }, next: () => void) => {
    applySecurityHeaders(response, request.path, productionLike);
    next();
  });

  if (shouldEnableSwagger(process.env, productionLike)) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('RiriCloud API')
      .setDescription('RiriCloud 主控端 REST API（契约见 docs/API_AND_PROTOCOLS.md）')
      .setVersion(process.env.npm_package_version || '0.0.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  // Web 面板静态托管与 SPA 回退（存在 web dist 时启用，见 static/web-static.ts）
  registerWebStatic(app);

  await app.listen(process.env.PORT ?? 3000);
  Logger.log('HTTP listener ready', 'Bootstrap');
}

function normalizeCorsOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
bootstrap();
