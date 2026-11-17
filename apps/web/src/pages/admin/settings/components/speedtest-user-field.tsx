import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormContext, useWatch } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminUsers } from '@/pages/admin/users/use-users';
import type { SettingsForm } from '../settings-schema';
import { isSpeedtestUserCandidate } from '../speedtest-user-options';
import { SettingsSelect } from './settings-fields';

export function SpeedtestUserField() {
  const { t } = useTranslation(['admin', 'common']);
  const { control } = useFormContext<SettingsForm>();
  const selected = useWatch({ control, name: 'lineSpeedtestUserId' });
  const enforceEmailVerification = useWatch({ control, name: 'enforceEmailVerification' });
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchId = useId();
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const users = useAdminUsers({ search: debouncedSearch, isActive: true, pageSize: 100 });
  const candidates = (users.data?.data ?? []).filter((user) => isSpeedtestUserCandidate(user, enforceEmailVerification));
  const selectedUser = users.data?.data.find((user) => user.id === selected);
  const options = [
    { value: 'none', label: t('admin:latencyTest.settings.userNone') },
    ...candidates.map((user) => ({ value: user.id, label: [user.uid, user.nickname, user.email].filter(Boolean).join(' · ') }))
  ];
  // 搜索和后台刷新不能清空已选账号；服务端会拒绝已失效身份。
  if (selected && selected !== 'none' && !candidates.some((user) => user.id === selected)) {
    options.push({ value: selected, label: selectedUser?.email ?? t('admin:latencyTest.settings.userCurrent', { id: selected }) });
  }
  return <div className="space-y-3 sm:col-span-2 min-w-0">
    <div className="space-y-2">
      <Label htmlFor={searchId}>{t('admin:latencyTest.settings.userSearch')}</Label>
      <Input id={searchId} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('admin:latencyTest.settings.userSearchPlaceholder')} />
    </div>
    <SettingsSelect name="lineSpeedtestUserId" label={t('admin:latencyTest.settings.user')} description={t('admin:latencyTest.settings.userHelp')} options={options} />
    <p className="text-xs text-muted-foreground" role="status">{users.isError ? t('admin:latencyTest.settings.userLoadFailed') : users.isPending ? t('common:actions.loading') : t('admin:latencyTest.settings.userSearchHint')}</p>
  </div>;
}
