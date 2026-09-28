import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BatchUpgradeNodeDto } from './batch-upgrade-node.dto';

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

describe('BatchUpgradeNodeDto', () => {
  it('接受最多 100 个唯一 UUID 和可选资源 ID', async () => {
    const dto = plainToInstance(BatchUpgradeNodeDto, { ids: Array.from({ length: 100 }, (_, index) => uuid(index + 1)), resourceId: uuid(101) });
    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([
    { ids: [] },
    { ids: [uuid(1), uuid(1).toUpperCase()] },
    { ids: ['not-a-uuid'] },
    { ids: Array.from({ length: 101 }, (_, index) => uuid(index + 1)) },
    { ids: [uuid(1)], resourceId: 'not-a-uuid' }
  ])('拒绝无效批量升级输入', async (value) => {
    const dto = plainToInstance(BatchUpgradeNodeDto, value);
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
