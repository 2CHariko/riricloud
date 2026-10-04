import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsIP,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  IsISO8601,
  Min,
  registerDecorator,
  type ValidationOptions,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface
} from 'class-validator';
import { AGENT_PROTOCOL_VERSION, isLogReportData } from '../agent-message';

const MAX_UINT64 = 18446744073709551615n;

@ValidatorConstraint({ name: 'isUint64String', async: false })
class IsUint64StringConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) return false;
    try {
      return BigInt(value) <= MAX_UINT64;
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return '$property must be an unsigned 64-bit decimal string';
  }
}

function IsUint64String(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isUint64String',
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      validator: IsUint64StringConstraint
    });
  };
}

@ValidatorConstraint({ name: 'isSafeLogBatch', async: false })
class IsSafeLogBatchConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    // 保持 HTTP 旧上限 100 条，复用 WS 的字段、元数据和字节预算校验。
    return isLogReportData({ logs: value }, 100);
  }

  defaultMessage(): string {
    return 'logs must satisfy the bounded Agent log contract';
  }
}

function IsSafeLogBatch(): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({ name: 'isSafeLogBatch', target: target.constructor,
      propertyName: propertyKey.toString(), validator: IsSafeLogBatchConstraint });
  };
}

export class PollTrafficSnapshotDto {
  @IsString()
  userUuid!: string;

  @IsString()
  @IsUint64String()
  uploadTotal!: string;

  @IsString()
  @IsUint64String()
  downloadTotal!: string;
}

export class PollOnlineDeviceDto {
  @IsString()
  userUuid!: string;

  @IsIP()
  ip!: string;

  @IsOptional()
  @IsString()
  lineId?: string;

  @IsInt()
  @Min(0)
  @Max(1000000)
  connections!: number;

  @IsInt()
  @Min(0)
  lastSeenAt!: number;
}

export class PollConfigApplyResultDto {
  @IsInt()
  @Min(0)
  version!: number;

  @IsBoolean()
  success!: boolean;

  @IsString()
  message!: string;
}

export class PollUpgradeResultDto {
  @IsString()
  taskId!: string;

  @IsIn(['singbox', 'agent'])
  target!: 'singbox' | 'agent';

  @IsString()
  version!: string;

  @IsBoolean()
  success!: boolean;

  @IsString()
  message!: string;
}

export class PollProbeResultItemDto {
  @IsIn(['tcp', 'dns', 'icmp'])
  type!: 'tcp' | 'dns' | 'icmp';

  @IsString()
  target!: string;

  @IsBoolean()
  success!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  latencyMs?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsString({ each: true })
  addresses?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  packetLossPercent?: number;

  @IsOptional()
  @IsString()
  message?: string;
}

export class PollProbeResultDto {
  @IsString()
  taskId!: string;

  @IsBoolean()
  success!: boolean;

  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PollProbeResultItemDto)
  results!: PollProbeResultItemDto[];
}

export class PollKickDevicesResultDto {
  @IsString()
  taskId!: string;

  @IsBoolean()
  success!: boolean;

  @IsString()
  message!: string;

  @IsInt()
  @Min(0)
  kickedConnections!: number;
}

export class PollRestartAgentResultDto {
  @IsString()
  taskId!: string;

  @IsBoolean()
  success!: boolean;

  @IsString()
  message!: string;
}

export class PollLogItemDto {
  @IsIn(['DEBUG', 'INFO', 'WARN', 'ERROR'])
  level!: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

  @IsString()
  @MaxLength(128)
  module!: string;

  @IsOptional()
  @IsIn(['AGENT', 'SINGBOX'])
  source?: 'AGENT' | 'SINGBOX';

  @IsString()
  @MaxLength(8192)
  message!: string;

  @IsOptional()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsISO8601({ strict: true })
  @MaxLength(64)
  occurredAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  sequence?: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  agentInstanceId?: string;
}

export class AgentPollDto {
  @IsInt()
  @Equals(AGENT_PROTOCOL_VERSION)
  protocolVersion!: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  cpuUsage!: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  memoryUsage!: number;

  @IsNumber()
  @Min(0)
  bandwidthRate!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  uploadRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  downloadRate?: number;

  @IsArray()
  @ArrayMaxSize(1024)
  @ValidateNested({ each: true })
  @Type(() => PollTrafficSnapshotDto)
  trafficSnapshots!: PollTrafficSnapshotDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1024)
  @ValidateNested({ each: true })
  @Type(() => PollOnlineDeviceDto)
  onlineDevices?: PollOnlineDeviceDto[];

  @IsOptional()
  @IsBoolean()
  kernelRunning?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  appliedConfigVersion?: number;

  @IsOptional()
  @IsString()
  lastError?: string;

  @IsOptional()
  @IsString()
  agentVersion?: string;

  @IsOptional()
  @IsString()
  osArch?: string;

  @IsOptional()
  @IsString()
  kernelVersion?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  capabilities?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PollConfigApplyResultDto)
  configApplyResults?: PollConfigApplyResultDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PollUpgradeResultDto)
  upgradeResults?: PollUpgradeResultDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PollProbeResultDto)
  probeResults?: PollProbeResultDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PollRestartAgentResultDto)
  restartAgentResults?: PollRestartAgentResultDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PollKickDevicesResultDto)
  kickDevicesResults?: PollKickDevicesResultDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PollLogItemDto)
  @IsSafeLogBatch()
  logs?: PollLogItemDto[];
}
