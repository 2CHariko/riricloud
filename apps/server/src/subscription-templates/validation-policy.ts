import { BadRequestException } from '@nestjs/common';

export const CHECKS = ['duplicate', 'shadow', 'catchAll', 'groups', 'dnsOverride', 'dnsRouting', 'broadKeyword', 'healthCheck', 'coverage'] as const;
export type Check = typeof CHECKS[number];
export type Level = 'off' | 'info' | 'warning' | 'error';
export interface ValidationPolicy {
  checks: Record<Check, Level>;
  fixes: { deduplicate: boolean; aliases: boolean };
  ignoredDomains: string[];
  maxDiagnostics: number;
  keywordMinLength: number;
  maxTestInterval: number;
  saveGate: 'off' | 'error' | 'warning';
}
export const DEFAULT_POLICY: ValidationPolicy = {
  checks: { duplicate: 'info', shadow: 'warning', catchAll: 'warning', groups: 'error', dnsOverride: 'warning', dnsRouting: 'warning', broadKeyword: 'warning', healthCheck: 'info', coverage: 'info' },
  fixes: { deduplicate: true, aliases: true }, ignoredDomains: [], maxDiagnostics: 200,
  keywordMinLength: 5, maxTestInterval: 600, saveGate: 'off'
};
export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseValidationPolicy(value: unknown = {}): ValidationPolicy {
  const fail = () => { throw new BadRequestException('Invalid template validation policy'); };
  if (!record(value)) return fail();
  if (Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_POLICY, key))) fail();
  const result = structuredClone(DEFAULT_POLICY);
  for (const key of ['checks', 'fixes'] as const) {
    const input = value[key];
    if (input === undefined) continue;
    if (!record(input)) return fail();
    for (const [name, setting] of Object.entries(input)) {
      if (!Object.hasOwn(result[key], name)) fail();
      if (key === 'checks') {
        if (!['off', 'info', 'warning', 'error'].includes(String(setting))) fail();
        result.checks[name as Check] = setting as Level;
      } else {
        if (typeof setting !== 'boolean') return fail();
        result.fixes[name as keyof ValidationPolicy['fixes']] = setting;
      }
    }
  }
  for (const [key, min, max] of [['maxDiagnostics', 1, 1000], ['keywordMinLength', 1, 32], ['maxTestInterval', 30, 86400]] as const) {
    const input = value[key];
    if (input === undefined) continue;
    if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) return fail();
    result[key] = input;
  }
  if (value.saveGate !== undefined) {
    if (!['off', 'error', 'warning'].includes(String(value.saveGate))) fail();
    result.saveGate = value.saveGate as ValidationPolicy['saveGate'];
  }
  if (value.ignoredDomains !== undefined) {
    if (!Array.isArray(value.ignoredDomains) || value.ignoredDomains.length > 500 || value.ignoredDomains.some((d) => typeof d !== 'string' || d.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(d))) return fail();
    result.ignoredDomains = [...new Set(value.ignoredDomains.map((d: string) => d.toLowerCase()))];
  }
  return result;
}
