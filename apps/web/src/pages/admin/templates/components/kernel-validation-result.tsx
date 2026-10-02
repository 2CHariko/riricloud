import { useTranslation } from 'react-i18next';
import { cva } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { kernelCheckTone, kernelDiagnosticCode, type KernelCheckResult, type KernelResourceRequirement } from '@/lib/probe-types';

const validationStyle = cva('shrink-0', {
  variants: {
    tone: {
      success: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      danger: 'border-destructive/20 bg-destructive/10 text-destructive',
      warning: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
      muted: 'border-border bg-muted text-muted-foreground',
    },
  },
});

function summaryKey(check: KernelCheckResult) {
  if (kernelCheckTone(check) === 'success') return 'passed';
  if (check.status === 'FAILED') {
    if (check.diagnostics?.includes('INVALID_CONFIG')) return 'parseFailed';
    return check.executed ? 'nativeFailed' : 'failed';
  }
  if (check.status === 'EXTERNAL_RESOURCES_REQUIRED') return 'resourcesRequired';
  if (check.status === 'UNAVAILABLE') return 'unavailable';
  if (check.status === 'UNSUPPORTED') return 'unsupported';
  if (check.status === 'PASSED') return check.executed ? 'partial' : 'unexecuted';
  return 'unknown';
}

const resourceKinds = ['GEOIP', 'GEOSITE', 'RULE_PROVIDER', 'PROXY_PROVIDER', 'RULE_SET', 'CERTIFICATE', 'EXTERNAL_FILE', 'REMOTE_RESOURCE'] as const;
const resourceStates = ['AVAILABLE', 'MISSING', 'UNREADABLE', 'INVALID', 'UNSUPPORTED', 'REMOTE_DISABLED'] as const;
const resourceActions = ['PREPARE_RESOURCE', 'FIX_RESOURCE', 'CHECK_CLIENT', 'NONE'] as const;
const safeCode = <T extends string,>(value: string, allowed: readonly T[]): T | 'UNKNOWN' => allowed.find((code) => code === value) ?? 'UNKNOWN';

function ResourceRequirement({ resource }: { resource: KernelResourceRequirement }) {
  const { t } = useTranslation('admin');
  return (
    <li className="space-y-1 border-b border-border py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t(`templatePreview.validation.kind.${safeCode(resource.kind, resourceKinds)}`)}</span>
        <Badge variant="secondary">{t(`templatePreview.validation.state.${safeCode(resource.state, resourceStates)}`)}</Badge>
        <span>{t('templatePreview.validation.references', { count: resource.references })}</span>
      </div>
      <p className="break-all font-mono">{t('templatePreview.validation.location', { location: resource.location })}</p>
      <p>{t('templatePreview.validation.reason', { reason: t(`templatePreview.validation.diagnostics.${kernelDiagnosticCode(resource.reasonCode)}`) })}</p>
      <p>{t('templatePreview.validation.action', { action: t(`templatePreview.validation.actions.${safeCode(resource.actionCode, resourceActions)}`) })}</p>
    </li>
  );
}

export function KernelValidationResult({ check }: { check: KernelCheckResult }) {
  const { t } = useTranslation('admin');
  const tone = kernelCheckTone(check);
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'muted' ? Info : AlertTriangle;
  const resources = check.resourceRequirements ?? [];
  const truncated = check.resourceRequirementsTruncated ?? 0;
  const diagnostics = [...new Set((check.diagnostics ?? []).map(kernelDiagnosticCode))];
  return (
    <Card className={cn(validationStyle({ tone }))}>
      <CardContent className="space-y-2 p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <h3 className="font-semibold">{t('templatePreview.validation.title')}</h3>
          <span className="font-medium">{t(`templatePreview.validation.${summaryKey(check)}`)}</span>
        </div>
        <p className="text-muted-foreground">{t('templatePreview.validation.description')}</p>
        <div className="flex flex-wrap gap-1.5 text-foreground">
          <Badge variant="outline">{check.engine === 'MIHOMO' || check.engine === 'SINGBOX' ? t(`probes.engine.${check.engine}`) : t('templatePreview.validation.unknownEngine')} · {check.engineVersion ?? '—'}</Badge>
          <Badge variant="outline">{t(`templatePreview.validation.${check.executed ? 'executed' : 'unexecuted'}`)}</Badge>
          <Badge variant="outline">{t(`templatePreview.validation.${check.scope === 'FULL' ? 'full' : 'partialScope'}`)}</Badge>
        </div>
        {diagnostics.length > 0 && <ul className="list-inside list-disc space-y-1">{diagnostics.map((code) => <li key={code}>{t(`templatePreview.validation.diagnostics.${code}`)}</li>)}</ul>}
        <Accordion type="single" collapsible className="text-foreground">
          <AccordionItem value="resources" className="border-0">
            <AccordionTrigger className="py-1 text-xs">{t('templatePreview.validation.details', { count: resources.length })}</AccordionTrigger>
            <AccordionContent className="max-h-60 overflow-y-auto pb-0 text-xs">
              {resources.length > 0 ? <ul>{resources.map((resource, index) => <ResourceRequirement key={index} resource={resource} />)}</ul> : <p className="py-2 text-muted-foreground">{t('templatePreview.validation.empty')}</p>}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        {truncated > 0 && <p>{t('templatePreview.validation.truncated', { count: truncated })}</p>}
      </CardContent>
    </Card>
  );
}
