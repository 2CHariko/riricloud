import { z } from 'zod';
export const levels = ['off', 'info', 'warning', 'error'] as const;
export const defaults = { duplicate: 'info', shadow: 'warning', catchAll: 'warning', groups: 'error', dnsOverride: 'warning', dnsRouting: 'warning', broadKeyword: 'warning', healthCheck: 'info', coverage: 'info' } as const;
const checkSchema = z.object(Object.fromEntries(Object.keys(defaults).map((key) => [key, z.enum(levels).optional()]))).strict();
export const validationPolicySchema = z.object({
  checks: checkSchema.optional(),
  fixes: z.object({ deduplicate: z.boolean().optional(), aliases: z.boolean().optional() }).strict().optional(),
  maxDiagnostics: z.number().int().min(1).max(1000).optional(),
  keywordMinLength: z.number().int().min(1).max(32).optional(),
  maxTestInterval: z.number().int().min(30).max(86400).optional(),
  ignoredDomains: z.array(z.string().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/)).max(500).optional(),
  saveGate: z.enum(['off', 'error', 'warning']).optional()
}).strict();

