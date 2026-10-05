import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { defaults, levels, validationPolicySchema } from '../validation-policy';

export function TemplateValidationEditor({ value, onChange }: { value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }) {
  const { t } = useTranslation('admin');
  const parsed = validationPolicySchema.safeParse(value);
  const policy = parsed.success ? parsed.data : {};
  const checks = policy.checks ?? {};
  const fixes = policy.fixes ?? {};
  return <div className="space-y-4 overflow-y-auto p-1">
    <p className="text-sm text-muted-foreground">{t('templateAnalysis.policyHelp')}</p>
    <div className="grid gap-3 sm:grid-cols-2">
      {(Object.keys(defaults) as Array<keyof typeof defaults>).map((key) => <Card key={key} className="shadow-sm"><CardContent className="flex items-center justify-between gap-3 p-3">
        <Label htmlFor={`validation-${key}`}>{t(`templateAnalysis.checks.${key}`)}</Label>
        <Select value={checks[key] ?? defaults[key]} onValueChange={(level) => onChange({ ...value, checks: { ...checks, [key]: level } })}>
          <SelectTrigger id={`validation-${key}`} className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>{levels.map((level) => <SelectItem key={level} value={level}>{t(`templateAnalysis.levels.${level}`)}</SelectItem>)}</SelectContent>
        </Select>
      </CardContent></Card>)}
    </div>
    <Card className="shadow-sm"><CardContent className="space-y-4 p-3">
      <Label htmlFor="validation-save-gate">{t('templateAnalysis.saveGate')}</Label>
      <Select value={policy.saveGate ?? 'off'} onValueChange={(saveGate) => onChange({ ...value, saveGate })}>
        <SelectTrigger id="validation-save-gate"><SelectValue /></SelectTrigger>
        <SelectContent>{(['off', 'error', 'warning'] as const).map((level) => <SelectItem key={level} value={level}>{t(`templateAnalysis.gates.${level}`)}</SelectItem>)}</SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t('templateAnalysis.gateHelp')}</p>
      {(['deduplicate', 'aliases'] as const).map((key) => <div key={key} className="flex items-center justify-between gap-3">
        <Label htmlFor={`fix-${key}`}>{t(`templateAnalysis.fixes.${key}`)}</Label>
        <Switch id={`fix-${key}`} checked={fixes[key] ?? true} onCheckedChange={(enabled) => onChange({ ...value, fixes: { ...fixes, [key]: enabled } })} />
      </div>)}
    </CardContent></Card>
    <div className="grid gap-3 sm:grid-cols-3">
      {([['maxDiagnostics', 200, 1, 1000], ['keywordMinLength', 5, 1, 32], ['maxTestInterval', 600, 30, 86400]] as const).map(([key, fallback, min, max]) => <div key={key} className="space-y-2">
        <Label htmlFor={`policy-${key}`}>{t(`templateAnalysis.${key}`)}</Label>
        <Input id={`policy-${key}`} type="number" min={min} max={max} value={typeof value[key] === 'number' ? value[key] : fallback} onChange={(event) => onChange({ ...value, [key]: Number(event.target.value) })} />
      </div>)}
    </div>
    <div className="space-y-2"><Label htmlFor="validation-ignored">{t('templateAnalysis.ignoredDomains')}</Label>
      <Textarea id="validation-ignored" value={Array.isArray(value.ignoredDomains) ? value.ignoredDomains.join('\n') : ''} onChange={(event) => onChange({ ...value, ignoredDomains: event.target.value.split('\n').filter(Boolean) })} />
      <p className="text-xs text-muted-foreground">{t('templateAnalysis.ignoredHelp')}</p>
    </div>
  </div>;
}
