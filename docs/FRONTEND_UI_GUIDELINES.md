# 前端 UI 与设计规范 (Frontend UI & Design Guidelines)

本文档定义 **RiriCloud** 前端（`apps/web`）的 UI 设计规范、组件体系、分层架构与交互标准。
本规范以 **shadcn/ui 官方生态标准** 为基准，旨在保持面板现代化、无边框极简质感（Modern Minimalist Dashboard）的同时，确保代码的高度可维护性与一致性。

---

## 1. 设计哲学与核心原则

1. **拥抱官方标准生态**：以 shadcn/ui 官方推荐的实现范式为唯一基准，杜绝“造轮子”与随意引入非标准三方库。
2. **强制使用原子组件**：严禁在业务页面中随意使用原生 HTML 交互标签（如 `<button>`、`<input>`、`<select>`），必须统一使用 `@/components/ui/` 导出的原子组件。
3. **数据驱动与类型安全**：表单强制通过 Zod Schema 进行端到端运行时类型校验；表格与图表遵循强类型定义。
4. **极简精致与无障碍优先**：遵循 Radix UI 无障碍规范（WAI-ARIA），采用 New York 紧凑精致风格，微交互清晰流畅。

---

## 2. 视觉体系与主题配置 (Theme & Tokens)

### 2.1 风格与基础预设

RiriCloud 采用 shadcn/ui 的 **New York** 风格预设，以更紧凑的内边距、更清晰的边框与更细腻的微排版适配管理后台场景：

| 维度 | 规范选型 | 说明 |
| :--- | :--- | :--- |
| **风格预设 (Style)** | `New York` | 紧凑、细腻边框、适合数据密集型 Dashboard |
| **基础色系 (Base Color)** | `Zinc` (中性冷灰) | 纯净、克制，突出核心业务状态数据 |
| **圆角弧度 (Radius)** | `0.5rem` (`8px` / `rounded-lg`) | 保持现代感与干练感 |
| **主题切换** | 浅色 (Light) / 暗黑 (Dark) / 跟随系统 (System) | 基于 `next-themes` 驱动，默认跟随操作系统偏好；顶栏按钮弹出三态下拉菜单（shadcn 官方主题切换范式），触发按钮图标跟随所选模式（Sun / Moon / Monitor）而非最终生效外观，菜单内当前态以 `Check` 图标标识，勾选「跟随系统」可恢复系统偏好 |

### 2.2 语义色彩与状态色阶规范

全站颜色必须通过 Tailwind 语义变量（如 `bg-background`、`text-foreground`、`border-border`）使用，严禁在业务代码中硬编码 HEX 颜色值（如 `#10b981`）。

业务状态语义对应如下：

| 业务状态 | 语义 Token | 视觉效果（Light / Dark） | 典型应用场景 |
| :--- | :--- | :--- | :--- |
| **正常 / 在线 / 成功** | `success` | `text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20` | 节点在线、同步成功、服务正常、已激活 |
| **警告 / 负载过高 / 临界** | `warning` | `text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20` | 流量达 80%、CPU 负载高、证书即将过期、节点详情「Agent 接入与画像」卡的升级版本未确认警示横幅（升级任务已完成但心跳上报版本未达目标，提示 Agent 重启可能失败） |
| **危险 / 离线 / 错误 / 封禁** | `destructive` | `text-destructive bg-destructive/10 border-destructive/20` | 节点离线、用户被封禁、鉴权失败、删除操作 |
| **未启用 / 闲置 / 次要** | `secondary` / `muted` | `text-muted-foreground bg-muted border-border` | 未配置节点、未激活用户、无日志、节点部署历史中自定义 URL 升级任务徽标 |

> **系统设置 · Agent 分发源配置**：设置页「Agent 运维」分组内的「项目 GitHub 仓库地址」（`SettingsInput`）与「GitHub 加速镜像列表」（`SettingsTextarea`，每行一个前缀代理 URL），为节点安装脚本的 GitHub Release 优先下载与镜像测速提供数据源，与「二进制分发基准 URL」同域展示。
> **安装命令选择器 · 平台可用性提示**：选择器按当前 OS tab 与节点上报架构匹配 `agent-<os>-<arch>` 的主控二进制清单（`/admin/binaries/info`），可用时展示 success 绿色提示、缺失时展示 warning 琥珀色提示（安装脚本将回退 GitHub Release/镜像下载），不阻断安装。
> **系统设置 · 数据库存储与碎片整理 (VACUUM)**：设置页「存储与日志」卡片与「历史观测数据清理」通用弹窗中集成 SQLite 数据库文件尺寸监控（实时展示业务主库 `riri.db`、观测库 `telemetry.db` 与总占用）及手动碎片整理与空间收缩（VACUUM）操作，清理或整理执行后即时反馈释放的物理磁盘字节数。
> **异步端到端拨测**：上游与线路共用 `ProbeTaskDialog` / `useProbeTask`。提交消费 HTTP 202 回执，待处理状态每秒轮询，结果服务端分页；关闭/卸载只停止观察，不隐式取消，取消必须显式 DELETE，任务 ID 保留供重开。仅 schemaVersion=1 安全元信息用于延迟展示；显示 MASTER 视角、实际内核/版本/目标/路由和时间，Sing-box 回退使用 warning 并说明不等于 Mihomo 兼容。STALE、取消、跳过、环境不可用、不支持与真实网络失败必须区分。系统设置提供独立回退开关及内核画像；模板检查仅消费对应格式 `kernelCheck`，只有 executed=true、PASSED、FULL 才称完整通过。
> 已完成、已取消和失败终态都刷新资源列表：批量任务取消或截止前可能已有前序批次写回，不能只按 COMPLETED 刷新。关闭弹窗仍不触发取消。

### 2.3 全局基础控件与微交互规范 (Scrollbar & Input Controls)

1. **滚动条美化规范 (Scrollbar Standard)**
   - 全站所有发生溢出滚动的容器（弹窗、侧边栏、表格、代码预览区等）统一采用极简细窄圆角设计，严禁出现 Windows 浏览器原生粗灰色轨道与上下箭头按钮。
   - 滚动条颜色基于当前主题变量 `--muted-foreground` 自适应计算（透明背景轨道 + `muted-foreground/0.25` 半透明圆角滑块，悬停提亮至 `0.45`），在明暗主题下无缝融入。
   - 规范样式统一定义于 `apps/web/src/index.css`（WebKit `width: 6px` + 标准 `scrollbar-width: thin`）。

2. **数字输入框规范 (Number Input Spinners)**
   - 全局隐藏 `<input type="number">` 的浏览器原生微调上下箭头（Spinners），由 `index.css` 全局重置（WebKit `-webkit-appearance: none` + Firefox `-moz-appearance: textfield`）。
   - 保持数字输入框（端口、速率、权重等）与普通文本输入框完全一致的对齐排版与间距。
   - 以字节保存、换算为 GiB 展示的流量字段必须使用 `step="any"`，避免任意字节数换算后的高精度小数被浏览器的固定步长校验误判；最小值与业务范围由 Zod schema 校验。

3. **页面与卡片进场动效规范 (Page & Card Transition)**
   - 全站子页面容器（`PageContainer`）与独立全屏卡片（`LoginPage` / `RegisterPage`）统一配置 `300ms ease-out` 的微景深淡入动效（`animate-in fade-in-0 zoom-in-[0.985] duration-300 ease-out`）。
   - 严禁生硬无动效的瞬切，同时杜绝产生 `translateY` 纵向位移以防止触发浏览器滚动条瞬时闪烁与页面抖动。

---

## 3. 组件分层与目录组织架构

`apps/web/src/components` 目录按严格分层管理：

```
apps/web/src/
├── components/
│   ├── ui/                 # 【底层原子组件】shadcn CLI 生成并维护，严禁侵入业务逻辑
│   │   ├── button.tsx
│   │   ├── input.tsx
│   │   ├── dialog.tsx
│   │   ├── form.tsx
│   │   ├── sidebar.tsx
│   │   └── ...
│   ├── shared/             # 【业务通用复合组件】全站多模块复用的高阶组件
│   │   ├── page-container.tsx   # 统一页面容器与页头插槽
│   │   ├── data-table.tsx       # TanStack Table 统一封装组件
│   │   ├── stat-card.tsx        # 统计指标卡片
│   │   ├── empty-state.tsx      # 空状态插槽组件
│   │   ├── copy-button.tsx      # 订阅链接一键复制按钮
│   │   ├── line-card.tsx        # 统一线路展示卡片（compact/full 双变体）
│   │   ├── announcement-card.tsx # 用户订阅页系统公告卡片
│   │   ├── announcement-detail-dialog.tsx # 系统公告居中详情阅读弹窗
│   │   ├── client-guide-card.tsx # 客户端三步使用指引
│   │   └── traffic-badge.tsx    # 流量单位格式化与状态胶囊
│   └── layout/             # 【全局框架布局】
│       ├── app-layout.tsx       # 主控端侧边栏 + 主内容区 Inset 总布局
│       ├── app-sidebar.tsx      # 左侧菜单导航与品牌头部 (h-14)
│       ├── app-header.tsx       # 顶部全局微操作栏 (h-14，位于主大卡片上方)
│       ├── announcement-center.tsx # 顶栏消息/公告中心（未读角标、内联下拉列表、强提醒弹窗）
│       ├── user-menu.tsx        # 顶栏独立小巧用户头像与退出菜单
│       └── theme-toggle.tsx     # 顶栏小巧明暗主题三态切换（浅色/深色/跟随系统）
├── pages/                  # 【页面级视图组件】仅负责数据获取、状态编排与子组件组装
│   ├── nodes/
│   ├── user/subscription/
│   ├── users/
│   └── settings/
```

---

## 4. 强制使用规范与禁止清单 (Hard Constraints & Banned Practices)

### 4.1 强制规范 (Do's)

1. **通过 CLI 安装原子组件**：基础组件一律通过 `pnpm dlx shadcn@latest add <component>` 生成至 `src/components/ui/`，保持标准实现。
2. **统一使用 `cn()` 合并样式**：使用 `clsx` + `tailwind-merge` 导出的 `cn(...)` 工具函数处理条件样式，避免类名冲突。
3. **复合组件采用 CVA 模式**：所有具有变体（variant / size）属性的自定义组件，必须基于 `class-variance-authority` (cva) 编写。
4. **唯一图标库使用**：全站仅允许引入 `lucide-react`，图标统一使用以下尺寸阶梯：
   - **Micro (14px / `size-3.5`)**：徽标内小图标、表格行内辅助说明。
   - **Regular (16px / `size-4`)**：按钮内部图标、表单输入框前后缀、常规文本行。
   - **Medium (20px / `size-5`)**：卡片标题图标、导航菜单项图标。
   - **Large (24px / `size-6`)**：统计面板大卡片图标、状态占位图。
   - **图标按钮尺寸**：常规工具栏/表格行操作使用 `icon-sm`（32px）；紧凑输入框、徽标或编辑器内联操作使用 `icon-xs`（28px）；仅无密度约束的独立主要操作使用 `icon`（36px）。图标按钮内部图形统一为 16px（`size-4`），不得用额外高度/宽度类覆盖按钮尺寸。
   - **图标按钮 Tooltip 与无障碍名称**：仅图标操作必须使用 `@/components/ui/icon-button` 的 `IconButton`，提供本地化且能描述具体操作的 `aria-label`；组件默认以该名称展示 Tooltip，需要更贴合上下文的提示时通过 `tooltip` 指定。不得再手写仅含图标的 `Button` 或为其重复嵌套 Tooltip；富文本说明可通过 IconButton 的 Tooltip 属性呈现。
5. **操作区域层级统一**：表单中承载 `Switch`、`Checkbox` 或操作按钮的区域必须使用 shadcn/ui `FormItem` / `Card` 结构；普通页面按既有卡片规范保持层级一致，线路编辑弹窗使用平面 `FormItem` 与 `Separator`，不增加边框容器或嵌套卡片。

### 4.2 严格禁止清单 (Don'ts)

| # | 禁止行为 | 正确做法 | 违规判定 |
| :-: | :--- | :--- | :--- |
| **B1** | 业务代码中直接手写 `<button>` 标签 | 必须 `import { Button } from "@/components/ui/button"` | ❌ 立即打回 |
| **B2** | 业务代码中手写 `<input>`、`<select>`、`<textarea>` | 必须使用 `@/components/ui/input` 等对应 shadcn 组件 | ❌ 立即打回 |
| **B3** | 引入 Ant Design / Element / MUI / Mantine 等外部重型 UI 库 | 统一使用 shadcn/ui 原生体系 | ❌ 立即打回 |
| **B4** | 在 Tailwind 类名中手写硬编码 HEX 色值（如 `bg-[#1a1a1a]`） | 必须使用语义变量（如 `bg-background`、`text-card-foreground`） | ❌ 立即打回 |
| **B5** | 高危破坏性操作仅用简单 `window.confirm` 或直接执行 | 必须使用 `@/components/ui/alert-dialog` 提供二次拦截弹窗 | ❌ 立即打回 |
| **B6** | 表单通过裸 `useState` 分散管理字段与手动判断报错 | 必须使用 `react-hook-form` + `zod` + shadcn `<Form>` | ❌ 立即打回 |
| **B7** | 内部页面跳转手写原生 HTML `<a>` 标签 | 站内导航必须使用 `react-router-dom` 的 `<Link>` 或 `<NavLink>`，严禁原生 `<a>` 引发整页刷新与白屏闪烁 | ❌ 立即打回 |
| **B8** | 在 `useEffect` 内直接初始化/重置表单草稿，或让初始化 effect 依赖 query 的 `.data` 对象、`useMemo` 派生数组等易变引用 | 必须使用 `useFormResetOnKey`（`apps/web/src/hooks/use-form-reset.ts`），依赖只允许 `open`、实体 id、`dataUpdatedAt` 等原始值（详见 §5.1） | ❌ 立即打回 |
| **B9** | 业务代码中手写原生 HTML `<table>`、`<thead>`、`<tbody>`、`<tr>`、`<th>`、`<td>` 标签 | 必须统一使用 `@/components/ui/table` 导出的原子组件 | ❌ 立即打回 |
| **B10** | 后台管理列表工具栏套用独立 Card 边框容器、将搜索框置于右侧，或将工具栏塞入表格 `CardContent` 内部导致表格内缩 | 工具栏平铺在 `Card` 外部且搜索框居左；表格独占 `<Card><CardContent className="min-w-0 p-0"><Table>` 贴边容器（详见 §8.1.1） | ❌ 立即打回 |

---

## 5. 表单与数据校验标准 (Form & Validation System)

所有录入、编辑与配置表单均须遵守：

```tsx
// 标准表单结构范式示例
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const nodeFormSchema = z.object({
  name: z.string().min(2, "节点名称至少2个字符").max(32, "节点名称最多32个字符"),
  serverHost: z.string().min(1, "请输入节点主机域名或IP"),
  serverPort: z.coerce.number().int().min(1).max(65535, "端口范围为 1-65535"),
});

type NodeFormValues = z.infer<typeof nodeFormSchema>;

export function NodeCreateForm({ onSubmit }: { onSubmit: (data: NodeFormValues) => void }) {
  const form = useForm<NodeFormValues>({
    resolver: zodResolver(nodeFormSchema),
    defaultValues: { name: "", serverHost: "", serverPort: 443 },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>节点名称</FormLabel>
              <FormControl>
                <Input placeholder="例如：HK-Premium-01" {...field} />
              </FormControl>
              <FormDescription>用于客户端订阅展示的易读名称</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        {/* 更多字段... */}
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "正在保存..." : "创建节点"}
        </Button>
      </form>
    </Form>
  );
}
```

### 5.1 表单初始化与实时数据解耦（强制）

弹窗与编辑面板的表单草稿**只允许在「打开弹窗 / 切换编辑对象」时初始化一次**，严禁让「初始化」退化成「随实时数据同步」——轮询（`refetchInterval`）或 refetch 会让 query 数据换成新引用，进而周期性地清空用户正在输入的内容。

- **R1**：草稿初始化/重置一律经 `useFormResetOnKey({ open, resetKey, reset, dataRevision?, isDirty? })`；禁止在 `useEffect` 内直接调用 `form.reset()`（已由 `eslint.config.js` 的 `no-restricted-syntax` 强制拦截）。
- **R2**：初始化 effect 的依赖只能是**原始值**——`open`、实体 id（如 `plan?.id ?? 'create'`）、`dataUpdatedAt`；禁止 query 的 `.data` 对象、`useMemo` 派生数组或内联 `filter/map` 的结果。
- **R3**：实时数据只驱动「展示」与「非破坏性校正」（例如所选出网节点已离线时给出字段提示、字段为空时补默认值），不得触发整表回写。

```tsx
// ✅ 正确：按业务身份初始化一次，轮询刷新只影响下拉选项与只读展示
useFormResetOnKey({
  open,
  resetKey: editing?.id ?? 'create',
  reset: () => form.reset(editing ? toFormValues(editing) : emptyFormValues())
});

// ✅ 需要回灌服务端值时：按 dataUpdatedAt 版本同步，并尊重未保存修改
useFormResetOnKey({
  resetKey: settingsQuery.data ? 'settings' : null,
  dataRevision: settingsQuery.dataUpdatedAt,
  isDirty: form.formState.isDirty,
  reset: () => { if (settingsQuery.data) form.reset(toForm(settingsQuery.data)); }
});

// ❌ 禁止：依赖随轮询/refetch 变化的引用，用户输入会被周期性清空
useEffect(() => {
  if (!open) return;
  form.reset({ name: editing?.name ?? '', nodeId: availableNodes[0]?.id ?? '' });
}, [availableNodes, editing, open]);
```

非表单的服务端状态整体同步（会话守卫、站点品牌运行时、注册开关跳转等）允许依赖 query 数据，但必须使用 `// eslint-disable-next-line no-restricted-syntax -- 理由` 显式豁免，并在评审中确认「该 effect 不承载用户草稿」。当前全仓豁免点仅 3 处：`router/guards.tsx`、`pages/register/index.tsx`、`components/layout/site-runtime.tsx`。

---

## 6. 全局交互反馈体系 (Feedback & Notifications)

### 6.1 Toast 通知标准 (`sonner`)

全站操作结果提示唯一使用 `sonner`，严禁使用原生 `alert()` 或自写悬浮条：

```tsx
import { toast } from "sonner";

// 成功反馈
toast.success("节点配置下发成功", { description: "Agent 已在 1.2s 内完成热重载" });

// 错误反馈
toast.error("操作失败", { description: error.message });

// 异步加载状态绑定
toast.promise(reloadAgentPromise, {
  loading: "正在向边缘节点发送指令...",
  success: "节点已重载",
  error: "节点重载失败，请检查 Agent 连接状态",
});
```

### 6.2 弹窗边界与选用矩阵

| 场景需求 | 采用组件 | 规范要求 |
| :--- | :--- | :--- |
| **常规数据录入 / 快速编辑** | `Dialog` 或 `Sheet` (抽屉) | 宽表单优先使用右侧 `Sheet` 抽屉，简短录入用居中 `Dialog` |
| **危险/破坏性操作拦截** | `AlertDialog` | 删除节点、清空日志、重置 Token、删除用户等必须使用，确认按钮标红（`variant="destructive"`） |
| **轻量级气泡说明 / 快捷提示** | `Tooltip` / `Popover` | 图标按钮统一由 `IconButton` 提供 `Tooltip`；复杂筛选器用 `Popover` |

弹窗尺寸统一使用 `@/components/ui/dialog` 的 `DialogContent` 变体：普通数据表单使用默认 `2xl`，线路和模板等复杂编辑使用 `wide` `3xl`，确实简单的内容才使用 `compact` `lg`。所有弹窗在移动端使用视口两侧留白并限制最大高度，内容超出时在弹窗内部滚动；破坏性确认继续使用固定的 `AlertDialog` `lg` 宽度。

响应式弹窗统一通过 `ResponsiveDialog` / `ResponsiveDialogContent` 承载：桌面端保持 Dialog，`767px` 及以下切换为右侧全高 Sheet，宽度占满视口并在内容区滚动。移动端导航使用 `SidebarProvider` 的 `openMobile` 状态与 Sheet 抽屉，路由切换后关闭抽屉；不得为每个业务页面重复实现媒体查询和抽屉状态。

### 6.3 加载占位 (Skeleton) 与数据平滑补间过渡

1. **初次加载**：页面加载与卡片首次数据请求中，禁止使用全屏巨型 Spinner 打断用户体验，必须使用 `Skeleton` 还原真实 UI 的骨架结构：
```tsx
import { Skeleton } from "@/components/ui/skeleton";

export function NodeCardSkeleton() {
  return (
    <div className="flex items-center space-x-4 p-4 border rounded-lg">
      <Skeleton className="size-10 rounded-full" />
      <div className="space-y-2 flex-1">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}
```

2. **参数/时间颗粒度切换（防闪屏约束）**：在 Tabs、筛选器、分页或时间跨度（如今日/24h/7d/30d）切换时，严禁使用粗粒度的 `isPending ? <Skeleton /> : ...` 导致整页 DOM 与图表被硬性卸载并闪烁骨架屏；必须配合 TanStack Query 的 `placeholderData: keepPreviousData`，条件渲染仅在首次无数据时触发骨架屏（`isPending && !data`），已有数据更新时保持原有视图并施加微透明过渡（如 `isFetching && 'opacity-85'`），图表通过数据补间平滑更新。

---

## 7. 布局结构与页面容器标准 (Layout & Container)

### 7.1 全局架构与 Inset 沉浸式卡片布局

1. **左侧导航栏 (`AppSidebar`)**：采用 shadcn/ui 官方 `Sidebar` (v4) `variant="inset"` 范式，无右侧贯穿硬分割线（`border-r-0`），与最外层底层底色（`bg-sidebar`）自然融为一体。顶部品牌区高度固定为 `h-14`，底部展示极简版本号；移动端使用左侧 Sheet 抽屉，支持遮罩、Escape 和导航后自动关闭。
2. **顶部全局操作栏 (`AppHeader`)**：位于主内容大卡片上方，高度为 `h-14`，与左侧品牌 Logo 水平高度严格齐平（1:1 对齐）。右侧放置紧凑的微操作按钮组：`ThemeToggle`（明暗三态图标切换）与 `UserMenu`（首字母圆形头像与个人中心下拉菜单）。移动端自动展示抽屉折叠触发器与站点名。
3. **主工作区浮雕大卡片 (`<main>` / Inset Canvas)**：主工作区位于顶部操作栏下方，桌面端（`md:` 及以上）应用 Inset 样式（`md:mr-4 md:mb-4 md:rounded-xl md:border md:border-sidebar-border/40 md:shadow-sm md:bg-background`），页面标题（`PageHeader`）直接作为大卡片顶部内容起始点，避免卡片内部被任何多余横线切断。
4. **明暗双模式三层阶梯景深 (Three-Tier Surface Elevation)**：
   - **L0 底层画框**：`bg-sidebar`（浅色 `zinc-100/60` / 深色 `zinc-950`），顶栏与侧边栏沉浸于底层；
   - **L1 主画布容器**：`main` 浮雕大卡片（浅色纯白 `bg-background` / 深色 `zinc-900`）；
   - **L2 业务内容卡片**：页面内 `Card`、表格、表单（`bg-card`，深色模式微提亮为 `zinc-850/60`），呈现细腻的浮雕凸起质感。
5. **页面容器组件 (`PageContainer`)**：所有子页面统一嵌套标准容器，保证全站间距与页头排版完全一致：

管理员侧边栏按“业务运营”（用户管理、套餐管理、卡密管理）、“网络与节点”（节点管理、线路管理、证书管理、订阅模板、资源管理）、“监控与系统”（流量统计、系统日志、系统设置）三大结构化子分组呈现。

节点详情页的 Sing-box 诊断卡片属于高风险运维操作：使用 `Select` 选择 INFO/DEBUG，使用 `AlertDialog` 确认重启与隐私风险，诊断有效期显示倒计时并提供停止操作；离线、能力不支持、下发中和自动过期状态必须可见，禁止使用裸 HTML 交互标签。订阅履约操作属于用户管理的综合弹窗；旧地址 `/admin/subscriptions` 仅作为兼容入口重定向至 `/admin/users`，不得再次作为平级菜单展示。

```tsx
interface PageContainerProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function PageContainer({ title, description, actions, children }: PageContainerProps) {
  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div className="flex items-center justify-between space-y-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center space-x-2">{actions}</div>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}
```

---

## 8. 数据展示：表格与图表规范

### 8.1 数据表格 (Data Table)
- 底层技术：`@tanstack/react-table` + `@/components/ui/table`。
- 必须具备：列排序（Sorting）、关键词搜索过滤（Filtering）、分页控件（Pagination）、行选择（Row Selection）与列显示切换（Column Visibility）。
- 空数据展示：使用 `@/components/shared/empty-state.tsx` 统一插画与引导按钮。
- 移动端保留完整字段与表格语义，表格外层使用 `overflow-x-auto`，横向滚动只允许发生在表格容器内，不得造成页面主体横向溢出；筛选工具栏在 `sm` 断点前必须允许换行。
- 表格及标签区域使用的 `Badge` 必须保持单行（`whitespace-nowrap`），多个 Badge 可作为完整单元在父级容器中换行，禁止将 chip 文本压缩成逐字竖排。

#### 8.1.1 后台管理列表页布局标准范式 (Admin Table Layout Standard)
全站后台管理列表页面（如套餐管理、节点管理、线路管理、卡密管理、公告管理、文档管理等）必须严格统一为以下结构范式，严禁各自为政：
1. **搜索与筛选工具栏（Toolbar）**：
   - **平铺无外框**：工具栏直接作为 Flex 行置于 `PageContainer` 中，禁止在工具栏外层额外包裹 `Card` 或带边框背景容器（如 `rounded-xl border bg-card`）。
   - **固定左右顺序**：**搜索输入框固定置于最左侧**（`relative w-full min-w-0 flex-1 sm:min-w-52 sm:max-w-xs` + `pl-9`），右侧紧跟业务筛选 `Select` 下拉框；主操作按钮（如新建、导出、清理等）统一置于工具栏右侧。
   - **标准控件高度**：输入框、下拉框与按钮统一使用 New York 默认标准高度（`h-9 text-sm`），禁止私自硬编码压低为 `h-8 text-xs`。
2. **表格卡片容器（Table Card Container）**：
   - **零内边距贴边模式**：表格必须独占 `<Card><CardContent className="min-w-0 p-0"><Table className="min-w-[...]">`，禁止将搜索工具栏、提示横幅塞入同一个 `CardContent` 造成表格四周出现 `p-6` 内缩白边。
   - **表头与行规范**：统一使用 `@/components/ui/table` 标准样式，严禁私自为 `<TableHeader>` 添加灰色底色（如 `bg-muted/40`）或手写原生 HTML `<table>`。空状态统一置于 `CardContent` 内并添加 `className="border-0"`。
3. **分页与辅助信息行**：

   - 列表底部的总记录数统计、分页器（`Pagination`）以及辅助说明横幅统一平铺在 `<Card>` 容器外部，保持表格卡片边界纯粹干净。
4. **通用复合组件 `DataTable` 统一约束**：
   - 通用组件 `@/components/shared/data-table.tsx` 严格遵循上述卡片贴边范式（内嵌 `<Card className="min-w-0"><CardContent className="min-w-0 p-0"><Table>`）；
   - 提供 `actions` 插槽（承载工具栏右侧主操作按键）与 `banner` 插槽（承载工具栏下方、表格卡片上方的批量操作等独立横幅），确保全站无论是手写装配还是消费复合组件均保持 1:1 视觉一致性。
节点管理列表的批量 Agent 升级沿用此列表范式：使用表格 Checkbox 实现行选择与当前筛选结果全选，批量操作栏独立置于表格 Card 外；选择上限须与服务端 100 节点契约一致，筛选全选只修改当前可见行，节点数据刷新后清除已删除节点的过期选择。升级确认及结果使用响应式 Dialog/Sheet，分别说明托管资源架构覆盖、离线/HTTP 排队语义并逐节点展示已下发、排队或失败原因；所有文案走 `zh-CN` i18n，禁用期间防止重复提交。

### 8.2 数据图表 (Data Charts)
- 底层技术：采用 shadcn/ui 官方 `Chart`（封装自 `Recharts`）。
- 色彩绑定：使用预设 CSS 变量 `--chart-1` ~ `--chart-5`，严禁在图表配置中写死十六进制色值，确保暗黑模式完美自适应。
- 交互提示：统一使用 `ChartTooltip` 与 `ChartTooltipContent` 保证悬浮卡片视觉风格与面板整体一致。
- 流量统计使用 `--chart-1` 表示下行、`--chart-2` 表示上行、`--chart-3` 表示计费流量、`--chart-4`/`--chart-5` 表示线路分布；速率图同时展示平均值与近似峰值，面积图必须保留连续零值时隙，避免数据空洞造成折线断裂。
- 字节数统一经过 `formatBytes` 格式化为 B / KB / MB / GB / TB / PB；时序图按小时或天显示 `displayTime`，Tooltip 同时展示上行、下行和当前合计。
- 管理员流量统计位于 `/admin/traffic`，时间范围切换使用紧凑 `Tabs`；占比卡片支持线路分布与 Top 5 用户/其他用户分布切换，消耗明细支持线路明细与用户排行切换。用户排行使用邮箱搜索、角色筛选、本地分页、前三名徽标和占比进度条，表格在容器内横向滚动，行点击或“流量明细”按钮打开响应式下钻弹窗；页面明确标注节点网络吞吐不参与计费。

---

## 9. 扩展与自定义组件准则

节点运维视图的通信状态使用语义 Badge：在线 WS 显示“WS 在线”，在线 HTTP 显示“HTTP 轮询”，断开显示“离线”；状态旁应展示最近上报时间。详情页工具栏应提供内核重载、Agent 重启、网络探针、升级中心和安装命令；探针弹窗展示预设目标、延迟、丢包率、DNS 地址与错误详情，最近结果在高级运维 Tab 保留时间戳。探针、升级和重启等异步操作沿用 Dialog + Sonner，并在 HTTP 模式下通过任务状态查询给出完成或超时反馈，不在页面内直接使用裸 `fetch`。

如遇 shadcn/ui 官方未收录的特殊场景（例如：流量波形动效、节点拓扑连线图）：
1. **优先查找 Radix UI 原语**：在 Radix UI Primitive 之上使用 Tailwind CSS 进行包装。
2. **严格遵循规范**：组件接口需支持 `className`、`ref` 转发，样式使用 `cva` 维护。
3. **目录归属**：通用组件放入 `@/components/shared/`，页面专用组件就近放在 `pages/<module>/components/` 下。

---

## 10. 官方 CLI 与工程配置规范 (Official CLI & Setup)

依据 [shadcn/ui 官方在线文档](https://ui.shadcn.com/docs)，`apps/web` 采用标准的 `components.json` 配置与 CLI 工作流：

### 10.1 官方 `components.json` 标准配置

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.js",
    "css": "src/index.css",
    "baseColor": "zinc",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

### 10.2 常用 CLI 工作流指令

```bash
# 初始化配置（若全新初始化）
pnpm dlx shadcn@latest init

# 批量安装 RiriCloud 核心原子组件
pnpm dlx shadcn@latest add button card dialog alert-dialog dropdown-menu form input select table badge tabs tooltip sheet skeleton progress chart sidebar sonner

# 检查本地组件与官方最新 Registry 的差异与更新
pnpm dlx shadcn@latest diff
```

### 10.3 统一类名工具函数 (`src/lib/utils.ts`)

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

---

## 11. UI 视觉走查与验证规范 (Visual Verification & Index)

为了确保 UI 规范在后续功能演进中的一致性与无回归，系统建立了全量 UI 验证索引台账与变更感知机制：
- **全量 UI 索引台账**：覆盖现有业务页面、交互模态框及双主题状态；
- **变更感知映射**：根据前端源码文件路径变更自动判定受影响的 UI 范围；
- **按需触发与环境限定**：不作为 CI / 自动化门禁项，仅在用户要求时由 Antigravity Agent 执行走查。

完整规范、索引矩阵与执行 SOP 详见 [docs/VISUAL_VERIFICATION.md](VISUAL_VERIFICATION.md)。

## 12. 订阅业务页面规范 (Subscription UX)

v0.4.0 新增页面均位于已认证的 `AppLayout` 内，继续复用 `PageContainer`、`PageHeader`、Card、Badge、Progress、Dialog、AlertDialog、Select、Switch、Input、Textarea、Checkbox 和 Sonner：

| 页面 | 路由 | 主要内容 | 交互边界 |
| :--- | :--- | :--- | :--- |
| 套餐市场 | `/market` | 公开套餐网格、流量/期限/价格、流量重置策略、当前套餐标记 | 订购或升配必须经 AlertDialog 二次确认 |
| 我的订阅 | `/subscription` | 系统公告、当前套餐完整画像、流量进度、流量重置策略与下次重置时间、到期时间、Token 链接、可用线路紧凑列表、客户端使用指引 | 重置 Token 与取消订阅必须经 AlertDialog；无订阅时展示前往套餐市场的开通引导；消除冗余复制按钮，唯一使用输入框内联 CopyButton；提供前往套餐市场的升配入口；线路仅显示名称、协议类型、在线状态与倍率 |
| 套餐管理 | `/admin/plans` | 套餐卡片、上下架状态、流量重置策略、匹配模式、模板关联 | 删除使用中的套餐只显示服务端错误并建议下架 |
| 线路管理 | `/admin/lines` | 直连/中继线路表格、类型/状态/标签筛选、排序、批量启停、全部测速与单行即时测速、延迟 Chip 标签展示、复制、解析测试 | 删除使用 AlertDialog；中继表单必须校验入口节点/端口/机制 |
| 线路编辑弹窗 | `/admin/lines`（点击新建/编辑） | 默认打开的“入站配置”页签与“线路高级设置”页签；入站页集中配置协议、入口节点、监听地址/端口、Transport、TLS/Reality/ACME 与协议专属参数，高级页配置出口拓扑、对外覆盖、倍率与线路属性 | 使用 Tabs 切换；页签内容全部平面展开，以分区标题和 Separator 区分层级，不使用 Accordion 或嵌套卡片；两页共享草稿并统一保存；覆盖开关默认关闭且保留已填值；协议切换清理不适用字段；标准 TLS/ACME 的 ALPN 使用按协议与传输层匹配的 Checkbox 多选，Reality 隐藏 ALPN；Reality 私钥留空表示保留服务端密钥；提交使用 React Hook Form + Zod |
| 订阅模板 | `/admin/templates` | 模板卡片、复制/预览操作、策略组与规则集双模编辑、解耦的 DNS 引擎设置、Clash/Sing-box 全宽覆写与智能片段注入 | 内嵌默认模板显示“内嵌”标记；复制与快速预览使用图标+文字按钮；编辑弹窗使用六个独立 Tab（基本信息、策略组设计、分流规则、DNS 设置、客户端高级覆写、实时渲染预览），DNS 支持直连/代理徽章增删与公共 DNS 快捷预设，客户端覆写支持 Clash/Sing-box 二级切换、实时语法状态检测与常用片段智能 deepMerge 注入；删除使用 AlertDialog；JSON/YAML 由 Zod 与服务端双重校验 |
| 用户管理 | `/admin/users` | 用户、角色、账号状态、当前套餐、订阅状态、流量进度与到期日 | 创建用户可选择初始套餐或暂不绑定；编辑用户通过双 Tab 管理账号安全与订阅，可用“无套餐”彻底移除订阅；订阅管理展示重置策略、下次重置时间并支持额外线路多选 |
| 个人中心 | `/profile` | 顶部名片式身份横幅、Tabs 双页签（账号安全 / 资产财务）、修改密码、UUID 掩码查看与重置、卡密兑换与全宽收支流水 | 余额与流水以元展示；卡密兑换即时刷新；密码修改与换邮箱使用表单与验证码校验；UUID 脱敏与危险重置弹窗 |
| 卡密管理 | `/admin/redeem-codes` | 按分类与标签管理余额/套餐奖励、购买身份累计限额、按分类批量生成与奖励快照；四态统计、分类/状态/已删除筛选、卡密掩码/明文切换、CSV/TXT 导出、行选择删除/批量作废、恢复与过期卡密清理 | 余额以元输入、服务端按分保存；分类默认每购买身份限兑 1 次，支持正整数或不限；列表默认掩码显示（保留前缀段与末 4 位）；生成结果在弹窗集中复制。删除/作废/清理均使用 `AlertDialog` 确认；删除的未兑换卡密仍可兑换，已删除视图可逐条恢复 |
| 流量统计 | `/admin/traffic` | 时间范围 KPI、节点上/下行速率摘要与历史速率、线路占比和物理/计费流量排行 | 使用 `Tabs` 切换今日/24 小时/7 天/30 天；速率图表和表格在移动端单列或局部滚动 |
| 用户流量下钻 | `/admin/users`（操作列“流量明细”） | 用户配额画像、周期用量走势、线路占比和线路明细 | 桌面端使用 `max-w-5xl` 宽屏 Dialog，`767px` 及以下为全高右侧 Sheet；外层弹窗禁止横向溢出，明细表仅在自身容器内横向滚动；无记录时使用统一 EmptyState |
| 节点升级 | `/admin/nodes/:id` | Sing-box/Agent 目标、当前/推荐版本、主控内置来源、自定义 URL、SHA-256 与主控导入 | 默认使用主控内置版本；自定义来源必须校验 URL/SHA-256；导入或下发中禁用对应按钮 |
| 证书管理 | `/admin/certificates` | TLS 证书列表、SAN 标签、签发者、有效期状态、关联线路与证书操作 | 证书列表使用表格快速扫描有效期与关联数；新建/编辑弹窗支持 PEM 粘贴或上传、解析预览与私钥查看；证书被线路引用时删除需明确拦截 |
| 系统日志 | `/admin/logs` | 4 大指标 KPI 卡片、24h 错误/级别趋势堆叠柱状图、多维过滤器工具栏、高密度等宽日志表格、Live Tail 实时推流条、详情抽屉与清理确认弹窗 | 支持时间范围、级别、来源、节点、关键词与 TraceId 筛选；Live Tail 悬浮控制条支持暂停/恢复、清屏与滚动跟随；SINGBOX 显示真实解析级别与重复次数 `xN`，并明确普通内核输出不计入 WARN/ERROR 指标；单条日志详情抽屉查看 TraceId 穿透、异常调用栈与 JSON 元数据；清理历史日志使用 AlertDialog 二次确认 |

### 12.1 用户管理综合弹窗

- 创建用户表单提供可选初始套餐；选择套餐后自动回填流量配额与有效期，选择“暂不绑定套餐”即可先创建无套餐账号，管理员仍可在提交前微调。
- 编辑用户弹窗使用 `Tabs` 分为「账号安全」和「订阅管理」：前者管理角色、启用/封禁与密码重置，后者管理套餐、状态、配额、已用流量、延期、重置策略摘要、下次重置时间、额外线路授权和 Token 重置。
- 订阅管理的套餐 Select 必须提供“无套餐（彻底取消订阅）”选项；已绑定订阅的用户选择该项并保存时必须经危险操作确认，确认后删除订阅实例并使旧 Token 失效。
- 套餐切换默认重置已用流量、状态恢复为 `ACTIVE` 并按套餐周期回填到期日；Token 重置必须经 `AlertDialog` 二次确认并明确旧链接立即失效。
- 流量重置策略使用明确的 `Select` 展示“不自动重置 / 自然月重置 / 订阅周期重置”；额外线路授权使用可滚动的 `Checkbox` 列表，隐藏、禁用或离线线路可以保留授权但应明确标注当前不可用。
- 用户列表优先展示套餐名称、订阅状态 Badge、流量进度条和到期日，并提供邮箱、角色、账号状态、订阅状态与套餐筛选。

### 12.2 页面与响应式要求

- 业务列表优先使用可扫描的网格或表格；套餐、模板和订阅条目保持统一的 `Card` 内边距，不在页面区块外再套装饰性卡片。
- 线路管理列表优先使用表格；管理员侧线路类型、倍率、标签、中继机制和底层健康状态必须可快速扫描，筛选条件使用 `Input` / `Select`，批量状态使用 `Checkbox` + `Button`。
- 线路编辑弹窗默认打开“入站配置”页签；协议、入口节点、监听地址/端口、Transport、TLS/Reality/ACME 和协议专属参数使用可视化控件，标准 TLS/ACME 的 ALPN 使用预设 Checkbox 多选，复杂请求头使用可增删的键值行编辑，不以 JSON 文本框作为主流程；各配置分区平面展开，不使用折叠或嵌套卡片。
- “线路高级设置”页签使用 `Switch` 控制对外地址、端口、SNI、Host 覆盖，并配置直连/中继拓扑、出口节点/端口、倍率、标签、等级、排序和启停状态；选择 `TARGET_LINE` 时改用目标落地线路 `Select`，只展示其他节点上的直连和可作为出站的协议，并显示目标节点/协议/端口摘要，隐藏手填出口字段；两页共享同一份 React Hook Form 草稿，点击一次保存统一提交。
- 线路入口端口可留空，由服务端在 `20000~65535` 范围分配五位端口；直连线路提交前应保持两端节点和端口一致。VLESS/Reality 提供密钥对生成按钮，私钥不从 API 回显。
- 大型模板 JSON/YAML 编辑区使用等宽字体和固定最小高度，在复杂弹窗/抽屉中填充剩余可用高度并在编辑区内部滚动，不能撑破桌面或移动端视口。
- 模板编辑器固定为「基本信息 / 策略组设计 / 分流规则 / DNS 与高级覆写 / 实时渲染预览」五个 Tab；策略组与规则集均提供可增删排序的可视化卡片和 CodeMirror JSON 源码模式，实时预览使用只读 CodeMirror，支持 Clash YAML、Sing-box JSON 切换、命中节点统计和复制。
- 移动端列表转为单列，表单在 `sm` 断点前单列布局；表格保留完整字段并在表格容器内横向滚动，筛选器与操作按钮允许多行排列；普通复杂编辑使用全高 `Sheet`，危险操作继续使用 `AlertDialog`。
- 用户流量下钻弹窗的内容根节点必须使用 `min-w-0`，外层滚动容器显式隐藏横向溢出；线路明细表保留完整字段和数字不换行，仅允许表格自身横向滚动。
- 小型确认类 `AlertDialog` 保持默认居中弹窗尺寸；移动端使用基础圆角与左右各 `24px` 安全边距，Footer 覆盖为紧凑横向按钮，按钮使用自然宽度并保持确认操作靠右，取消按钮不得保留纵向堆叠间距。
- 数据加载使用与真实内容相近的骨架或紧凑加载态；我的订阅和管理员用户列表的流量数据每 5 秒自动重新请求，以便反映 Agent 心跳扣减结果；错误和变更结果统一通过 `sonner` 呈现，不使用原生 `alert`。
- Token 仅在已认证的用户/管理员视图显示；复制、重置后必须刷新相关 Query，避免界面继续展示旧链接。
- 账户余额、卡密面额和套餐价格在界面统一使用人民币元与两位小数格式；API 返回的余额/流水金额仍按分传输，前端通过统一格式化工具展示，禁止页面自行拼接金额单位。
- 个人中心采用“顶部名片式身份横幅 + Tabs 双页签（账号与安全 / 资产与财务）”解耦架构；顶部 Header 展示大头像、大字昵称、邮箱换绑、数字 UID 复制胶囊、角色徽标与注册时间；「账号与安全」页签提供修改密码表单与代理连接凭据（支持 UUID 明文/掩码切换、复制与危险区域二次确认重置）；「资产与财务」页签上方并排资产三指标卡与卡密兑换卡，下方全宽舒展展示收支明细流水表格。
- 卡密管理列表使用表格容器内横向滚动与服务端分页，搜索使用 400ms 防抖；卡密默认掩码显示并提供明文切换；批量生成和分类表单使用 React Hook Form + Zod，生成结果使用等宽文本和 `CopyButton` 换行复制。分类管理可配置标签、BALANCE/PLAN 奖励、默认 1 次的购买身份累计限额（或不限），奖励快照在生成时固定；分类停用只影响新生成。分类/状态/已删除视图筛选同步用于统计和导出。删除仅从当前管理视图隐藏，不改变未兑换卡密的兑换能力；已删除卡可恢复，显式作废才阻止兑换。删除、单张/批量作废与过期卡密清理均须用 `AlertDialog` 确认；导出 CSV/TXT 复用 blob 附件下载并携带当前筛选条件。

### 12.3 系统设置与全局品牌

- 系统设置页使用「基础与品牌 / 首页设置 / 注册与用户 / 订阅与分发 / Agent 运维 / 存储与日志 / 安全与高级」七个 `Tabs`，Tab 图标统一固定为 `16px`，所有字段由 React Hook Form + Zod 管理，保存和重置操作使用 Sonner 提示结果。存储与日志页签集中维护小时流量保留天数、节点速率保留天数、系统日志保留天数/最大记录数/最低采集级别，以及 Agent 本地日志单文件大小/文件总数；保存只更新策略，不立即删除。
- 业务运营分组下的独立「公告管理」页（`/admin/announcements`）复用文档管理设计范式：提供按分类（通知 / 维护 / 活动 / 紧急）、状态与关键词组合过滤的数据表格（展示标题、正文摘要、分类徽章、置顶/横幅/弹窗策略标签、行内交互式 `Switch` 启停与删除二次确认），点击新建/编辑唤起全屏 `AnnouncementEditorDialog`（集成三态分屏/纯编辑/纯预览模式切换、4 维展示策略开关、快捷语法插入工具条、CodeMirror 源码高亮与 `MarkdownRenderer` 实时渲染预览）。
- 顶部操作栏 `AppHeader` 集成 `AnnouncementCenter` 消息图标：存在未读公告时展示脉冲红点角标，点击展开右上角内联下拉列表（含分类彩色 Badge、置顶图标、未读标识、摘要预览与「全部已读」快捷按钮）；点击任意条目标记已读并唤起居中 `AnnouncementDetailDialog` 渲染完整 GFM Markdown；存在开启了 `popupOnLogin` 的未读公告时，用户进入控制台自动居中弹窗强提醒。
- 流量统计页和系统日志页均提供进入统一「历史观测数据清理」弹窗的快捷入口。弹窗先选择目标与模式，再加载预览明细；执行前必须完成二次确认并输入 `CLEAR_HISTORY`，结果按数据类型展示成功、失败、匹配数、删除数与耗时。系统日志原有清理入口复用该组件，`all` 是显式清空模式，不以 `0` 伪装保留天数。
- 节点列表/详情展示 `agent_log_rotation` 能力状态；旧 Agent 显示“需要升级”提示，但不得阻断节点业务操作。
- Logo、Favicon、站点名、公告、页脚和客服入口通过公开站点信息动态感知；登录页、已认证外壳和我的订阅页面共享同一 Query 缓存，不在页面内硬编码品牌文案。
- 公告横幅（`AnnouncementCard`）消费公告列表中启用且开启横幅展示的条目（向下兼容旧版 `siteAnnouncement`），支持按分类着色、安全的 Markdown 子集渲染、点击唤起完整详情弹窗及本地收起记忆；订阅链接统一通过 `apps/web/src/lib/subscription-url.ts` 构造，优先使用配置的 `subscriptionBaseUrl`，没有有效订阅时必须引导进入套餐市场。
- 系统设置的“基础与品牌”页签提供 `publicBaseUrl` 全站访问 URL，用于主控生成 Agent 安装、升级和二进制下载地址；URL 字段旁提供“使用当前面板地址”快捷填充，并明确说明留空时服务端会按当前反向代理域名自动匹配。
- `subscriptionShortLinksEnabled=false` 时展示标准 `.../api/v1/sub/<UUID>`；开启时展示由 Nginx rewrite 提供的 `.../<UUID>`，`subscriptionBaseUrl` 中的 pathname 必须原样保留并与部署配置一致。系统设置开关旁必须明确提示“先配置 Nginx”，但不在前端检测代理状态。
- CSS、YAML 与 HTML/JS 代码编辑器使用 CodeMirror，代码区域保持等宽字体、明确的内部滚动边界，并在复杂弹窗/抽屉中填充剩余高度；编辑器主题必须跟随 `next-themes` 的 `resolvedTheme`；头部注入仅接受管理员配置，文案需提示只粘贴可信代码。
- CSS 与 HTML/JS 头部代码编辑器必须读取 `next-themes` 的 `resolvedTheme`，在浅色/深色模式下分别传入 CodeMirror 的 `light` / `dark` 主题，禁止依赖默认浅色主题造成深色页面出现白色编辑区；编辑器外层使用语义化背景与边框 Token。
- JWT 会话有效期的安全说明属于字段辅助信息，应直接使用 shadcn/ui 的 `FormDescription` 放在对应输入框下方，不应在外层设置卡片内再嵌套等宽提示卡片。
- 系统设置的“注册与用户”页签在「密码最小长度」输入框下方提供“密码复杂度要求”边框区块（`rounded-lg border p-4`），内部以两列 `SettingsSwitch` 网格呈现小写字母、大写字母、数字、特殊字符四个必含开关；全部关闭表示仅校验长度，区块描述需说明该策略对注册、找回密码、修改密码与管理员建户全场景生效。
- 浏览器认证凭据由服务端通过 HttpOnly、SameSite Cookie 管理；登录/注册页面不得读取、展示或持久化 JWT，认证状态只在 Zustand 内存中保存当前用户，并通过统一 API 客户端的 `withCredentials` 请求维持会话。
- 注册、找回密码和验证码发送表单必须对邮箱、密码和验证码执行前端长度/格式校验；新密码必须按公开站点信息中的密码复杂度策略（`passwordRequire*` 四个字符类别开关，默认须含小写字母与数字）动态构建 zod 校验规则与占位提示，全部开关关闭时仅校验长度，并保留动态 `passwordMinLength` 提示；邮箱是否已注册不得由前端根据不同错误文案主动推断。
- 默认探针目标使用“摘要入口 + 独立 Dialog”提供可视化增删编辑；Dialog 内使用本地 React Hook Form 草稿，点击“应用”后才回填外层设置表单，取消关闭不得污染父表单。每项使用 `Select`、`Input`、`FormMessage` 等原子组件，TCP 才显示端口，最多 32 项，保存顺序与节点探针快速预设顺序一致。列表保持平面表单结构，项之间使用 `Separator`，不得额外套用卡片、列表边框或控件自定义颜色/尺寸。

### 12.4 视觉验证登记

新增页面、弹窗和节点升级入口的编号、源码路径、明暗主题检查点统一登记在 [docs/VISUAL_VERIFICATION.md](VISUAL_VERIFICATION.md) 的 UI-01 至 UI-34。视觉验证仍按需执行，不能接入 CI 或 Git Hook。

### 12.5 资源管理

- `/admin/binaries` 使用 `PageContainer`、`Card`、`Select`、`Badge`、`ResponsiveDialog` 和 `AlertDialog` 组成资源管理视图；筛选条件按资源类型、平台和状态排列，上传/远程导入是明确的带图标命令。
- 资源卡片必须可扫描地展示 Agent/Sing-box 类型、独立资源版本、来源、状态、默认标记、平台资产、文件大小和 SHA-256；详情弹窗展示辅助文件与最近分发任务。
- 启用、停用、归档和设为默认属于状态变更，结果通过 Sonner 提示；资源导入失败不能保留半成品，页面应保持原列表状态并允许重新提交。
- 节点升级弹窗展示当前内核版本、可用资源版本和资源来源；当资源有完整文件清单时应明确显示主文件与辅助依赖，失败任务提供重试/回滚入口。移动端筛选器允许换行，资源详情与导入表单在弹窗内部滚动，不产生页面级横向溢出。

### 12.6 镜像站管理

- `/admin/mirrors` 使用 `PageContainer`、表格、`ResponsiveDialog`、`Select`、`Switch`、`Badge` 和 `AlertDialog` 管理可复用实时镜像站；节点下拉只允许 WS/WSS 且宣告 `mirror_proxy` 的节点，离线节点明确显示不可用原因。
- 表单展示名称、slug、上游基址、允许重定向域名、访问模式、分享有效期和启用状态；分享 Token 只能一次性展示，复制/轮换/删除结果通过 Sonner 或确认弹窗反馈。
- 列表应可扫描展示上游域名、指定节点、能力、访问模式、启用状态、最近状态码和错误码；测试结果对话框只展示状态、延迟、最终 host 与脱敏错误，不展示响应体或凭据。移动端表格允许在自身容器滚动，表单和对话框不得造成页面级横向溢出。
- 出网节点下拉必须保持实时可用性（在线状态与镜像能力随轮询刷新），但**不得**因节点列表刷新而回写表单草稿：初始化只在打开弹窗或切换编辑对象时发生一次，所选节点离线时改为字段级提示（见 §5.1）。

### 12.7 首页门户 (Home Page)

- 路由挂载于根路径 `/`，作为系统向访客与潜在用户展示的第一视觉门户，支持由管理员在后台全局开关（`landingEnabled`）；当关闭时自动回退为原有身份路由重定向（未登录跳转 `/login`，已登录跳转 `/subscription` 或 `/admin/nodes`）。
- **设计语言与视觉基准**：严格遵循 shadcn/ui New York 风格基准，以冷灰 Zinc 语义 Token（`bg-background`、`text-foreground`、`text-muted-foreground`、`border-border/40`）为主体，严禁引入厚重粗糙的第三方动画/3D 库或破坏对比度的彩虹渐变。
- **模块拓扑与组件编排**：
  1. **Sticky 粘性毛玻璃顶栏**：集成站点品牌 Logo、平滑锚点（特性、套餐、常见问答）、`ThemeToggle`、`LanguageSwitcher` 与动态会话状态（未登录展示「登录 / 注册」CTA 按钮；已登录自适应变为「进入控制台」直接入口及轻量级用户头像下拉菜单）。
  2. **Hero 核心导流区**：展示微圆角药丸徽标（Pill Badge）、一级大字排版（`text-4xl sm:text-6xl font-extrabold tracking-tight`）、细腻次级描述、双行动号召按键（主按钮导流注册/控制台，次按钮锚点滚动至特性）以及面向普通用户的感知亮点微胶囊。
  3. **特性矩阵网格 (Features Grid)**：采用响应式 6 宫格卡片布局（`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`），卡片保持 `rounded-xl border bg-card p-6 shadow-xs`，支持 Lucide 动态矢量图标、平滑 hover 边框高亮与阴影微抬升。
  4. **公开套餐预览 (Pricing Section)**：直连公开套餐接口 `/api/plans/public`，优雅展示各周期起步资费、流量配额、峰值速率徽标与核心权益清单，提供快捷订阅入口（未登录点击带来源参数引导注册）。
  5. **常见问答手风琴 (FAQ Accordion)**：基于 `@/components/ui/accordion` 打造，支持折叠展开，平滑过渡无跳动，提供新手关切问题的标准指引。
  6. **客服与版权页脚 (Footer)**：展示站点品牌、Telegram / Discord / 邮箱 / 在线工单等官方客服渠道，集成 ICP / 运营版权信息。
- **可配置化规范**：首页门户支持系统设置「首页设置」Tab 深度定制，包括总开关、模块显隐、Hero 文案自定义，以及特性卡片与 FAQ 列表的可视化增删改与排序，提供安全兜底重置机制。
- **移动端与自适应约束**：所有区块在 `375x812` 移动视口下自动收缩为单列流式布局，粘性顶栏紧凑排布，严禁出现横向滚动条。

---

## 13. 国际化与文案规范 (Internationalization & Copywriting Standard)

### 13.1 架构与工具链
- **核心库**：`i18next` + `react-i18next` + `i18next-browser-languagedetector`。
- **配置与类型系统**：`apps/web/src/i18n/config.ts` 扩展 `react-i18next` 的 `CustomTypeOptions`，引入强类型命名空间资源契约。在开发与构建（`tsc --noEmit`）期间对所有 `t('namespace:key')` 键路径与插值变量进行静态类型约束，杜绝拼写错误与缺失插值参数。
- **语言持久化与探测**：优先读取 `localStorage`（键名：`riricloud-locale`），缺省回退至浏览器偏好探测（通过 `normalizeLocale` 识别 `zh-*`、`ja-*` 与 `en-*`），默认基准语言为 `zh-CN`，支持完整 `en-US` 与 `ja-JP` 三语对齐。
- **语言切换控件**：顶栏微操作区提供 `LanguageSwitcher`（`@/components/layout/language-switcher.tsx`），与 `ThemeToggle` 并列展示，带 `Globe` 图标与纯净紧凑的下拉菜单，即时触发全站平滑重渲染。

### 13.2 命名空间划分与规范
全站字典按领域严格模块化拆分于 `apps/web/src/locales/{zh-CN,en-US,ja-JP}/`：
1. **`common.ts`**：公共交互操作（保存、取消、删除、确认、复制等）、全局状态标签、通用表格/分页文本、时间范围筛选、模态框通用按键与快捷操作。
2. **`auth.ts`**：登录页、注册页、找回密码页、人机验证（本地 SVG 算术与 Cloudflare Turnstile）、密码强度与复杂度提示。
3. **`user.ts`**：用户门户全量页面（套餐市场、我的订阅、个人中心、代理池管理），涵盖配额进度、资产财务、兑换码、线路卡片与客户端使用指引。
4. **`admin.ts`**：管理员控制台全量视图（节点管理与详情、线路管理与测速、证书管理、订阅模板编辑器、用户管理综合弹窗、套餐管理与实机预览、卡密管理、系统日志、系统设置全 Tab、镜像站、资源分发、流量统计下钻）。
5. **`errors.ts`**：全站通用与业务领域错误码/错误提示映射。
6. **`landing.ts`**：首页门户全量视图与文案，涵盖 Hero 导流、核心特性网格、公开套餐预览、常见问答（FAQ）以及客服与版权页脚。

### 13.3 文案设计原则 (Copywriting Philosophy)
1. **地道专业，杜绝机翻**：英日翻译对齐 Cloudflare、Vercel、Tailwind UI 等国际顶级云平台行业惯例文案（如：“节点画像” -> "Node Profile" / 「ノードプロファイル」，“一键测速” -> "Speed Test" / 「速度テスト」，“作废” -> "Revoke" / 「失効」）。
2. **严禁硬编码文本**：全站用户可见文案（含表单占位提示 placeholder、错误校验提示、Toast 反馈、二次确认弹窗正文、Tooltip 说明与 ARIA 文案）必须统一收敛至多语言字典，严禁在 TSX 中直接裸写字符串。
3. **表单校验必须本地化**：Zod 内置校验（如 `min`、`max`、`positive`、`multipleOf`、`regex`、`refine`）必须显式使用 `t(...)` 提供错误文案；不得将 Zod 默认英文错误直接展示给用户；由 Zod 负责提交校验的表单应设置 `noValidate`，避免浏览器原生提示绕过应用语言。
4. **行为文案与实现一致**：变更删除、清理、恢复、作废等操作语义时，必须同步检查对应语言的按钮、确认标题/正文、成功/失败反馈；不得保留与实际副作用不符的“永久删除”或“可恢复”等说明。
5. **带变量插值规范**：插值变量采用 `{{variable}}` 语法并在 TS 泛型或字典中显式声明类型；传递可选值（如实体名称）时必须提供安全空字符串兜底（如 `{ name: entity?.name ?? '' }`）。

### 13.4 中文第一基准与机械治理工具链 (Chinese-First SSOT & Governance)
1. **基准 SSOT 机制**：以 `zh-CN` 作为单源基准。日常特性开发过程中，UI 变更仅强制要求同步在 `apps/web/src/locales/zh-CN/` 维护对应键值，并使用 `t(...)` 渲染。
2. **机械门禁检查 (`pnpm gate:i18n`)**：
   - 运行 `scripts/i18n-governance.mjs check`，自动静态扫描前端所有 TSX 视图文件。
   - 阻断项包括：JSX 标签间的直接中文文本、用户可见交互属性（`placeholder`、`title`、`label`、`aria-label` 等）的硬编码中文、`toast.*` 反馈中文，以及 Zod Schema 中的硬编码中文校验信息。
   - 若因特殊技术原因或外部常量存在字面中文且无需国际化，可在对应代码行末添加 `// i18n-ignore` 注释豁免检查。
3. **多语言解耦与运行时回退**：
   - 非中文语言（`en-US`、`ja-JP` 等）词条补充与日常特性 PR 解耦，允许后续集中批量补充翻译。
   - `i18n/config.ts` 设置 `fallbackLng: 'zh-CN'`，当非基准语言缺少某键位时平滑回退渲染中文，确保用户界面绝不暴露出原始命名空间和键路径。
4. **覆盖率台账与进度审计 (`pnpm i18n:report`)**：
   - 运行 `pnpm i18n:report` 可随时输出各语言相对于 `zh-CN` 基准的词条总数、已翻译数、覆盖率百分比以及待补齐键位清单（Audit Ledger），为国际化版本排期与翻译补充提供精确数据支撑。



## 13. 上游资源与 EXTERNAL 线路交互

上游页面不再提供全局“加入用户订阅”开关；节点行提供“创建外部直发线路 / 创建上游中继”两个独立动作。EXTERNAL 通过线路表单选资源与设置标签/公开性/启停，默认禁用且私有，隐藏自建监听、入口协议、TLS 与本地限速；提交前确认共享凭据无法独立追回，并提示公开线路可能被 ALL 套餐包含。

来源列表与节点池使用服务端分页和准确 total，资源选择支持加载更多，不以固定 100/200 条代表全部。编辑秘密按需读取管理员详情且默认隐藏，不能把列表掩码提交回后端；TEXT 内容未修改时省略 payload，避免清空源。AUTO/检测格式、最近尝试/成功、PRESENT/MISSING、Master TCP/端到端测速分别显示，UDP-only TCP 探针注明不适用。

上游字节值使用十进制字符串和 BigInt 格式化，未知显示未知，不显示无限。用户线路采用安全摘要，EXTERNAL 显示不计本地流量、不执行本地限速/设备控制，不展示虚构在线节点或倍率承诺。所有新增中文走 zh-CN 和 t(...)；对应索引 UI-21、UI-23/24、UI-42，当前 PI 环境仅维护台账，不执行 Antigravity 视觉走查。

## 14. 代理池统一端点与凭据交互

用户页称标准代理/代理池，区分本机直出和上游中继，Key卡片仅原始标识，不将裸pk_当登录名；提示旧客户端重新导出。选Key后查询该Key授权/容量端点，容量不足禁选、离线独立显示。每次最多200条，超出明确提示分批，轮询只移除失效选择不全选新增，空选择不扩成默认全量导出。

JSONv2服务端逐端点凭据为复制/下载/单多节点四类代码示例SSOT，前端不拼原Key.username；凭据仅在Query内存，禁WebStorage。TLS入口不生成标准SOCKS5/TXT，协议不兼容/资格撤销/容量排除反馈分开，自动拉取URL保留显式选择/协议。所有新增文本走zh-CN和t(...)，触及大组件拆分且≤300行。

管理员线路表单proxyPoolEnabled开关仅支持DIRECT/MIXED或RELAY/UPSTREAM_NODE/MIXED，中继必须开启用户鉴权；切不支持协议要显式关闭，不隐式保留。线路管理容量卡片展示节点used/512/excluded，只表示期望配置分配，不表示Agent已应用。关联索引UI-23/24/35；本环境只执行契约/编译检查，不进行Antigravity视觉走查。
