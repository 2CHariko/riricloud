import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { TrendBucket } from '../types';

interface LogTrendChartProps {
  trend?: TrendBucket[];
  isLoading: boolean;
  sampled?: boolean;
  sampleLimit?: number;
}

export function LogTrendChart({ trend, isLoading, sampled, sampleLimit }: LogTrendChartProps) {
  const { t } = useTranslation(['admin', 'common']);

  if (isLoading && (!trend || trend.length === 0)) {
    return null;
  }

  const chartData = trend ?? [];
  const hasData = chartData.some((d) => d.total > 0);

  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-2 pt-4 px-4 sm:px-6">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-semibold">{t('admin:logs.filteredTrendTitle')}</CardTitle>
            <CardDescription className="text-xs">{t('admin:logs.filteredTrendDesc')}</CardDescription>
            {sampled && <CardDescription className="text-xs text-warning">{t('admin:logs.metricsSampled', { limit: sampleLimit ?? 20000 })}</CardDescription>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-2 sm:px-6 pb-4 pt-1">
        {!hasData ? (
          <div className="flex h-44 items-center justify-center text-xs text-muted-foreground">
            {t('admin:logs.filteredTrendEmpty')}
          </div>
        ) : (
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-muted/40" />
                <XAxis
                  dataKey="bucket"
                  tickFormatter={(value: string) => trend && trend.length > 24 ? value.slice(5) : value.slice(-5)}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11, fill: 'currentColor' }}
                  className="text-muted-foreground"
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: 'currentColor' }}
                  className="text-muted-foreground"
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--popover))',
                    borderColor: 'hsl(var(--border))',
                    borderRadius: '0.5rem',
                    fontSize: '12px',
                    color: 'hsl(var(--popover-foreground))',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                  }}
                  formatter={(value, name) => {
                    const labelMap: Record<string, string> = {
                      error: 'ERROR',
                      warn: 'WARN',
                      info: 'INFO',
                      debug: 'DEBUG'
                    };
                    return [value, labelMap[String(name)] || name];
                  }}
                  labelFormatter={(label) => t('admin:logs.timeLabel', { time: String(label ?? '') })}
                />
                <Legend
                  verticalAlign="top"
                  align="right"
                  iconType="circle"
                  iconSize={7}
                  wrapperStyle={{ fontSize: '11px', paddingBottom: '4px' }}
                />
                <Bar dataKey="error" name="ERROR" stackId="a" fill="hsl(var(--destructive))" />
                <Bar dataKey="warn" name="WARN" stackId="a" fill="hsl(var(--chart-3))" />
                <Bar dataKey="info" name="INFO" stackId="a" fill="hsl(var(--chart-1))" radius={[2, 2, 0, 0]} />
                <Bar dataKey="debug" name="DEBUG" stackId="a" fill="hsl(var(--muted-foreground))" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
