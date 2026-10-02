import { Module } from '@nestjs/common';
import { ClientKernelsService } from './client-kernels.service';
import { ValidationResourcesService } from './validation-resources.service';

@Module({ providers: [ClientKernelsService, ValidationResourcesService], exports: [ClientKernelsService] })
export class ClientKernelsModule {}
