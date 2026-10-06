import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SmoothCollapseProps extends React.HTMLAttributes<HTMLDivElement> {
  open: boolean;
  children: React.ReactNode;
}

/**
 * 基于 CSS Grid (0fr -> 1fr) 的零依赖平滑折叠组件。
 * 彻底消除通过布尔条件插拔 DOM 导致的 0ms 瞬间高度重排与闪现。
 */
export function SmoothCollapse({ open, children, className, ...props }: SmoothCollapseProps) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none',
        className
      )}
      {...props}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
