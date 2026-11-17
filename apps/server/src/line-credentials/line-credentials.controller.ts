import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { LineCredentialsService } from './line-credentials.service';

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/lines')
export class LineCredentialsController {
  constructor(private readonly credentials: LineCredentialsService) {}
  @Post(':id/credentials/rotate')
  @HttpCode(202)
  rotate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }) { return this.credentials.rotate(id, user.id); }
  @Get(':id/credentials/status')
  status(@Param('id', ParseUUIDPipe) id: string) { return this.credentials.status(id); }
}
