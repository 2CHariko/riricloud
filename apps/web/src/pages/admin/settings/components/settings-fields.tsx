import type { InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormContext, type FieldPath } from 'react-hook-form';
import { useTheme } from 'next-themes';
import CodeMirror from '@uiw/react-codemirror';
import { Code2, Link2, type LucideIcon } from 'lucide-react';
import type { Extension } from '@codemirror/state';
import type { SettingsForm } from '../settings-schema';
import { Button } from '@/components/ui/button';
import { CardDescription, CardTitle } from '@/components/ui/card';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
export function SectionTitle({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return <><CardTitle className="flex items-center gap-2 text-base"><Icon className="h-5 w-5" />{title}</CardTitle><CardDescription>{description}</CardDescription></>;
}

export function SettingsInput({ name, label, description, type = 'text', placeholder, min, max }: { name: FieldPath<SettingsForm>; label: string; description?: string; type?: InputHTMLAttributes<HTMLInputElement>['type']; placeholder?: string; min?: number; max?: number }) {
  const { control } = useFormContext<SettingsForm>();
  return <FormField control={control} name={name} render={({ field }) => <FormItem className="min-w-0"><FormLabel>{label}</FormLabel><FormControl><Input {...field} className="min-w-0" type={type} min={min} max={max} placeholder={placeholder} value={field.value == null ? '' : String(field.value)} onChange={(event) => field.onChange(event.target.value)} /></FormControl>{description ? <FormDescription className="break-words">{description}</FormDescription> : null}<FormMessage /></FormItem>} />;
}

export function SettingsTextarea({ name, label, description, rows = 4, className }: { name: FieldPath<SettingsForm>; label: string; description?: string; rows?: number; className?: string }) {
  const { control } = useFormContext<SettingsForm>();
  return <FormField control={control} name={name} render={({ field }) => <FormItem className={`min-w-0 ${className ?? ''}`}><FormLabel>{label}</FormLabel><FormControl><Textarea {...field} className="min-w-0" rows={rows} value={String(field.value ?? '')} /></FormControl>{description ? <FormDescription className="break-words">{description}</FormDescription> : null}<FormMessage /></FormItem>} />;
}

export function SettingsSwitch({ name, label, description, className }: { name: FieldPath<SettingsForm>; label: string; description: string; className?: string }) {
  const { control } = useFormContext<SettingsForm>();
  return <FormField control={control} name={name} render={({ field }) => <FormItem className={`flex flex-row items-start justify-between gap-4 rounded-lg border p-4 shadow-sm min-w-0 ${className ?? ''}`}><div className="min-w-0 space-y-0.5"><FormLabel>{label}</FormLabel><FormDescription className="break-words">{description}</FormDescription></div><FormControl><Switch className="shrink-0" checked={Boolean(field.value)} onCheckedChange={field.onChange} /></FormControl></FormItem>} />;
}

export function SettingsSelect({ name, label, description, options }: { name: FieldPath<SettingsForm>; label: string; description?: string; options: Array<{ value: string; label: string }> }) {
  const { t } = useTranslation(['admin', 'common']);
  const { control } = useFormContext<SettingsForm>();
  return <FormField control={control} name={name} render={({ field }) => <FormItem className="min-w-0"><FormLabel>{label}</FormLabel><Select value={String(field.value || 'none')} onValueChange={(value) => field.onChange(value === 'none' ? 'none' : value)}><FormControl><SelectTrigger className="w-full min-w-0 overflow-hidden [&>span]:truncate"><SelectValue placeholder={t('admin:settings.selectPlaceholder')} /></SelectTrigger></FormControl><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>{description ? <FormDescription className="break-words">{description}</FormDescription> : null}<FormMessage /></FormItem>} />;
}

export function SettingsEditor({ name, label, description, extensions }: { name: FieldPath<SettingsForm>; label: string; description: string; extensions: Extension[] }) {
  const { control } = useFormContext<SettingsForm>();
  const { resolvedTheme } = useTheme();
  const editorTheme = resolvedTheme === 'dark' ? 'dark' : 'light';
  return <FormField control={control} name={name} render={({ field }) => <FormItem className="min-w-0"><FormLabel className="flex items-center gap-2"><Code2 className="h-4 w-4" />{label}</FormLabel><FormControl><div className="min-w-0 overflow-hidden rounded-md border bg-background shadow-sm"><CodeMirror value={String(field.value ?? '')} height="220px" theme={editorTheme} extensions={extensions} basicSetup={{ lineNumbers: true, foldGutter: true }} onChange={field.onChange} /></div></FormControl><FormDescription>{description}</FormDescription><FormMessage /></FormItem>} />;
}

export function SetOriginButton({ name }: { name: 'publicBaseUrl' | 'subscriptionBaseUrl' }) {
  const { t } = useTranslation(['admin', 'common']);
  const { setValue } = useFormContext<SettingsForm>();
  return <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setValue(name, window.location.origin, { shouldDirty: true })}><Link2 />{t('admin:settings.btnSetOrigin')}</Button>;
}
