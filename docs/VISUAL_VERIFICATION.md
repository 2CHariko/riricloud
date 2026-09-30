# 前端 UI 视觉验证规范与索引台账 (UI Visual Verification Guidelines & Matrix)

本文档定义 **RiriCloud** 前端（`apps/web`）的 UI 视觉验证标准、全量 UI 索引矩阵、变更感知映射规则与 Antigravity 环境下的标准操作规程 (SOP)。

---

## 1. 核心原则与执行策略

1. **按需触发原则 (On-Demand Only)**：
   - 视觉验证**严禁**作为自动化 CI、Git Pre-commit 钩子或常规门禁（`pnpm gate`）的自动检查项；
   - 仅在**用户提出明确视觉走查要求**（例如：“进行一次视觉验证”、“检查 UI 改动效果”、“验证暗黑模式外观”等）时启动。
2. **环境严格限定 (Antigravity Environment Only)**：
   - 视觉验证依赖 Antigravity 提供的专属浏览器自动化（Chrome DevTools MCP）、视口渲染与截屏归档能力；
   - **禁止**在项目中引入 Cypress、Playwright 等重型本地端到端测试依赖，确保零环境污染与轻量极简。
3. **双主题全覆盖 (Dual Themes Mandatory)**：
   - 任何涉及视觉走查的页面/模态组件，必须同时在 **浅色模式 (Light Mode)** 与 **深色模式 (Dark Mode)** 下进行对比验证。
4. **标准化结果交付 (Standardized Artifact Delivery)**：
   - 每次走查完成后，必须输出结构化的 Markdown 报告 Artifact（含受影响变更项高亮、Carousel 截图对比轮播、检查点通过表）。
5. **移动视口覆盖 (Mobile Viewport Coverage)**：
   - 涉及全局布局、Sidebar、Sheet、Table 或页面响应式样式的变更，走查时增加 `375x812` 手机视口与 `768x1024` 平板视口。
   - 手机视口必须确认页面主体无横向溢出；表格仅在表格容器内横向滚动，复杂表单使用全高 Sheet。

---

## 2. 全量 UI 验证索引台账 (UI Verification Matrix)

系统内所有页面、交互模态框及全局组件均纳管于以下索引台账中：

| 索引编号 | 模块分类 | 页面 / 交互单元 | 路由 / 触发方式 | 对应源码路径 | 核心验证检查点 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`UI-01`** | 认证 | 登录页面 | `/login` | `apps/web/src/pages/login/**` | 左上角返回首页按钮（带 ArrowLeft 图标与多语言文本）、右上角语言切换器与 ThemeToggle 主题切换并列排布、卡片居中性、Logo 渲染、可选副标题不展示默认开发文案、邮箱/密码正式占位提示、输入框聚焦态、登录按钮 LogIn 图标与加载动画对齐、登录后跳转与错误 Toast、忘记密码入口跳转、底栏客服支持联系渠道与页脚版权渲染 |
| **`UI-02`** | 认证 | 注册页面 | `/register` | `apps/web/src/pages/register/**`, `apps/web/src/components/shared/captcha-challenge.tsx` | 左上角返回首页按钮（带 ArrowLeft 图标与多语言文本）、右上角语言切换器与 ThemeToggle 主题切换并列排布、表单字段对齐、昵称选填与默认昵称提示、可选副标题不展示默认开发文案、邮箱/密码正式占位提示、密码确认校验、邮箱验证码获取按钮与 60 秒倒计时、本地 SVG CAPTCHA 弹窗/内嵌验证或 Turnstile 状态、返回登录跳转链接、底栏客服支持联系渠道与页脚版权渲染 |
| **`UI-03`** | 门户与控制台 | 根路径与落地页路由 | `/` | `apps/web/src/router/index.tsx`, `apps/web/src/pages/landing/**` | 根路径受系统设置 `landingEnabled` 驱动：开启首页门户时（默认）访问根路径直接渲染首页，未登录提供登录/注册入口，已登录自适应提供进入控制台入口；关闭首页时自动根据会话状态回退（未登录跳转 `/login`，已登录跳转 `/subscription` 或 `/admin/nodes`）、品牌 Logo 首页链接 Tooltip 样式与图标按钮一致、首页顶部特性/套餐/FAQ 快速导航平滑滚动并遵循减少动态效果偏好、公开套餐价格按元正确展示（含免费套餐本地化标签） |
| **`UI-04`** | 用户订阅 | 公告与客户端使用指引 | `/subscription` | `apps/web/src/components/shared/announcement-card.tsx`, `apps/web/src/components/shared/announcement-detail-dialog.tsx`, `apps/web/src/components/shared/client-guide-card.tsx` | 公告横幅自动消费置顶/横幅公告（按分类着色、显示标题与发布时间、点击「查看详情」唤起居中完整 Markdown 弹窗）、关闭状态本地记忆、无订阅与有订阅状态下均展示客户端三步指引，明暗主题与移动端不溢出 |
| **`UI-05`** | 节点管理 | 节点管理列表 | `/admin/nodes` | `apps/web/src/pages/admin/nodes/index.tsx` | 节点名称与地址即时搜索、通信状态与内核状态组合筛选（筛选器联动在线状态）、网络可达性徽标（公网 VPS / NAT 落地，NAT 节点带有黄色外发链路图标与反向穿透说明）、表格行/当前筛选结果全选 Checkbox 与已选计数、跨筛选保留选择/清空、100 节点选择上限与节点删除后的陈旧选择清理、批量升级入口、节点数据表格、内核运行状态 Badge（离线节点置灰展示为未知状态破折号 `—` 并带 Tooltip 提示，避免残留历史状态误导）、CPU/内存/带宽遥测实时刷新（离线统一回退展示 `—`）、统一时区心跳时间展示；明暗主题与移动端表格局部横向滚动 |
| **`UI-06`** | 节点管理 | 添加节点弹窗 | `/admin/nodes`（点击“添加节点”） | `apps/web/src/pages/admin/nodes/components/node-form-dialog.tsx`, `apps/web/src/pages/admin/nodes/components/install-commands-picker.tsx` | Dialog 居中、网络可达性单选（公网 VPS / NAT 落地）、服务器地址与名称输入框（NAT 模式下地址设为选填并自动提供 127.0.0.1 兜底与反向隧道接入提示）、通信协议选择、创建成功后展示 AgentToken，并提供「原生安装 / 免安装运行 / Docker / 离线安装包」四 Tab × 目标操作系统（Linux / macOS / Windows，Docker Tab 隐藏系统选择）× WS/HTTP 模式的命令切换、系统化提示文案、原生模式专属预编排免交互安装脚本一键下载、离线安装包直接下载与一键安装命令复制 |
| **`UI-07`** | 节点详情 | 线路承载与角色列表 Tab | `/admin/nodes/:id` (Tab 1) | `apps/web/src/pages/admin/nodes/detail.tsx` | 当前承载线路、协议徽章、直连/中转/落地角色三态徽章、监听端口与线路状态 |
| **`UI-08`** | 节点详情 | 派生监听端口卡片 | `/admin/nodes/:id` (Tab 1) | `apps/web/src/pages/admin/nodes/detail.tsx` | 线路派生端口按 DIRECT/TRANSIT/LANDING 三态角色展示、消除直连幽灵双端口、端口文本不溢出、无线路时 EmptyState |
| **`UI-09`** | 节点详情 | 基础信息与遥测 Tab 及安装弹窗 | `/admin/nodes/:id` (Tab 2) | `apps/web/src/pages/admin/nodes/detail.tsx`, `apps/web/src/pages/admin/nodes/components/rotate-token-dialog.tsx`, `apps/web/src/pages/admin/nodes/components/install-commands-picker.tsx` | 节点基础信息编辑（支持网络可达性 PUBLIC/NAT 切换、NAT 模式下自动兜底 127.0.0.1 且提示反向穿透）、顶部实时日志入口（带参数联动跳转）、远程节点 AgentToken 轮换入口、本机节点轮换禁用说明、轮换二次确认弹窗、一次性新 Token 与安装命令弹窗（「原生安装 / 免安装运行 / Docker / 离线安装包」四 Tab × 目标操作系统 Linux/macOS/Windows × WS/HTTP 切换与复制，原生模式专属预编排免交互脚本一键下载，离线包一键下载，Windows CMD/PowerShell 跨终端通用与免交互执行提示）、Linux/macOS 与 Windows 双卸载命令展示、通信模式、Agent/系统架构/内核版本画像、遥测与内核状态、统一时区上报时间 |
| **`UI-10`** | 节点详情 | 高级与运维 Tab | `/admin/nodes/:id` (Tab 3) | `apps/web/src/pages/admin/nodes/detail.tsx`, `apps/web/src/pages/admin/nodes/components/node-deployment-history.tsx` | Line 配置预览、JSON 覆盖编辑器、统一时区网络质量快照、格式化内核错误日志、升级分发记录卡片（分页任务列表、状态筛选、失败/已完成任务重试、有历史版本任务回滚二次确认）、重启/升级/删除操作 |
| **`UI-11`** | 用户管理 | 一站式用户管理列表 | `/admin/users` | `apps/web/src/pages/admin/users/index.tsx` | UID 与昵称列、邮箱验证状态 Badge（已验证/未验证）、UID 精确搜索和昵称/邮箱实时搜索、角色/账号状态/邮箱验证/订阅状态/套餐筛选（支持「无订阅 NONE」与「无套餐 NONE」精准筛选，状态下拉中英文对照）、套餐 Badge、订阅状态 Badge（有效/已取消/已过期/已吊销/无订阅）、流量进度条、统一时区到期日、流量数据自动刷新、操作列对无订阅用户置灰禁用重置订阅链接按钮并展示「该用户暂无有效订阅」Tooltip 提示、Token 重置确认、管理员防误操作保护；在线设备列显示在线 IP 数/设备上限及超限状态，当设备上限为不限时不重复显示「不限制」策略标签，其他策略来源仍保留；点击统计徽标可打开跨节点设备管理弹窗并查看设备限制详情。 |
| **`UI-12`** | 用户管理 | 创建用户弹窗 | `/admin/users`（点击“创建用户”） | `apps/web/src/pages/admin/users/components/user-form-dialog.tsx` | 邮箱、初始密码、角色选择器、可选初始套餐 Select，纯套餐驱动（彻底移除手动流量配额与到期项输入，无套餐创建 0 配额无订阅用户，绑定套餐自动继承套餐配额与时长） |
| **`UI-13`** | 用户管理 | 综合编辑用户弹窗 | `/admin/users`（点击操作列“编辑”） | `apps/web/src/pages/admin/users/components/user-form-dialog.tsx` | 「账号安全/订阅管理」双 Tab、角色选择器、启用账号与邮箱已验证状态卡片对齐无挤压（rounded-lg border p-3 shadow-xs）、密码重置；订阅管理中无订阅用户隐藏重置订阅链接按钮，无订阅或选择无套餐时自适应隐藏配额/已用流量/到期日/额外线路输入项，展示状态说明或取消警告卡片；无订阅用户提示请选择套餐绑定且未选套餐前保存按钮禁用；已有订阅选择无套餐切换为红色「彻底取消订阅」按钮并触发二次确认弹窗；绑定具体套餐后流畅展开微调输入项与流量重置信息；Token 重置确认；设备数量限制支持跟随套餐 / 用户级不限 / 指定台数三态选择，限额输入与状态说明正确联动。 |
| **`UI-14`** | 系统设置 | 系统设置七分类管理面板 | `/admin/settings` | `apps/web/src/pages/admin/settings/index.tsx`, `components/landing-settings-tab.tsx` | 七个受控 Tab 响应式切换与 16px 图标（隐藏 Tab 存在表单校验错误时点击保存自动切换至首个报错 Tab 并弹出 Toast 提示；新增「首页设置」Tab，支持首页总开关、Hero 胶囊/主标题/副标题多语言文案定制、特性与套餐与 FAQ 模块显隐独立开关、特性卡片与常见问答 FAQ 的可视化新增/编辑/删除/上移下移/一键恢复默认）；区域与统一时区设置卡片（常用 IANA 候选 + 自定义输入 + 本地实时时钟预览）、SMTP 邮件服务卡片与脱敏密码、注册邮箱验证开关、强制邮箱验证开关（限制订阅与节点连接）、SMTP 测试邮件弹窗与反馈、人机验证模式切换及 Turnstile Site/Secret 配置、注册与用户 Tab 默认赠送套餐下拉仅展示公开套餐（已删除或下架套餐自动回退为不赠送）及密码复杂度要求区块（小写/大写/数字/特殊字符四开关跟随 `passwordRequire*` 设置，全部关闭仅校验长度）、主站 URL 强化主从继承说明、移除失效默认流量配额与天数（明确新用户由套餐决定）、订阅与客户端分发 Tab 包含基准 URL 覆盖项、Nginx 伪静态短链接开关、默认追加节点速率角标开关（appendSubscriptionSpeedBadge）、自动折算 G 单位开关（speedLimitUnitConversionEnabled）、速率色彩阶梯配置器（SpeedTierEditor，支持多档阈值增删、语义色阶与实时预览）、启用「我的订阅」卡片特效同步开关（subscriptionEffectsSyncEnabled）及默认模板只读展示与跳转管理、Agent 运维 Tab 包含项目 GitHub 仓库地址与 GitHub 下载源/加速镜像列表管理（当前默认下载源 Badge、一键测速真实流式采样、仅用官方源直连与恢复预设镜像快捷按钮、测速结果卡片含延迟/速率/最快标识及一键设为默认源）、存储与日志策略字段、数据库物理体积（业务主库/观测库/总占用）统计与手动 VACUUM 碎片整理按钮、统一清理中心入口、CodeMirror、自定义 Head 可信边界与 JWT 风险提示、保存与重置确认、移动端与窄屏视口（375px/320px）防横向溢出与表单组件自动换行/截断适配；基础设置包含全局多设备执行开关及设备活跃窗口（15~600 秒），关闭后配置值仍可见且手动踢设备可用。 |
| **`UI-15`** | 全局框架 | 动态品牌外壳与主题/语言/公告中心 | 全局 Layout / Header / Sidebar | `apps/web/src/components/layout/**`, `apps/web/src/components/ui/sidebar.tsx`, `apps/web/src/lib/public-settings.ts` | 站点名/Logo、左上角 Logo 与站点名称点击平滑导向首页（带 hover 微透与多语言「返回首页」title）、顶栏消息公告中心（`AnnouncementCenter`，展示未读脉冲红点角标、点击展开内联下拉列表、分类徽章、全部已读快捷操作、点击单条弹出居中完整 Markdown 详情 Dialog、未读强提醒公告首次进入自动弹窗）、顶栏语言切换器（LanguageSwitcher，支持简体中文、English 与日本語即时切换与本地持久化）、侧边栏底栏客服支持联系弹窗与页脚版权文案、统一时区挂载、动态标题/Favicon/CSS、服务端会话角色变化后管理员导航及时同步、侧边栏定位、移动端抽屉高度自适应与垂直顺畅滚动、版本号展示、主题三态切换、Sonner Toast 浮层 |
| **`UI-16`** | 套餐管理 | 套餐管理列表 | `/admin/plans` | `apps/web/src/pages/admin/plans/index.tsx` | 套餐名称/标签/描述即时搜索、状态筛选器（全部/仅公开/已下架）、紧凑数据表格布局（套餐信息与主推/角标、资费与周期、流量与重置、线路范围、绑定模板、公开状态、编辑/删除快捷操作）、购买台账存在时删除被阻止的提示、删除确认弹窗、移动端容器内横向滚动；套餐列表清楚展示同时在线设备上限，0 显示为不限。 |
| **`UI-17`** | 套餐管理 | 套餐创建/编辑弹窗与实机即时预览 | `/admin/plans`（点击“新建套餐/编辑”） | `apps/web/src/pages/admin/plans/components/plan-form-dialog.tsx` | 每用户限购次数输入（留空不限购）、允许续费 Switch、价格改为 0 元时自动套用“限购 1 次且不可续费”安全默认；配额/期限数值输入、流量重置策略 Select、匹配模式 Select、模板选择、公开 Switch、角标文本 badgeText、主推推荐套餐 isFeatured 开关；带宽限制速率上限 speedLimitMbps（0 为不限速）、节点名称速率角标策略 appendSpeedBadge（继承/强制追加/强制不追加）；自定义权益清单 features 多行文本与快捷微标记预设（集成悬浮气泡指南 Tooltip 并精炼右侧空间，缺省自动附带峰值带宽展示）；三大视觉流派方案卡片式选择（尊享流光合璧 fusion / 全息黑曜 3D 闪卡 holographic / 赛博霓虹导光晶体 neon）；折叠式「高级视觉微调」抽屉提供 5 项原子微调独立开关（3D 视差微倾斜、1.5px 流光微边框、全息彩虹折射、双层环境霓虹、流体极光内衬）并与预设基线联动；视觉配置（7 款质感主题色选择、12 款 Lucide 专业矢量图标网格、光色与角标样式纯净中文下拉、原价划线与折扣文案、按钮扫光开关、同步特效至「我的订阅」syncToSubscription 开关，彻底剔除旧版 animationEffect 冲突下拉框）；右侧所见即所得实机卡片预览（Live Preview）实时联动速率限制与角标、移动端自适应滚动；套餐表单的同时在线设备上限可输入 0~1000，0 表示不限并在预览/保存后保持一致。 |
| **`UI-18`** | 模板管理 | 订阅模板列表 | `/admin/templates` | `apps/web/src/pages/admin/templates/index.tsx` | 模板名称/描述即时搜索、紧凑数据表格布局、默认/内嵌 Badge、策略组/规则集/DNS 状态与高级覆写标签、常用操作（预览/编辑）外露与次要操作（复制/删除确认）下拉菜单收纳、移动端容器内横向滚动 |
| **`UI-19`** | 模板管理 | 订阅模板编辑弹窗与预览 | `/admin/templates`（点击“新建模板/编辑”） | `apps/web/src/pages/admin/templates/components/template-form-dialog.tsx`, `template-groups-editor.tsx`, `template-rules-editor.tsx`, `template-dns-editor.tsx`, `template-override-editor.tsx`, `template-source-editor.tsx`, `template-preview-drawer.tsx` | 六 Tab 移动端单行横滑与自适应切换（基本信息、策略组设计、分流规则、DNS 设置、客户端高级覆写、源文件编辑）、紧凑状态徽标与防挤压按钮排布、深色终端语法诊断卡片与安全隔离、策略组与规则预设沉浸式顶栏、DNS 直连/代理徽章列表与主流预设、客户端高级覆写全宽编辑器与 Clash/Sing-box 智能 deepMerge 注入、整模板 JSON / YAML 源文件双模无损双向切换编辑、Sing-box 与 Mihomo 双内核真实验证诊断与抽屉分级日志、编辑器跟随明暗主题、桌面/移动端滚动与双主题 |
| **`UI-20`** | 用户订阅 | 套餐市场 | `/market` | `apps/web/src/pages/user/market/index.tsx`, `components/market-plan-card.tsx` | 快捷周期筛选 Tab（全部/月付/季/半年/年付）带计数；达到每用户限购上限的套餐仍显示但按钮禁用，限购 1 次显示「已领取」、多次限购显示「已购完」，确认弹窗展示已达上限提示；套餐卡片展示 `Zap` 图标速率标签并在缺省权益中显示峰值带宽，联动阶梯色彩与 G 单位换算；高阶三大视觉流派自适应渲染（尊享流光合璧 fusion / 全息黑曜 3D 闪卡 holographic / 赛博霓虹导光晶体 neon）；支持原子级视觉能力（物理阻尼 ±6° 细腻 3D Tilt 视差微倾斜、1.5px 极细微导光流动微边框 Shine Border、高透动态全息彩虹晶格折射图层 Holographic Foil、双层呼吸环境霓虹光晕 Ambient Neon Bloom、流体极光内衬 Aurora）；双层鼠标物理镜面光斑追踪 Spotlight、按钮金属微光扫光 Shimmer、半透微折射晶体按钮 (Smoked Glass Button)；明暗双模纯净微透渐变底（浅色珠光白玉微晶冷光折射与深色深邃黑曜水晶，彻底根除浑浊发脏泥泞感）；套餐激活态（isCurrent）高亮光环与阴影提升至最外层包装，消除 Shine Border 容器边缘硬裁剪与重叠挤压；价格区域通透自然融合排版、折扣文案与多样化角标、特性清单微标记图标统一跟随主题折射色（杜绝七彩杂色）、当前在用套餐与余额横幅、低价与已激活套餐按钮清晰高对比度提示「暂不支持降级」「当前使用中」、订购/升配二次确认弹窗（含卡密快速兑换）、窄屏单列自适应；套餐商城卡片展示套餐同时在线设备上限/不限标记。 |
| **`UI-21`** | 用户订阅 | 我的订阅综合控制台 | `/subscription` | `apps/web/src/pages/user/subscription/index.tsx` | `allowRenewal=false` 的免费套餐隐藏续费入口，其他套餐保留续费；公告下方按状态渲染订阅主体或开通引导；当前订阅主卡片支持受控同步当前套餐同款高透纯净玻璃质感底色与顶部天光漫射、棱线导光条及双层镜面光斑追踪（受全局与套餐级双层开关 subscriptionEffectsSyncEnabled 控制；关闭时干净降级为极简原生无动效卡片），内部无论动效开启与否均保持完全原生的交互与视觉规范（标题区原生利落文字排版、状态与推荐 Badge 原生样式、操作按钮统一维持原生 outline 风格且无侵入性渐变玻璃；动效开启时 4 块指标卡自适应微透磨砂玻璃 backdrop-blur-sm 透显通透渐变底色，动效关闭时恢复原生 bg-muted/20 清爽排版）；流量进度、状态 Badge、流量重置策略与统一时区下次重置时间、标准/伪静态 Token URL 复制/重置、取消保留权益提示、可用线路紧凑列表（名称、协议、统一时区延迟 Chip、在线状态、倍率、线路物理限速标签排在状态后延迟前，展示 Zap 图标与阶梯色阶）；强制邮箱验证开启且未验证时隐藏顶部 PageHeader 并呈现视觉居中的服务暂不可用全屏卡片（彻底隐藏公告、套餐卡片、订阅链接、节点列表及使用指引，仅展示居中偏上的盾牌图标卡片、统一暂不可用文案与原地即时验证弹窗）；无订阅时展示前往套餐市场按钮；小型确认弹窗在移动端保持圆角、左右留白、居中紧凑且 Footer 横向排列；订阅指标展示在线设备数与设备上限；用户侧设备摘要使用「在线设备 / 设备上限」，不显示策略来源及在线汇总说明；设备弹窗显示 IP、节点/线路、连接数、活跃时间，单台与全部设备操作统一使用「下线」措辞，并验证确认、复制、加载、空态及错误反馈。 |
| **`UI-22`** | 节点运维 | 远程升级弹窗 | `/admin/nodes/:id`（点击“升级中心”） | `apps/web/src/pages/admin/nodes/components/upgrade-node-dialog.tsx` | 界面收敛为纯粹的「Agent 升级」单动作（Sing-box 内嵌提示与当前 Agent/托管内核版本双画像）、当前/推荐版本对比、ACTIVE 资源选择（展示平台资产数）、自定义 URL/SHA-256 校验、导入主控、HTTP/WS 任务等待、下发中禁用状态、错误 Toast |
| **`UI-23`** | 线路管理 | 线路管理列表与链路测速弹窗 | `/admin/lines`（点击即时测速或延迟 Badge） | `apps/web/src/pages/admin/lines/index.tsx`, `apps/web/src/pages/admin/lines/components/line-speedtest-dialog.tsx` | 类型/状态/标签筛选、独立「排序」列（`#sortOrder` 等宽展示）与稠密步长上移/下移排序、批量启停、表头测速原理 Tooltip 说明与底栏测速机制注解、全部测速与单行即时测速、延迟 Chip 标签（绿/橙/红/灰四档带 Tooltip、点击唤起单次测速链路流程弹窗并在弹窗中动态执行测速）、单次测速流程弹窗（拓扑节点流程图、分阶段耗时与状态指示、严格全链路 100% 跑通判定与端到端综合延迟评级、任一阶段失败时综合延迟置空并展示异常排障诊断卡片、就地重测）、倍率/中继信息、自适应拓扑展示（直连单节点，中继“中转 ➔ 落地”，桥接“中转 ➔ 目标线路”）、标签列物理单端口限速角标（`Zap` 图标、单位自动折算与阶梯色阶）、覆盖启用状态、删除确认 |
| **`UI-24`** | 线路管理 | 新建/编辑线路双页签弹窗 | `/admin/lines`（点击“新建线路/编辑线路”） | `apps/web/src/pages/admin/lines/components/line-form-dialog.tsx` | 默认“入站配置”页签包含协议/入口节点/监听地址与端口、入口节点选择器过滤排除 NAT 节点仅允许公网 VPS、平面展开的 Transport/TLS/Reality/ACME/专属参数、标准 TLS/ACME 的 ALPN 预设多选、ShadowTLS v3 + SS2022 内层字段、可增删请求头、Reality 密钥生成；Reality 不显示 ALPN；入站配置内嵌「网络底座与监听调优」（单端口物理限速 speedLimitMbps、PROXY Protocol v1/v2 及无头容错、TCP Fast Open、TCP MultiPath、UDP 分片与超时设置）与「客户端多路复用 Multiplex」（smux/yamux/h2mux 协议、最大连接数/并发流数、最小流数、数据包填充与 TCP Brutal 拥塞控制上行/下行速率）；协议高级项包含 Hysteria 2 HTTP 伪装模式（file/proxy/string）与 Shadowsocks UDP over TCP 开关；安全传输层包含 TLS 最低/最高版本选择与自定义密码套件输入；“线路高级设置”页签包含落地拓扑（落地节点支持选择公网或 NAT 节点，选定 NAT 节点时自动激活「NAT 安全反向穿透」卡片并提供「允许访问落地端局域网资源」安全开关与隧道参数提示，直连模式自适应隐藏落地设置）、客户端接入端点、中继回源端点（`landingEndpointOverrideEnabled` / `landingServerHost` / `landingServerPort`，切换协议不丢失，NAT 节点显示回环隧道提示）、倍率/状态；TARGET_LINE 选项显示为“协议转换：桥接已有线路”，并显示目标直连筛选、目标节点/协议/端口摘要（含目标线路对外端点自动继承提示）且隐藏落地手填字段；两页统一保存 |
| **`UI-26`** | 证书管理 | 证书管理列表与证书操作弹窗 | `/admin/certificates`（点击新建/编辑/查看） | `apps/web/src/pages/admin/certificates/**` | 证书名称、SAN 标签、签发者、统一时区有效期状态展示、关联线路数、PEM 粘贴/上传、解析反馈、私钥查看、引用线路删除拦截 |
| **`UI-27`** | 流量统计 | 全站流量统计 | `/admin/traffic` | `apps/web/src/pages/admin/traffic/**` | 今日/24 小时/7 天/30 天 Tabs、流量与当前速率摘要、平均/峰值速率图、线路/用户 Top 5 + 其他 Donut 切换、线路明细/用户排行 Tabs、历史观测数据清理快捷入口与共享预览确认弹窗、邮箱搜索、角色筛选、本地分页、前三名徽标、排行表格数字字段不换行、明暗主题与移动端局部横向滚动 |
| **`UI-28`** | 用户管理与流量统计 | 单用户流量明细下钻 | `/admin/users` 或 `/admin/traffic`（点击“流量明细”） | `apps/web/src/pages/admin/users/components/user-traffic-dialog.tsx` | 用户配额画像、周期走势图、线路占比、明细表格、无记录 EmptyState、桌面 `max-w-5xl` Dialog/移动 Sheet、外层无横向溢出且明细表局部滚动、明暗主题 |
| **`UI-29`** | 用户中心 | 个人中心 | `/profile` | `apps/web/src/pages/user/profile/**` | 顶部 Profile Header 身份横幅（个性化 Avatar、大字昵称弹窗修改、换绑邮箱 Dialog 验证码 60s 倒计时与密码验证、邮箱超长截断带 hover title、状态徽标与「立即验证/更换」按钮防断行 whitespace-nowrap 并在移动端窄屏下整簇折行、数字 UID 复制胶囊、角色徽标、加入时间）；强制邮箱验证开启且未验证时的暂不可用提示横幅；Tabs 双页签（账号与安全 / 资产与财务）；账号安全页签（登录密码修改、代理凭据 UUID 掩码切换/一键复制/红色危险区域与二次重置弹窗）；资产财务页签（资产三指标概览与卡密兑换并排、全宽收支流水表格、分页与 EmptyState）；客服联系渠道卡片；移动端自适应折行、明暗双主题自适应 |
| **`UI-30`** | 卡密管理 | 分类、奖励/限额、生成及删除/作废交互 | `/admin/redeem-codes` | `apps/web/src/pages/admin/redeem-codes/**` | 四态统计（数量 + 金额）、分类/状态/已删除筛选、防抖搜索、分类奖励 BALANCE/PLAN 与购买身份累计限额配置、按分类生成并展示奖励快照说明、标签管理、卡密默认掩码与明文切换/复制、CSV/TXT 当前筛选导出、未使用卡显式作废、批量/单张删除确认与已删除视图恢复、过期卡密删除文案明确范围和恢复方式、分类必填/名称长度/金额精度/兑换上限及生成前缀/备注校验错误均随中英文切换、兑换人与兑换时间、有效期状态、移动端表格局部滚动及分类/表单弹窗滚动 |
| **`UI-31`** | 资源管理 | 资源管理与资源详情 | `/admin/binaries` | `apps/web/src/pages/admin/binaries/**` | 侧栏与页面顶栏统一命名为「资源管理」；仅管理跨平台 Agent 资源（移除 Sing-box 资源筛选项与表单项）；服务端分页/搜索（版本号或备注，400ms 防抖）与平台/状态（仅保留「启用」与「停用」）组合筛选；精简顶栏操作为「远程导入」与「上传文件」（移除顶栏冗余统计卡片与系统日志跳转按钮）；状态列采用行内交互式 `Switch` 开关一键切换启用/停用（移除操作列重复的启停与归档按钮）；行多选与批量工具栏（启用/停用/删除，所有资源不区分是否内置均可直接删除，删除默认资源自动转移默认标记）；「远程导入」弹窗合并「GitHub Release」（默认 Tab）与「自定义 URL 导入」双标签页，顶部只读展示当前仓库链接与当前默认下载源（镜像或 GitHub 官方直连）并提供跳转系统设置快捷入口（项目 GitHub 仓库地址 `githubRepoUrl` 与加速镜像在系统设置「Agent 运维」Tab 配置，构建期默认内嵌当前项目公开仓库地址），支持展示去重后的真实 Agent 版本 Release 列表与跨平台架构资产状态、一键原子拉取全部或单架构资产并实时同步资源管理主表；本地多文件上传与 URL 导入表单无需手填版本、目标平台或 SHA-256（服务端自动解压并从二进制魔数头/内嵌标记/文件名识别）；资源详情弹窗展示「总体积」、平台资产、SHA-256 明细及分发记录分页与重试；明暗主题与移动端局部滚动 |
| **`UI-32`** | 监控与系统 | 系统日志可视化大盘 | `/admin/logs` | `apps/web/src/pages/admin/logs/**` | 4 大 KPI 指标卡、分级趋势堆叠柱状图、多维过滤器工具栏（支持一键重置与活跃模块徽标，支持 URL searchParams 携带 `nodeId`、`module` 与 `live` 参数自动激活对应节点或模块如 `BinaryResource` 的日志过滤与实时推流）、高密度等宽日志流表格（支持节点与模块标签点击即滤、搜索关键词精准高亮）、Live Tail 实时推流条（悬浮控制、清屏、暂停、自动滚动）、详情抽屉（TraceId/节点/模块一键穿透过滤、调用堆栈、格式化元数据）、日志导出与统一历史观测数据清理弹窗（目标/模式/预览/二次确认/`CLEAR_HISTORY`/逐表结果）；明暗主题自适应与移动端防溢出 |
| **`UI-33`** | 认证 | 找回密码页面 | `/forgot-password` | `apps/web/src/pages/forgot-password/**` | 左上角返回首页按钮（带 ArrowLeft 图标与多语言文本）、右上角语言切换器与 ThemeToggle 主题切换并列排布、找回密码表单居中对齐、邮箱/新密码/确认密码输入校验、邮箱验证码获取按钮与 60 秒倒计时、人机验证弹窗防刷保护、重置成功后跳转登录页与反馈 Toast、返回登录跳转链接、底栏客服支持联系渠道与页脚版权渲染 |
| **`UI-34`** | 网络与节点 | 镜像站列表、编辑与测试结果 | `/admin/mirrors` | `apps/web/src/pages/admin/mirrors/**` | 上游域名、指定节点与 `mirror_proxy` 能力、访问模式、启用状态和最近请求结果的表格扫描；创建/编辑表单、分享 Token 一次性展示与轮换、删除确认、测试结果对话框；明暗主题、移动端表格局部滚动和弹窗内滚动 |
| **`UI-35`** | 用户中心 | 直连代理池凭据管理与提取导出中心 | `/proxy-pool` | `apps/web/src/pages/user/proxy-pool/**` | 顶部 4 项微型状态指标卡（活跃凭据、可用端点、双协议单端口支持、主账户配额共享）；响应式双 Tab 切换（「代理提取与代码集成」与「凭据与白名单」）；凭据网格化响应式卡片流（发光状态指示微灯、紧凑等宽凭据胶囊避免横向拉伸、显隐切换、行内复制、白名单 IP 预览与下拉操作）；macOS 终端风格一体化结果工作台（节点流式芯片选择、TXT/URI/JSON 提取结果与四语言代码片段平滑切换、多节点自动化代码轮换池与单节点快速切换器、移动端分层响应式控制栏彻底根除 Tab 与操作按钮重叠、代码视窗常规文本选择、全 TLS 节点 SOCKS5 互斥禁用约束、混合节点 SOCKS5 智能过滤告警横幅、一键复制、一键下载 .txt 文件）；免登录自动化动态拉取 API 复制；移动端全宽自适应无多余横向溢出 |
| **`UI-36`** | 帮助与支持 | 用户端帮助中心与客户端教程 | `/help` | `apps/web/src/pages/user/help/**`, `apps/web/src/components/shared/markdown-renderer.tsx`, `apps/web/src/components/shared/image-lightbox.tsx` | 平台分类切换（Windows/macOS/iOS/Android/路由器/常见问题）、文章侧边栏导航、搜索过滤、置顶客户端一键导入卡（包含协议一键导入与订阅链接复制）、Markdown 正文动态变量插值（自动替换为当前用户专属订阅链接与站点名）、警告块 (Callout) 渲染、代码高亮与一键复制、图片灯箱 (Lightbox) 点击放大预览、右侧 TOC 目录随滚动自动高亮、移动端自适应排版 |
| **`UI-37`** | 帮助与支持 | 管理端文档管理与分屏编辑器 | `/admin/docs` | `apps/web/src/pages/admin/docs/**` | 帮助文档数据表格（标题、别名、平台、语言、发布状态、排序）、平台/状态/搜索组合筛选（语言支持 `zh-CN`/`en-US`/`ja-JP`）、新建/编辑文档分屏弹窗（CodeMirror 源码高亮 + 动态变量插入工具条 + 实时渲染预览 + 平台/客户端/图标/发布 Switch/排序输入项）、一键重置官方预置文档二次确认弹窗（含覆盖选项）、明暗主题与移动端局部滚动 |
| **`UI-38`** | 门户 | 首页门户 | `/` | `apps/web/src/pages/landing/**` | 纯正 shadcn/ui New York 风格高品质首页：Sticky 毛玻璃顶栏（品牌 Logo、平滑锚点、语言/主题切换、智能控制台按钮与用户快捷菜单）、Hero 导流区（胶囊徽标、一级标题、副标题、CTA 按钮组、面向普通用户的感知亮点微胶囊）、核心特性 6 宫格网格（Lucide 动态图标、精致边框与卡片悬浮提升）、公开套餐卡片预览（对接公共 API、价格周期与速率特性）、常见问题（FAQ）折叠手风琴、优雅客服支持与版权页脚；明暗双主题自适应、移动端单列优雅排版与防溢出、系统设置动态配置与 i18n 即时切换 |
| **`UI-39`** | 共享组件 | 在线设备管理弹窗（用户/管理员） | `UI-11` / `UI-21` 操作入口 | `apps/web/src/components/shared/device-management-dialog.tsx` | 管理员侧显示配置上限、设备上限及策略来源；用户侧仅显示在线设备数与设备上限，隐藏配置上限、策略来源及在线汇总说明；设备 IP 复制、跨节点节点名/线路名、连接数与活跃时间；管理员保留管理操作措辞，用户侧单台与全部设备操作统一称为「下线」；确认弹窗、处理中状态、空态、错误 Toast；Light/Dark 与桌面/移动弹窗布局 |
| **`UI-40`** | 业务运营 | 管理端公告管理与分屏编辑器 | `/admin/announcements` | `apps/web/src/pages/admin/announcements/**` | 公告管理数据表格（标题、摘要、分类、展示策略徽标、行内启用 Switch、更新时间）、分类/状态/搜索组合筛选、新建/编辑公告全屏分屏弹窗（CodeMirror 源码高亮 + 语法快捷插入工具条 + 实时渲染预览 + 4 维展示策略开关）、删除确认弹窗、明暗主题与移动端局部滚动 |
| **`UI-41`** | 节点运维 | 批量 Agent 升级确认与逐节点结果 | `/admin/nodes`（选择节点并点击批量升级） | `apps/web/src/pages/admin/nodes/components/batch-upgrade-nodes-dialog.tsx` | 展示所选节点及混合 OS/架构、仅显示覆盖全部目标平台的 ACTIVE Agent 资源、默认主控资源提示、HTTP/离线排队说明；确认后逐节点展示 DISPATCHED/QUEUED/FAILED 与错误信息、部分成功汇总；下发期间防重复提交；Light/Dark、1440x900、375x812 与 768x1024 下检查 Dialog/Sheet 滚动、资源选择器和结果列表不溢出 |
| **`UI-42`** | 网络与节点 | 上游订阅管理、节点池抽屉与中转创建 | `/admin/upstream` | `apps/web/src/pages/admin/upstream/**` | 订阅列表卡片/表格（名称、来源类型、解析格式、节点数、流量配额进度条、上次同步状态与时间）、一键立即同步（防抖与旋转动画）、添加/编辑订阅弹窗（支持 URL/文本双模输入、自动更新周期与自定义 Header）、解析节点池抽屉（Sheet 展示节点名/地区标签/协议 Badge/服务器:端口/连通性测速延迟 Badge）、单节点/全部并发 TCP 握手测速、一键加入用户订阅 Switch 开关、单节点与批量导出标准 URI 链接、一键转中转线路（自动跳转至 `/admin/lines` 并预选为上游中继落地）；明暗主题自适应、移动端表格容器局部横向滚动 |

认证页面的会话验证以 Cookie 为浏览器实现细节：视觉走查只需确认登录/注册成功后正确进入已认证路由、刷新页面仍保持登录态、注销后返回登录页；不得在页面 DOM、localStorage 或 sessionStorage 中出现 JWT 文本。

---

### 2.1 移动端附加检查项

所有受影响索引在 `375x812` 与 `768x1024` 下追加检查：

- 页面主体、卡片和 Header 不产生非预期横向滚动。
- 移动端 Sidebar 能打开、关闭，并在导航后自动收起；长菜单在抽屉内平滑垂直滚动且底栏完整可见。
- 普通弹窗保留两侧留白并可在内部滚动，复杂编辑弹窗切换为全高 Sheet。
- 表格完整保留字段，横向滚动限制在表格容器内。
- Tabs、筛选器、批量操作和危险操作按钮不重叠、不被裁切。

---

## 3. Git Diff 变更映射与走查范围判定

当开发者或 AI Agent 修改前端代码时，应根据改动文件的路径映射确定受影响的 UI 索引范围：

```mermaid
flowchart TD
    Change[前端代码修改 apps/web/src/**] --> PathCheck{路径类型判断}
    PathCheck -->|全局组件 / 样式\ncomponents/ui/*\ncomponents/layout/*\nsrc/index.css| Full[全量走查: UI-01 ~ UI-38]
    PathCheck -->|认证模块\npages/login/*\npages/register/*| Auth[精准走查: UI-01, UI-02]
    PathCheck -->|首页门户\npages/landing/*| Landing[精准走查: UI-38]
    PathCheck -->|根路径与订阅控制台\nrouter/index.tsx\npages/user/subscription/*\ncomponents/shared/*| Dash[精准走查: UI-03, UI-04, UI-21, UI-38]
    PathCheck -->|节点模块\npages/admin/nodes/*| Node[精准走查: UI-05 ~ UI-10]
    PathCheck -->|用户模块\npages/admin/users/*| User[精准走查: UI-11 ~ UI-13, UI-28]
    PathCheck -->|流量模块\npages/admin/traffic/*| Traffic[精准走查: UI-27]
    PathCheck -->|设置模块\npages/admin/settings/*| Sett[精准走查: UI-14, UI-38]
    PathCheck -->|套餐模块\npages/admin/plans/*| Plans[精准走查: UI-16, UI-17]
    PathCheck -->|模板模块\npages/admin/templates/*| Templates[精准走查: UI-18, UI-19]
    PathCheck -->|用户订阅\npages/user/*| UserSubs[精准走查: UI-20, UI-21, UI-29]
    PathCheck -->|直连代理池\npages/user/proxy-pool/*| ProxyPool[精准走查: UI-35]
    PathCheck -->|个人中心\npages/user/profile/*| Profile[精准走查: UI-29]
    PathCheck -->|卡密管理\npages/admin/redeem-codes/*| Redeem[精准走查: UI-30]
    PathCheck -->|节点升级\npages/admin/nodes/components/upgrade-node-dialog.tsx| Upgrade[精准走查: UI-22]
    PathCheck -->|节点批量升级\npages/admin/nodes/components/batch-upgrade-nodes-dialog.tsx| BatchUpgrade[精准走查: UI-05, UI-41]
    PathCheck -->|线路管理\npages/admin/lines/*| Lines[精准走查: UI-23 ~ UI-24]
    PathCheck -->|证书管理\npages/admin/certificates/*| Certificates[精准走查: UI-26]
    PathCheck -->|系统日志\npages/admin/logs/*| Logs[精准走查: UI-32]
    PathCheck -->|镜像站\npages/admin/mirrors/*| Mirrors[精准走查: UI-34]
    PathCheck -->|资源管理\npages/admin/binaries/*| Binaries[精准走查: UI-31]
    PathCheck -->|帮助中心\npages/user/help/*\npages/admin/docs/*| Help[精准走查: UI-36, UI-37]
```

### 映射规则表

| 修改的代码路径 (Glob Pattern) | 关联受影响的 UI 索引 | 走查级别 |
| :--- | :--- | :---: |
| `apps/web/src/index.css`, `tailwind.config.js` | `UI-01` ~ `UI-38`（全站所有页面） | **全量** |
| `apps/web/src/components/layout/**`, `theme-toggle.tsx` | `UI-01` ~ `UI-38`（全局框架与主题） | **全量** |
| `apps/web/src/components/ui/**` | 依赖该原子组件的所有页面 | **全量 / 宽范围** |
| `apps/web/src/pages/login/**`, `register/**` | `UI-01`, `UI-02` | **增量** |
| `apps/web/src/pages/landing/**` | `UI-38` | **增量** |
| `apps/web/src/router/index.tsx` | `UI-03`, `UI-21`, `UI-38` | **增量** |
| `apps/web/src/pages/admin/nodes/**` | `UI-05`, `UI-06`, `UI-07`, `UI-08`, `UI-09`, `UI-10` | **增量** |
| `apps/web/src/pages/admin/users/**` | `UI-11`, `UI-12`, `UI-13`, `UI-28` | **增量** |
| `apps/web/src/pages/admin/traffic/**` | `UI-27` | **增量** |
| `apps/web/src/pages/admin/settings/**` | `UI-14`, `UI-38` | **增量** |
| `apps/web/src/lib/subscription-url.ts` | `UI-03`, `UI-14`, `UI-21` | **增量** |
| `apps/web/src/components/layout/site-runtime.tsx`, `apps/web/src/lib/public-settings.ts` | `UI-01` ~ `UI-03`, `UI-14`, `UI-15`, `UI-21`, `UI-38` | **增量** |
| `apps/web/src/pages/admin/plans/**` | `UI-16`, `UI-17` | **增量** |
| `apps/web/src/pages/admin/templates/**` | `UI-18`, `UI-19` | **增量** |
| `apps/web/src/pages/user/**` | `UI-20`, `UI-21`, `UI-29` | **增量** |
| `apps/web/src/components/shared/announcement-card.tsx`, `client-guide-card.tsx` | `UI-04`, `UI-21` | **增量** |
| `apps/web/src/pages/user/profile/**`, `apps/web/src/components/shared/quick-redeem-form.tsx` | `UI-29` | **增量** |
| `apps/web/src/pages/admin/redeem-codes/**` | `UI-30` | **增量** |
| `apps/web/src/pages/admin/nodes/components/upgrade-node-dialog.tsx` | `UI-22` | **增量** |
| `apps/web/src/pages/admin/nodes/components/batch-upgrade-nodes-dialog.tsx` | `UI-05`, `UI-41` | **增量** |
| `apps/web/src/pages/admin/binaries/**` | `UI-31` | **增量** |
| `apps/web/src/pages/admin/lines/**` | `UI-23`, `UI-24` | **增量** |
| `apps/web/src/pages/admin/certificates/**` | `UI-26` | **增量** |
| `apps/web/src/pages/admin/logs/**` | `UI-32` | **增量** |
| `apps/web/src/pages/admin/mirrors/**` | `UI-34` | **增量** |
| `apps/web/src/pages/user/proxy-pool/**` | `UI-35` | **增量** |
| `apps/web/src/pages/user/help/**` | `UI-36` | **增量** |
| `apps/web/src/pages/admin/docs/**` | `UI-37` | **增量** |

> **2026-09-17 增量台账**：本次新增节点详情 Sing-box 诊断卡片与系统日志真实级别/重复次数展示，增量走查范围为 `UI-05`~`UI-10`、`UI-32`。需在 Antigravity 中覆盖 Light/Dark、`1440x900`、`375x812`、`768x1024`，检查开启确认弹窗、剩余时间、停止/离线/不支持/下发中/自动过期状态，以及日志表格的 `xN` 徽标和说明文案。当前实现未将视觉检查接入 CI 或 Git Hook。
>
> **2026-09-18 增量台账**：本次完善线路可配置项与分层限速体系（`feat/line-config-and-speed-limit`），受影响走查范围涵盖 `UI-14`（系统设置订阅分发角标开关）、`UI-16`~`UI-17`（套餐速率限制与角标策略）、`UI-20`~`UI-21`（套餐市场与订阅页速率展示）、`UI-23`~`UI-24`（线路列表限速角标、入站配置网络底座调优、客户端多路复用 Multiplex、协议高级伪装与 TLS 密码套件/版本控制）。需在 Antigravity 中覆盖 Light/Dark、`1440x900`、`375x812` 与 `768x1024`，验证表单自适应展开折叠、Switch/Select/Input 对齐与移动端防横向溢出。当前实现未将视觉检查接入 CI 或 Git Hook。
>
> **2026-09-18 增量台账（多路复用与 Brutal 拥塞控制优化）**：本次修复线路多路复用 Brutal 速率必填校验与取消勾选状态同步（`fix/line-multiplex-brutal-update`），受影响走查范围为 `UI-24`（线路编辑弹窗入站多路复用卡片）。需覆盖 Light/Dark，验证开启 Brutal 时的必填提示文案、空值提交红字拦截以及取消多路复用后的干净保存。当前实现未将视觉检查接入 CI 或 Git Hook。
>
> **2026-09-19 增量台账（前端全模块国际化与二级交互组件多语言完整覆盖）**：本次对 `apps/web` 全模块进行了彻底的硬编码文本与二级交互组件扫网清理（`feat/web-i18n-subcomponents-and-dialogs-complete`），涵盖节点详情/升级/探针/部署历史、线路高级/网络/协议表单、模板六大编辑器与预览抽屉、资源管理详情/编辑/审计/表单、证书详情与表单、系统日志筛选/实时推流/指标/清理抽屉、系统设置探针与色阶编辑器、流量统计图表与排行下钻、卡密与套餐管理全部二级弹窗、用户管理弹窗及全局 UI 底座（Dialog、Sheet、Sidebar）。所有 UI 文本、ARIA 辅助属性、表单校验与 Toast 提示 100% 纳入 `react-i18next` 统一多语言字典管理，保持中英文结构与词条完全对称。走查覆盖 Light/Dark 模式，确认切换语言即时生效、中英文字符串无溢出与排版变形。当前实现未将视觉检查接入 CI 或 Git Hook。
>
> **2026-09-19 增量台账（用户侧帮助中心与管理端文档管理）**：本次新增用户端使用文档中心与管理端在线编辑器（`feat/help-center-docs`），受影响走查范围为 `UI-36` 与 `UI-37`。覆盖 Light/Dark 模式与移动视口，验证多平台 Tab 切换、代码高亮复制与图片灯箱放大、正文动态变量自动插值、管理端 CodeMirror 分屏实时预览及重置官方预置文档弹窗。当前实现未将视觉检查接入 CI 或 Git Hook。
>
> **2026-09-20 增量台账（首页门户与可配置管理）**：本次新增纯正 shadcn/ui New York 风格首页门户与管理端可视化设置面板（`feat/landing-page`），受影响走查范围涵盖 `UI-03`（根路径按配置进入首页或回退跳转）、`UI-14`（系统设置新增「首页设置」Tab、模块显隐开关、Hero 文案与特性/FAQ 动态增删改弹窗）与 `UI-38`（首页门户全量视图）。覆盖 Light/Dark 模式与 `1440x900`、`768x1024`、`375x812` 移动端视口，走查验证 Sticky 毛玻璃顶栏平滑吸顶、Hero 导流与用户感知亮点胶囊、6 宫格特性卡片悬浮提升、公开套餐接口卡片渲染、FAQ 手风琴平滑折叠、官方客服与版权页脚、以及中英文多语言即时热切换。当前实现未将视觉检查接入 CI 或 Git Hook。

> **2026-09-24 增量台账（全站图标按钮 Tooltip 与尺寸统一）**：本次统一全站图标按钮的可见 Tooltip、无障碍名称与密集操作尺寸，影响全局布局/通用组件以及管理端资源、证书、文档、线路、日志、镜像、节点、套餐、卡密、模板、用户、设置页面，和首页、帮助、个人资料、代理池。增量走查映射至 UI-01～UI-38 中各自对应的受影响索引（全局原子按钮组件按宽范围核查）；建议在 Light/Dark 模式与 1440x900、768x1024、375x812 视口核对表格操作列、弹窗关闭、工具栏、输入框内联按钮及下拉菜单触发按钮的提示可见性、间距和焦点样式。**本次未在 Antigravity 环境执行视觉走查，视觉验收待 Antigravity 完成；未将视觉检查接入 CI 或 Git Hook。**
>
> **2026-09-25 增量台账（全站日语 `ja-JP` 国际化适配）**：本次新增全站日语（`ja-JP` / `日本語`）多语言字典、语言切换器三语支持、首页默认特性与 FAQ 日语化及帮助文档管理页日语筛选与编辑选项（`feat/web-japanese-i18n`），受影响走查范围为 `UI-15`（`LanguageSwitcher` 三语切换）、`UI-37`（文档管理语言下拉）与 `UI-38`（首页门户日语视图）。当前实现未将视觉检查接入 CI 或 Git Hook。

> **2026-09-25 增量台账（多设备同时在线限制与实时设备管理）**：新增套餐上限、用户覆盖、全局设备限制设置、管理端/用户端在线设备列表与共享管理弹窗，并优化用户侧设备上限及下线操作文案、移除冗余「不限制」策略标签和用户侧配置上限标签，受影响索引为 `UI-11`、`UI-13`、`UI-14`、`UI-16`、`UI-17`、`UI-20`、`UI-21` 与 `UI-39`。当前工作区未在 Antigravity 环境执行视觉走查；视觉验收待 Antigravity 完成。未将视觉检查接入 CI 或 Git Hook。
> **2026-09-28 增量台账（套餐带宽速率上限 0 值校验修复）**：修复 `UI-17` 套餐创建/编辑弹窗中 `speedLimitMbps` 输入 `0` 时被浏览器原生 `min=1` 与前端 schema 错误拦截的问题；现允许 `0` 或留空表示不限速，并保持正数限速值校验。需在 Antigravity 中覆盖 Light/Dark、`1440x900`、`375x812` 与 `768x1024`，验证输入 `0`、清空、输入正数及保存后的即时预览一致性。本次未在 Antigravity 环境执行视觉走查；未将视觉检查接入 CI 或 Git Hook。
>
> **2026-09-26 增量台账（资源管理重构、GitHub 镜像测速与远程拉取原子性修复）**：统一侧栏与顶栏标题为「资源管理」，移除顶栏系统日志按钮与顶部冗余体积统计卡片；将「从 GitHub Release 获取资源」与「URL 导入 Agent 资源」合并为「远程导入」双标签页弹窗（默认 GitHub Release，顶部展示仓库链接与当前默认下载源，支持真实 Agent 版本去重展示与全有或全无原子拉取）；在系统设置「Agent 运维」Tab 新增 GitHub 下载源一键测速面板、默认源选择（支持加速镜像或仅用官方源直连）与最快源推荐；状态列改为交互式 `Switch` 开关（仅保留启用/停用状态，移除操作列重复启停与归档按钮）；资源详情仅保留「总体积」展示。受影响索引为 `UI-14`、`UI-31`、`UI-32`。当前实现未将视觉检查接入 CI 或 Git Hook。

---

## 4. Antigravity 视觉走查标准操作规程 (SOP)

当用户发出视觉验证指令后，AI Agent 需按以下标准步骤执行：

### Step 1: 环境检查与就绪
1. 确认后端服务（`http://localhost:3000`）与前端服务（`http://localhost:5173`）正常监听；
2. 确保数据库已初始化并完成本地演示 seed（默认管理员账号：`admin@riricloud.local`，密码：`RiriCloud-Admin-2026!`）；生产环境使用 `.env` 中显式配置的管理员凭据，不依赖演示默认值。

### Step 2: 浏览器视口与会话初始化
1. 依次将浏览器页面视口调整至 `1440x900`、`375x812` 和 `768x1024`；
2. 导航至 `http://localhost:5173/login`，使用管理员账号登录进入主控面板。

### Step 3: 按判定范围遍历 UI 矩阵
1. 根据 Git Diff 确定的待验证索引范围（增量或全量），依次导航或触发对应的页面及模态框；
2. 对每个目标视图，执行浅色模式 (Light) 与深色模式 (Dark) 的截屏捕获。

### Step 4: 检查点与视觉规范核对
对照 [docs/FRONTEND_UI_GUIDELINES.md](FRONTEND_UI_GUIDELINES.md) 核实以下核心要素：
- [ ] **排版与边距**：容器间距均匀，无内容溢出或非预期换行；
- [ ] **弹窗尺寸**：普通表单宽度统一，复杂编辑弹窗保持适度宽度，移动端有两侧留白且超长内容可在弹窗内滚动；
- [ ] **移动端交互**：Sidebar 抽屉可开关，导航后自动收起；Sheet、Tabs、筛选器和表格在 `375x812` 下可操作；
- [ ] **横向滚动边界**：页面主体无横向溢出，宽表格只在其自身容器内滚动；
- [ ] **语义颜色**：文字与背景对比度合格，无硬编码 HEX 色彩或色彩失真；
- [ ] **组件规范**：全部使用 shadcn/ui 组件，无原生裸 HTML 交互标签；
- [ ] **无障碍与交互**：模态框遮罩层正确显示，支持 Escape 键关闭与焦点捕获；
- [ ] **主题切换**：明暗主题切换流畅，无残留白色/黑色色块。

### Step 5: 输出标准化验证报告 Artifact
在当前对话 Artifact 目录生成 `ui_visual_verification_report.md`，使用 `carousel` 标签嵌入全量/增量走查对比截图，并列出各检查点通过状态表。

---

## 5. 维护与更新约定

1. **新增页面/模态框时**：必须在同一 PR 中向本文件「2. 全量 UI 验证索引台账」追加新的 `UI-xx` 索引项与源码路径映射；当前套餐/订阅相关视图登记为 `UI-16` 至 `UI-24`，用户中心与卡密管理登记为 `UI-29` 至 `UI-30`，资源管理登记为 `UI-31`，管理员订阅履约已归入用户管理的 `UI-11` 至 `UI-13`。
2. **重构/删除页面时**：必须同步更新索引台账，保持文档与代码绝对一致。
