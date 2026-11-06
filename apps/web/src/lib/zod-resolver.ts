import { zodResolver as baseZodResolver } from '@hookform/resolvers/zod';
import type { FieldValues, ResolverOptions, ResolverResult } from 'react-hook-form';
import type { z } from 'zod';

type ZodResolverFactory = <TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  schemaOptions?: Record<string, unknown>,
  factoryOptions?: { mode?: 'async' | 'sync'; raw?: boolean }
) => <TFieldValues extends FieldValues, TContext>(
  values: TFieldValues,
  context: TContext | undefined,
  options: ResolverOptions<TFieldValues>
) => Promise<ResolverResult<TFieldValues>>;

/**
 * 保持现有 useForm<FormValues> 的 Resolver 签名，同时使用支持 Zod 4 的运行时实现。
 */
export const zodResolver = baseZodResolver as unknown as ZodResolverFactory;
