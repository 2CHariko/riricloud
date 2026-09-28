import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ResetDefaultsDialogProps {
  onConfirm: () => void;
  isPending: boolean;
  className?: string;
}

export function ResetDefaultsDialog({ onConfirm, isPending, className }: ResetDefaultsDialogProps) {
  const { t } = useTranslation(['admin', 'common']);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          className={cn("w-full sm:w-auto gap-1.5 text-amber-600 hover:text-amber-700 border-amber-500/30", className)}
        >
          <RotateCcw className="size-4" />
          <span>{t('admin:docs.resetDefaults')}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('admin:docs.reset.title')}</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2 text-xs">
            <p>{t('admin:docs.reset.desc1')}</p>
            <p className="text-destructive font-medium">
              {t('admin:docs.reset.desc2')}
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isPending}
            className="bg-amber-600 hover:bg-amber-700 text-white"
          >
            {isPending ? t('admin:docs.reset.resetting') : t('admin:docs.reset.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
