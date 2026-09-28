import * as React from 'react';
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  type RowSelectionState
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  Pagination,
  PaginationInfo,
  PaginationNext,
  PaginationPrevious
} from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { EmptyState } from '@/components/shared/empty-state';
import { useTranslation } from 'react-i18next';

// 通用数据表格：排序/分页/行选择/列可见性（五能力封装，规范见 FRONTEND_UI_GUIDELINES §8.1）
interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** 数据集总条数（服务端搜索后的总量提示用） */
  total?: number;
  /** 初始每页行数 */
  initialPageSize?: number;
  /** 行选择变化回调 */
  onSelectionChange?: (rows: TData[]) => void;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: React.Dispatch<React.SetStateAction<RowSelectionState>>;
  emptyTitle?: string;
  emptyDescription?: string;
  toolbar?: React.ReactNode;
  banner?: React.ReactNode;
  actions?: React.ReactNode;
  tableClassName?: string;
}

export function DataTable<TData extends { id: string }, TValue>({
  columns,
  data,
  total,
  initialPageSize = 20,
  onSelectionChange,
  rowSelection: propsRowSelection,
  onRowSelectionChange,
  emptyTitle,
  emptyDescription,
  toolbar,
  banner,
  actions,
  tableClassName
}: DataTableProps<TData, TValue>) {
  const { t } = useTranslation('common');
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [internalRowSelection, setInternalRowSelection] = React.useState<RowSelectionState>({});
  const rowSelection = propsRowSelection ?? internalRowSelection;
  const setRowSelection = onRowSelectionChange ?? setInternalRowSelection;
  const selectable = Boolean(onSelectionChange || onRowSelectionChange);
  const tableColumns = React.useMemo<ColumnDef<TData, TValue>[]>(() => {
    if (!selectable || columns.some((c) => c.id === 'select')) return columns;
    const selectColumn: ColumnDef<TData, TValue> = {
      id: 'select',
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && 'indeterminate')}
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label={t('table.selectAll')}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          disabled={!row.getCanSelect()}
          aria-label={t('table.selectRow')}
        />
      ),
      enableSorting: false,
      enableHiding: false
    };
    return [selectColumn, ...columns];
  }, [columns, selectable, t]);

  const table = useReactTable({
    data,
    columns: tableColumns,
    state: { sorting, columnVisibility, rowSelection },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: initialPageSize } }
  });

  // 选中行变化时回调外部
  React.useEffect(() => {
    onSelectionChange?.(table.getSelectedRowModel().rows.map((r) => r.original));
  }, [rowSelection, onSelectionChange, table]);

  const totalPages = Math.max(1, Math.ceil(data.length / table.getState().pagination.pageSize));

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <div className="flex flex-col items-stretch justify-between gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
        <div className="flex items-center gap-2 shrink-0">
          {actions}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Settings2 className="size-4" />
                {t('table.columns')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {table
                .getAllColumns()
                .filter((c) => c.getCanHide())
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(value: boolean) => column.toggleVisibility(!!value)}
                  >
                    {typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {banner}

      <Card className="min-w-0">
        <CardContent className="min-w-0 p-0">
          <Table className={tableClassName}>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : (
                      <div className={cn('flex items-center gap-1', header.column.getCanSort() && 'cursor-pointer select-none')} onClick={header.column.getToggleSortingHandler()}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanSort() && (
                          <span className="text-muted-foreground">
                            {{ asc: <ArrowUp className="h-3 w-3" />, desc: <ArrowDown className="h-3 w-3" /> }[header.column.getIsSorted() as string] ?? (
                              <ArrowUpDown className="h-3 w-3 opacity-50" />
                            )}
                          </span>
                        )}
                      </div>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={tableColumns.length} className="h-40">
                  <EmptyState title={emptyTitle} description={emptyDescription} className="border-0" />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <p>
          {total !== undefined && total > data.length
            ? t('table.totalItemsLimited', { total, loaded: data.length })
            : t('table.totalItems', { total: total ?? data.length })}
        </p>
        <Pagination>
          <PaginationInfo page={table.getState().pagination.pageIndex + 1} totalPages={totalPages} />
          <PaginationPrevious
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          />
          <PaginationNext onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} />
        </Pagination>
      </div>
    </div>
  );
}
