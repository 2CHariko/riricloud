import { useTranslation } from 'react-i18next';
import { Activity, ArrowDown, ArrowUp, Copy, MoreHorizontal, Pencil, ShieldCheck, Trash2, Zap } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { isCredentialLine } from '../line-credentials-contract';
import type { AdminLine } from '../use-lines';

export interface LineRowActionsProps {
  line: AdminLine;
  first: boolean;
  last: boolean;
  resolving: boolean;
  duplicating: boolean;
  reordering: boolean;
  onSpeedtest: (line: AdminLine) => void;
  onEdit: (line: AdminLine) => void;
  onCredentials: (line: AdminLine) => void;
  onDelete: (line: AdminLine) => void;
  onResolve: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (line: AdminLine, direction: -1 | 1) => void;
}

export function LineRowActions({ line, first, last, resolving, duplicating, reordering, onSpeedtest, onEdit, onCredentials, onDelete, onResolve, onDuplicate, onMove }: LineRowActionsProps) {
  const { t } = useTranslation(['admin', 'common']);
  return <div className="flex items-center justify-end gap-0.5">
    <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:latencyTest.title')} onClick={() => onSpeedtest(line)}>
      <Activity className="size-4" />
    </IconButton>
    <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:lines.editLine')} onClick={() => onEdit(line)}>
      <Pencil className="size-4" />
    </IconButton>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:lines.moreActions')}>
          <MoreHorizontal className="size-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        {isCredentialLine(line) && <DropdownMenuItem onSelect={() => onCredentials(line)} className="gap-2 text-xs">
          <ShieldCheck className="size-3.5 text-muted-foreground" />
          <span>{t('admin:lineCredentials.manage')}</span>
        </DropdownMenuItem>}
        <DropdownMenuItem disabled={resolving} onClick={() => onResolve(line.id)} className="gap-2 text-xs">
          <Zap className="size-3.5 text-muted-foreground" /><span>{t('admin:lines.testResolve')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={duplicating} onClick={() => onDuplicate(line.id)} className="gap-2 text-xs">
          <Copy className="size-3.5 text-muted-foreground" /><span>{t('admin:lines.duplicateLine')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={first || reordering} onClick={() => onMove(line, -1)} className="gap-2 text-xs">
          <ArrowUp className="size-3.5 text-muted-foreground" /><span>{t('admin:lines.moveUp')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={last || reordering} onClick={() => onMove(line, 1)} className="gap-2 text-xs">
          <ArrowDown className="size-3.5 text-muted-foreground" /><span>{t('admin:lines.moveDown')}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onDelete(line)} className="gap-2 text-xs text-destructive focus:text-destructive focus:bg-destructive/10">
          <Trash2 className="size-3.5" /><span>{t('admin:lines.deleteLine')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
