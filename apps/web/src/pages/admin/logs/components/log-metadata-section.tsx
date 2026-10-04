import { useTranslation } from 'react-i18next';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { LogCopyButton } from '@/components/shared/log-copy-button';
import type { detailMetadata } from '@/lib/log-detail-presentation';

export function LogMetadataSection({ metadata }: { metadata: ReturnType<typeof detailMetadata> }) {
  const { t } = useTranslation(['admin']);
  return (
    <section className="min-w-0 space-y-2" aria-label={t('admin:logs.detail.rawMetadata')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">{t('admin:logs.detail.rawMetadata')}</h3>
        {metadata.text && <LogCopyButton value={metadata.text} label={t('admin:logs.detail.rawMetadata')} />}
      </div>
      {metadata.state === 'invalid' && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{t('admin:logs.detail.invalidMetadata')}</p>}
      {metadata.state === 'empty' ? <p className="text-xs text-muted-foreground">{t('admin:logs.detail.emptyMetadata')}</p> : (
        <Accordion type="single" collapsible>
          <AccordionItem value="metadata" className="min-w-0 rounded-lg border px-3">
            <AccordionTrigger className="py-3 text-xs">{t('admin:logs.detail.viewRaw')}</AccordionTrigger>
            <AccordionContent>
              <pre className="max-h-72 max-w-full overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-relaxed select-text">{metadata.text}</pre>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </section>
  );
}
