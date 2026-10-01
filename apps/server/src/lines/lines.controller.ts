import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/roles.decorator';
import { BatchLineStatusDto } from './dto/batch-line-status.dto';
import { CreateLineDto } from './dto/create-line.dto';
import { QueryLineDto } from './dto/query-line.dto';
import { ReorderLinesDto } from './dto/reorder-lines.dto';
import { UpdateLineDto } from './dto/update-line.dto';
import { LinesService } from './lines.service';
import { ProbeTaskService } from '../probe/probe-task.service';
import { StartProbeDto } from '../probe/probe-task.dto';
import { CurrentUser } from '../auth/current-user.decorator';

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/lines')
export class LinesController {
  constructor(
    private readonly linesService: LinesService,
    private readonly tasks: ProbeTaskService
  ) {}

  @Get()
  list(@Query() query: QueryLineDto) {
    return this.linesService.list(query);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.linesService.detail(id);
  }

  @Post()
  create(@Body() dto: CreateLineDto) {
    return this.linesService.create(dto);
  }

  @Patch('reorder')
  reorder(@Body() dto: ReorderLinesDto) {
    return this.linesService.reorder(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLineDto) {
    return this.linesService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.linesService.remove(id);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id', ParseUUIDPipe) id: string) {
    return this.linesService.duplicate(id);
  }

  @Post(':id/copy')
  copy(@Param('id', ParseUUIDPipe) id: string) {
    return this.linesService.duplicate(id);
  }

  @Post(':id/test')
  test(@Param('id', ParseUUIDPipe) id: string) {
    return this.linesService.testResolve(id);
  }

  @Post('speedtest-all')
  @HttpCode(202)
  speedtestAll(@Body() dto: StartProbeDto, @CurrentUser() user: { id: string }) {
    return this.tasks.start(user.id, 'LINE', {}, dto.policy);
  }

  @Post(':id/speedtest')
  @HttpCode(202)
  speedtest(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StartProbeDto, @CurrentUser() user: { id: string }) {
    return this.tasks.start(user.id, 'LINE', { id }, dto.policy);
  }

  @Post('batch-status')
  batchStatus(@Body() dto: BatchLineStatusDto) {
    return this.linesService.batchStatus(dto);
  }
}
