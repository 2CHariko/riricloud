import assert from 'node:assert/strict';
import test from 'node:test';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

test('Zod 4 校验失败应返回 React Hook Form 字段错误', async () => {
  const resolver = zodResolver(z.object({
    threshold: z.string().regex(/^\d+$/, 'threshold must be numeric')
  }));

  const result = await resolver(
    { threshold: 'd80' },
    undefined,
    {
      criteriaMode: 'firstError',
      fields: { threshold: {} },
      names: ['threshold'],
      shouldUseNativeValidation: false
    }
  );

  assert.equal(result.errors.threshold?.message, 'threshold must be numeric');
});
