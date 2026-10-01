import { Controller, Delete, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/roles.decorator';
import { ClientKernelsService } from '../client-kernels/client-kernels.service';
import { ProbeTaskService } from './probe-task.service';
import { ProbeResultsQueryDto } from './probe-task.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class ProbeController {
  constructor(private readonly tasks: ProbeTaskService, private readonly kernels: ClientKernelsService) {}
  @Get('probe-tasks/:id')
  summary(@Param('id', ParseUUIDPipe) id: string) { return this.tasks.summary(id); }
  @Get('probe-tasks/:id/results')
  results(@Param('id', ParseUUIDPipe) id: string, @Query() query: ProbeResultsQueryDto) { return this.tasks.results(id, query.page, query.pageSize); }
  @Delete('probe-tasks/:id')
  cancel(@Param('id', ParseUUIDPipe) id: string) { return this.tasks.cancel(id); }
  @Get('client-kernels/status')
  status() { return this.kernels.status(); }
}
