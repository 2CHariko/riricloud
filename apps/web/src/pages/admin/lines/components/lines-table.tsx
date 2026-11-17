import { useTranslation } from 'react-i18next';
import { HelpCircle, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/shared/empty-state';
import { FlagText } from '@/components/shared/flag-text';
import { ProbeMeasurementChip } from '@/components/shared/probe-result';
import { cn } from '@/lib/utils';
import { formatSpeedLimit, getSpeedTierBadgeClass, type SpeedTier } from '@/lib/speed-tier';
import type { LineStatus } from '@/lib/api';
import type { AdminLine } from '../use-lines';
import { LineTopology } from './line-topology';
import { LineRowActions, type LineRowActionsProps } from './line-row-actions';

interface Props {
  lines: AdminLine[];
  selected: Set<string>;
  unitConversion: boolean;
  speedLimitColorTiers?: SpeedTier[];
  onToggleAll: (checked: boolean) => void;
  onToggleSelected: (id: string, checked: boolean) => void;
  onStatusChange: (id: string, status: LineStatus) => void;
  onSpeedtest: (line: AdminLine) => void;
  actions: Omit<LineRowActionsProps, 'line' | 'first' | 'last'>;
}

export function LinesTable({ lines, selected, unitConversion, speedLimitColorTiers, onToggleAll, onToggleSelected, onStatusChange, onSpeedtest, actions }: Props) {
  const { t } = useTranslation(['admin', 'common']);
  const allSelected = lines.length > 0 && lines.every(line => selected.has(line.id));
  return (
    <Card>
      <CardContent className="min-w-0 p-0">
        {lines.length ? (
          <Table className="min-w-[900px] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-14">
                  <div className="flex items-center gap-1.5">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(checked) => onToggleAll(checked === true)}
                      aria-label={t('common:table.selectAll')}
                    />
                    <span className="font-mono text-xs text-muted-foreground font-semibold">
                      #
                    </span>
                  </div>
                </TableHead>
                <TableHead className="w-1/4 min-w-56">
                  {t('admin:lines.colLineAndEndpoint')}
                </TableHead>
                <TableHead className="w-1/3 min-w-64">
                  {t('admin:lines.colPipelineTopology')}
                </TableHead>
                <TableHead className="w-48 min-w-40">
                  {t('admin:lines.colTagsRate')}
                </TableHead>
                <TableHead className="w-28">
                  <div className="flex items-center gap-1">
                    <span>{t('admin:lines.colLatency')}</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="size-3.5 text-muted-foreground/70 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs space-y-1 text-xs shadow-lg">
                        <p className="font-semibold text-primary-foreground">{t('admin:latencyTest.title')}</p>
                        <p className="text-primary-foreground/80 leading-relaxed">{t('admin:latencyTest.description')}</p>
                        <p className="text-primary-foreground/65 text-[11px]">{t('admin:latencyTest.closeHelp')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="w-24">{t('admin:lines.colStatus')}</TableHead>
                <TableHead className="w-28 text-right">{t('admin:lines.colActions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line, index) => (
                <TableRow key={line.id} data-state={selected.has(line.id) ? 'selected' : undefined}>
                  {/* 1. 复选框与排序合并 */}
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={selected.has(line.id)}
                        onCheckedChange={(checked) => onToggleSelected(line.id, checked === true)}
                        aria-label={`${t('common:actions.select')} ${line.name}`}
                      />
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">
                        #{line.sortOrder}
                      </span>
                    </div>
                  </TableCell>

                  {/* 2. 线路名称与端点双层整合 */}
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium text-sm text-foreground">
                          <FlagText text={line.name} />
                        </span>
                        {!line.isPublic && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1 py-0 text-muted-foreground font-normal"
                          >
                            {t('admin:lines.privateLine')}
                          </Badge>
                        )}
                        {line.proxyPoolEnabled && (
                          <Badge
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 font-normal"
                          >
                            {t('admin:lineForm.proxyPoolEnabledBadge')}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="font-mono text-[11px]">Lv.{line.level}</span>
                        <span>·</span>
                        <span
                          className="font-mono text-[11px] truncate block"
                          title={`${line.serverHost}:${line.serverPort}`}
                        >
                          {line.serverHost}:{line.serverPort}
                        </span>
                      </div>
                    </div>
                  </TableCell>

                  {/* 3. 链路拓扑流水线（融合直连/中继/桥接/外部） */}
                  <TableCell>
                    <LineTopology line={line} />
                  </TableCell>

                  {/* 4. 规格与标签（限速、倍率、标签） */}
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {Boolean(line.speedLimitMbps) && (
                        <Badge
                          variant="outline"
                          className={cn(
                            'gap-1 text-[11px] px-1.5 py-0 font-normal',
                            getSpeedTierBadgeClass(
                              line.speedLimitMbps,
                              speedLimitColorTiers
                            )
                          )}
                        >
                          <Zap className="size-3" />
                          {formatSpeedLimit(line.speedLimitMbps, unitConversion)}
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[11px] px-1.5 py-0 font-mono">
                        {line.trafficRate}x
                      </Badge>
                      {line.tags.map((item) => (
                        <Badge
                          key={item}
                          variant="secondary"
                          className="text-[10px] px-1.5 py-0 font-normal"
                        >
                          #{item}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>

                  {/* 5. 端到端探测延迟（精炼指示微标） */}
                  <TableCell>
                    <ProbeMeasurementChip
                      value={line.lastProbe}
                      onClick={() => onSpeedtest(line)}
                    />
                  </TableCell>

                  {/* 6. 运行状态 */}
                  <TableCell>
                    <Badge
                      variant={line.status === 'ACTIVE' ? 'default' : 'secondary'}
                      className="text-[11px] px-2 py-0.5 cursor-pointer select-none"
                      onClick={() => {
                        const nextStatus = line.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
                        onStatusChange(line.id, nextStatus);
                      }}
                    >
                      {line.status === 'ACTIVE'
                        ? t('admin:lines.statusActive')
                        : t('admin:lines.statusDisabled')}
                    </Badge>
                  </TableCell>

                  {/* 7. 行操作列（高频外置 + 更多操作下拉折叠） */}
                  <TableCell className="text-right">
                    <LineRowActions line={line} first={index === 0} last={index === lines.length - 1} {...actions} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            title={t('admin:lines.emptyLines')}
            description={t('admin:lines.subtitle')}
            className="border-0"
          />
        )}
      </CardContent>
    </Card>

  );
}
