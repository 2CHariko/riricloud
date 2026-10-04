import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';

/** 日志证据复制：等待剪贴板确认，换记录/卸载时清理反馈。 */
type LogCopyButtonProps = { value: string; label: string; iconOnly?: boolean; className?: string };

export function LogCopyButton(props: LogCopyButtonProps) {
  return <LogCopyAction key={props.value} {...props} />;
}

function LogCopyAction({ value, label, iconOnly = false, className }: LogCopyButtonProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout>>();
  const lifetime = React.useRef({ active: false });

  React.useEffect(() => {
    const session = lifetime.current;
    const pendingTimer = timer;
    session.active = true;
    return () => {
      session.active = false;
      clearTimeout(pendingTimer.current);
    };
  }, []);

  const copy = async () => {
    const session = lifetime.current;
    setBusy(true);
    try {
      await navigator.clipboard.writeText(value);
      if (!session.active) return;
      setCopied(true);
      toast.success(t('admin:logs.copiedLabel', { label }));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      if (session.active) toast.error(t('common:actions.copyFailed'));
    } finally {
      if (session.active) setBusy(false);
    }
  };

  const icon = copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />;

  return iconOnly ? (
    <IconButton
      type="button"
      variant="ghost"
      size="icon-xs"
      className={className}
      disabled={busy}
      onClick={() => void copy()}
      aria-label={t('admin:logs.copyField', { label })}
    >
      {icon}
    </IconButton>
  ) : (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className ? `h-6 px-2 text-[10px] gap-1 ${className}` : 'h-6 px-2 text-[10px] gap-1'}
      disabled={busy}
      onClick={() => void copy()}
    >
      {icon}
      {copied ? t('common:actions.copied') : t('common:actions.copy')}
    </Button>
  );
}
