import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormContext } from 'react-hook-form';
import { Clock } from 'lucide-react';
import { formatDateTime } from '@/lib/utils';
import type { SettingsForm } from '../settings-schema';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
const TIMEZONE_CONFIGS = [
  { value: 'Asia/Shanghai', key: 'admin:settings.tzShanghai' as const },
  { value: 'Asia/Tokyo', key: 'admin:settings.tzTokyo' as const },
  { value: 'Asia/Singapore', key: 'admin:settings.tzSingapore' as const },
  { value: 'UTC', key: 'admin:settings.tzUtc' as const },
  { value: 'Europe/London', key: 'admin:settings.tzLondon' as const },
  { value: 'Europe/Paris', key: 'admin:settings.tzParis' as const },
  { value: 'America/New_York', key: 'admin:settings.tzNewYork' as const },
  { value: 'America/Los_Angeles', key: 'admin:settings.tzLosAngeles' as const },
  { value: 'Australia/Sydney', key: 'admin:settings.tzSydney' as const }
];
export function TimezoneSettingField() {
  const { t } = useTranslation(['admin', 'common']);
  const { control, watch, setValue } = useFormContext<SettingsForm>();
  const currentTimezone = watch('systemTimezone') || 'Asia/Shanghai';
  const isPreset = TIMEZONE_CONFIGS.some((tz) => tz.value === currentTimezone);
  const [selectMode, setSelectMode] = useState<string>(isPreset ? currentTimezone : 'custom');

  useEffect(() => {
    if (TIMEZONE_CONFIGS.some((tz) => tz.value === currentTimezone)) {
      setSelectMode(currentTimezone);
    } else {
      setSelectMode('custom');
    }
  }, [currentTimezone]);

  let previewText = '';
  try {
    previewText = formatDateTime(new Date(), currentTimezone);
  } catch {
    previewText = t('admin:settings.tzInvalid');
  }

  return (
    <div className="space-y-3 md:col-span-2 rounded-lg border p-3.5 sm:p-4 bg-muted/10 min-w-0 max-w-full overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 min-w-0">
        <div className="space-y-0.5 min-w-0">
          <FormLabel className="text-sm font-medium flex items-center gap-1.5">
            <Clock className="size-4 shrink-0 text-primary" />
            <span className="truncate">{t('admin:settings.tzLabel')}</span>
          </FormLabel>
          <FormDescription className="break-words">
            {t('admin:settings.tzDesc')}
          </FormDescription>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground rounded-md bg-muted/60 px-2.5 py-1 tabular-nums self-start sm:self-auto shrink-0 max-w-full truncate">
          <span className="shrink-0">{t('admin:settings.tzCurrentTime')}</span>
          <strong className="text-foreground font-medium truncate">{previewText}</strong>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 min-w-0">
        <FormItem className="min-w-0">
          <FormLabel className="text-xs text-muted-foreground">{t('admin:settings.tzPresetSelect')}</FormLabel>
          <Select
            value={selectMode}
            onValueChange={(val) => {
              setSelectMode(val);
              if (val !== 'custom') {
                setValue('systemTimezone', val, { shouldValidate: true, shouldDirty: true });
              }
            }}
          >
            <SelectTrigger className="w-full min-w-0 overflow-hidden [&>span]:truncate">
              <SelectValue placeholder={t('admin:settings.tzSelectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONE_CONFIGS.map((tz) => (
                <SelectItem key={tz.value} value={tz.value}>
                  {t(tz.key)}
                </SelectItem>
              ))}
              <SelectItem value="custom">{t('admin:settings.tzCustomOption')}</SelectItem>
            </SelectContent>
          </Select>
        </FormItem>

        <FormField
          control={control}
          name="systemTimezone"
          render={({ field }) => (
            <FormItem className="min-w-0">
              <FormLabel className="text-xs text-muted-foreground">{t('admin:settings.tzIanaInput')}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  className="min-w-0"
                  placeholder={t('admin:settings.tzIanaPlaceholder')}
                  onChange={(e) => field.onChange(e.target.value.trim())}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}
