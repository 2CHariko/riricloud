import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { UPSTREAM_NODE_STATUSES, type UpstreamNodeStatus } from '../../common/constants';

export class SetNodeStatusDto {
  @ApiProperty({ enum: UPSTREAM_NODE_STATUSES })
  @IsIn(UPSTREAM_NODE_STATUSES)
  status!: UpstreamNodeStatus;
}
