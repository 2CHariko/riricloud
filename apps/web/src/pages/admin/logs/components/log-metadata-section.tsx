import { useTranslation } from 'react-i18next';
import { LogCopyButton } from '@/components/shared/log-copy-button';
import type { detailMetadata } from '@/lib/log-detail-presentation';

export function LogMetadataSection({ metadata }: { metadata: ReturnType<typeof detailMetadata> }) {
  const { t } = useTranslation(['admin']);
  return (
    <section className="min-w-0 space-y-1.5" aria-label={t('admin:logs.metadataTitle')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('admin:logs.metadataTitle')}
        </span>
        {metadata.text && (
          <LogCopyButton value={metadata.text} label={t('admin:logs.copyJson')} className="h-6 px-2 text-[10px] gap-1" />
        )}
      </div>
      {metadata.state === 'invalid' && (
        <div className="space-y-1.5">
          <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{t('admin:logs.detail.invalidMetadata')}</p>
          <pre className="max-h-60 max-w-full overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed select-text">
            {metadata.text}
          </pre>
        </div>
      )}
      {metadata.state === 'empty' && (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          {t('admin:logs.detail.emptyMetadata')}
        </p>
      )}
      {metadata.state === 'valid' && (
        <pre className="max-h-80 max-w-full overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3.5 font-mono text-[11px] leading-relaxed text-zinc-100 select-text shadow-inner">
          {metadata.text}
        </pre>
      )}
    </section>
  );
}
