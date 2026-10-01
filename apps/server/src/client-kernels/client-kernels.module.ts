import { Module } from '@nestjs/common';
import { ClientKernelsService } from './client-kernels.service';

@Module({ providers: [ClientKernelsService], exports: [ClientKernelsService] })
export class ClientKernelsModule {}
