import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/roles.decorator';
import { CertificatesService } from './certificates.service';
import { CreateCertificateDto, ExportCertificateDto, ParseCertificateDto, RetryCertificateDto, RollbackCertificateDto, UpdateCertificateDto } from './dto/create-certificate.dto';
import { QueryCertificateDto } from './dto/query-certificate.dto';
@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/certificates')
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) { }
  @Get('summary')
  summary() { return this.certificatesService.summary(); }
  @Get(':id/lines')
  lines(
  @Param('id', ParseUUIDPipe)
  id: string,
  @Query()
  query: QueryCertificateDto) { return this.certificatesService.associatedLines(id, query); }
  @Get(':id/revisions')
  revisions(
  @Param('id', ParseUUIDPipe)
  id: string,
  @Query()
  query: QueryCertificateDto) { return this.certificatesService.revisions(id, query); }
  @Get(':id/deployments')
  deployments(
  @Param('id', ParseUUIDPipe)
  id: string,
  @Query()
  query: QueryCertificateDto) { return this.certificatesService.deployments(id, query); }
  @Post(':id/preview-update')
  @Header('Cache-Control', 'no-store')
  preview(
  @Param('id', ParseUUIDPipe)
  id: string,
  @Body()
  dto: UpdateCertificateDto) { return this.certificatesService.preview(id, dto); }
  @Post(':id/rollback')
  rollback(
  @Param('id', ParseUUIDPipe)
  id: string,
  @Body()
  dto: RollbackCertificateDto,
  @Req()
  req: Request & {
    user?: {
      id: string;
    };
  }) { return this.certificatesService.rollback(id, dto.revision, dto.expectedRevision, req.user?.id); }
  @Post(':id/deployments/retry')
  retry(
  @Param('id', ParseUUIDPipe)
  id: string,
  @Body()
  dto: RetryCertificateDto,
  @Req()
  req: Request & {
    user?: {
      id: string;
    };
  }) { return this.certificatesService.retry(id, dto.nodeIds, req.user?.id); }
  @Post(':id/export')
  async export(
  @Param('id', ParseUUIDPipe)
  id: string,
  @Body()
  dto: ExportCertificateDto,
  @Req()
  req: Request & {
    user?: {
      id: string;
    };
  },
  @Res()
  response: Response) {
    const file = await this.certificatesService.export(id, dto.format, req.user?.id);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', 'attachment; filename="' + file.filename + '"');
    response.send(file.content);
  }
  @Get()
  list(
  @Query()
  query: QueryCertificateDto) {
    return this.certificatesService.list(query);
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  detail(
  @Param('id', ParseUUIDPipe)
  id: string,
  @Req()
  req: Request & {
    user?: {
      id: string;
    };
  },
  @Query('publicOnly')
  publicOnly?: string) {
    return this.certificatesService.detail(id, req.user?.id, publicOnly === 'true');
  }
  @Post('parse')
  parse(
  @Body()
  dto: ParseCertificateDto) {
    return this.certificatesService.parse(dto);
  }
  @Post()
  create(
  @Body()
  dto: CreateCertificateDto,
  @Req()
  req: Request & {
    user?: {
      id: string;
    };
  }) {
    return this.certificatesService.create(dto, req.user?.id);
  }
  @Patch(':id')
  update(
  @Param('id', ParseUUIDPipe)
  id: string,
  @Body()
  dto: UpdateCertificateDto,
  @Req()
  req: Request & {
    user?: {
      id: string;
    };
  }) {
    return this.certificatesService.update(id, dto, req.user?.id);
  }
  @Delete(':id')
  remove(
  @Param('id', ParseUUIDPipe)
  id: string,
  @Req()
  req: Request & {
    user?: {
      id: string;
    };
  }) {
    return this.certificatesService.remove(id, req.user?.id);
  }
}
