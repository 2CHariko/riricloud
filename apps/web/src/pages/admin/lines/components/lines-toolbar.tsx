import { useTranslation } from 'react-i18next';
import { Activity, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { LineStatus, LineType } from '@/lib/api';
import { ProxyPoolDrawer } from './proxy-pool-drawer';

interface Props {
  search: string;
  tag: string;
  type: 'ALL' | LineType;
  status: 'ALL' | LineStatus;
  hasLines: boolean;
  onSearchChange: (value: string) => void;
  onTagChange: (value: string) => void;
  onTypeChange: (value: 'ALL' | LineType) => void;
  onStatusChange: (value: 'ALL' | LineStatus) => void;
  onCreate: () => void;
  onProbeAll: () => void;
}

export function LinesToolbar({ search, tag, type, status, hasLines, onSearchChange, onTagChange, onTypeChange, onStatusChange, onCreate, onProbeAll }: Props) {
  const { t } = useTranslation(['admin', 'common']);
  return (
    <div className="flex min-w-0 flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <div className="relative w-full min-w-0 flex-1 sm:min-w-52 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              onSearchChange(event.target.value);
            }}
            placeholder={t('admin:nodes.searchPlaceholder')}
            className="pl-9"
          />
        </div>
        <Input
          value={tag}
          onChange={(event) => {
            onTagChange(event.target.value);
          }}
          placeholder={t('admin:lines.filterTag')}
          className="w-full sm:w-28"
        />
        <Select
          value={type}
          onValueChange={(value) => {
            onTypeChange(value as 'ALL' | LineType);
          }}
        >
          <SelectTrigger className="w-full sm:w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('admin:lines.typeAll')}</SelectItem>
            <SelectItem value="DIRECT">{t('admin:lines.typeDirect')}</SelectItem>
            <SelectItem value="RELAY">{t('admin:lines.typeRelay')}</SelectItem>
            <SelectItem value="EXTERNAL">{t('admin:upstream.externalType')}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={status}
          onValueChange={(value) => {
            onStatusChange(value as 'ALL' | LineStatus);
          }}
        >
          <SelectTrigger className="w-full sm:w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('admin:lines.statusAll')}</SelectItem>
            <SelectItem value="ACTIVE">{t('admin:lines.statusActive')}</SelectItem>
            <SelectItem value="DISABLED">{t('admin:lines.statusDisabled')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 右侧动作条：代理池抽屉、全量测速与新建线路 */}
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <ProxyPoolDrawer />
        <Button
          variant="outline"
          size="sm"
          disabled={!hasLines}
          onClick={onProbeAll}
          className="w-full sm:w-auto"
        >
          <Activity className="size-4" />
          {t('admin:latencyTest.batchTitle')}
        </Button>
        <Button size="sm" className="w-full sm:w-auto" onClick={onCreate}>
          <Plus className="size-4" />
          {t('admin:lines.createLine')}
        </Button>
      </div>
    </div>

  );
}
