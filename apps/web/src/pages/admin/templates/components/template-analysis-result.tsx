import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import type { TemplatePayload, TemplatePreviewResponse } from '../use-templates';

const reasons = ['duplicate', 'shadow', 'unreachable', 'duplicateGroup', 'missingTarget', 'cycle', 'shortKeyword', 'longInterval', 'httpTest', 'conditional', 'budget', 'rulesReplaced', 'overridden', 'emptyObject', 'emptyFallback', 'bootstrap', 'sharedResolvers'] as const;
export function TemplateAnalysisResult({ result, onApply, onUndo }: { result: TemplatePreviewResponse; onApply?: (template: TemplatePayload) => void; onUndo?: () => void }) {
  const { t } = useTranslation('admin');
  const { analysis, repair } = result;
  if (!analysis) return null;
  return <Card className="shrink-0 shadow-sm"><CardContent className="space-y-3 p-3 text-sm">
    <h3 className="font-semibold">{t('templateAnalysis.title')}</h3>
    <p className="text-xs text-muted-foreground">{t('templateAnalysis.scope')}</p>
    <div className="flex flex-wrap gap-2">{(['error', 'warning', 'info'] as const).map((level) => <Badge key={level} variant={level === 'error' && analysis.counts.error ? 'destructive' : 'secondary'}>{t(`templateAnalysis.levels.${level}`)} · {analysis.counts[level]}</Badge>)}</div>
    <p className="text-xs text-muted-foreground">{t('templateAnalysis.enabled', { count: analysis.enabledChecks.length })}</p>
    <Accordion type="single" collapsible>
      <AccordionItem value="diagnostics"><AccordionTrigger>{t('templateAnalysis.details')}</AccordionTrigger><AccordionContent>
        <ul className="max-h-72 space-y-3 overflow-y-auto">{analysis.diagnostics.map((item, i) => <li key={i} className="space-y-1 border-b pb-2">
          <p><Badge variant="outline">{t(`templateAnalysis.levels.${item.severity}`)}</Badge> {t(`templateAnalysis.reasons.${reasons.find((reason) => reason === item.reason) ?? 'conditional'}`)}</p>
          <p className="break-all font-mono text-xs">{item.location}{item.value ? ` · ${item.value}` : ''}</p>
          {item.related && <p className="break-all text-xs">{t('templateAnalysis.related', { location: item.related })}</p>}
          {item.target && <p className="break-all text-xs">{t('templateAnalysis.targets', { target: item.target, previous: item.previousTarget ?? '' })}</p>}
        </li>)}</ul>
        {!analysis.diagnostics.length && <p>{t('templateAnalysis.empty')}</p>}
      </AccordionContent></AccordionItem>
      {repair.changes.length > 0 && <AccordionItem value="repairs"><AccordionTrigger>{t('templateAnalysis.changes', { count: repair.changes.length })}</AccordionTrigger><AccordionContent>
        <ul className="max-h-60 space-y-3 overflow-y-auto">{repair.changes.map((change) => <li key={change.location}>
          <p className="break-all font-mono text-xs">{change.location}</p>
          <p className="text-xs">{t('templateAnalysis.before')}</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(change.before, null, 2)}</pre>
          <p className="text-xs">{t('templateAnalysis.after')}</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(change.after, null, 2)}</pre>
        </li>)}</ul>
      </AccordionContent></AccordionItem>}
    </Accordion>
    {analysis.truncated > 0 && <p>{t('templateAnalysis.truncated', { count: analysis.truncated })}</p>}
    {onApply && <div className="flex gap-2">
      <Button type="button" variant="outline" disabled={!repair.changes.length} onClick={() => onApply(repair.template)}>{t('templateAnalysis.apply')}</Button>
      <Button type="button" variant="ghost" disabled={!onUndo} onClick={onUndo}>{t('templateAnalysis.undo')}</Button>
    </div>}
  </CardContent></Card>;
}
