# 分时模块迁移兼容清单

范围：仅替换 `web/modules/intraday.mjs` 的前端呈现与状态管理，保留现有 `/api/intraday*` 路由、参数、响应、数据库、采集来源及后台事件推导。

## 旧功能与新实现

| 原有能力 | 新组件 / 实现 | 兼容口径 |
| --- | --- | --- |
| 分时目录与交易日历、上一日/下一日/最新/手选日期 | `IntradayView.vue`，Element Plus 日期选择器 | 仅允许 overview 返回的已知交易日；日期、主图代码与对比代码同步 workspace 路由 |
| 主板非 ST 目录，名称/代码/首字母搜索，150 条逐步展开 | `IntradayView.vue`，Element 输入/按钮/滚动区域 | 按板高、历史日的最新涨停成员优先、代码排序；已选股票保留可见；方向键/Home/End 切换 |
| 创业板时间轴与对比范围 | `TimelinePanel.vue`、`IntradayView.vue` | ST 固定屏蔽；创业板仍由 `exclude_gem` 与 `timelineGEM` 控制，只在已纳入的当日 pool 中添加创业板对比项 |
| 完整/部分/未缓存状态、按需采集、离线缓存阅读 | `IntradayView.vue` | 先 GET stock，仅在 `needs_collection/needs_refresh` 且 `edit_tags === true` 时 POST collect；只读模式不发采集 POST |
| 个股资料、板高、标签、备注、黑名单、历史/备注/标签/股东入口 | `IntradayView.vue`、共享 `StockActions`/`StockLink` | API 文本由 Vue 插值；标签显示叶节点，未提供 tags 时回退行业；写入权限由共享编辑器和后台控制 |
| 分时价、主图均价、昨收参考、涨幅、数据来源/采集时间/暂定/刷新错误提示 | `helpers.ts` → 共享 `ChartPanel`，`IntradayView.vue` | ECharts 折线；缺失分钟为 null，不连线伪造数据；两侧价格/涨幅刻度使用相同主图价格域 |
| 09:25 竞价点及成交量、09:30 累计竞价扣除 | `helpers.ts`，价格散点/独立量柱 | 竞价不连成盘中折线；只按原有成交量与金额条件扣除 09:30 累计量/额，不修改 API 原对象 |
| 多股对比、清空、加载/错误/部分状态、成交量统一/各自刻度 | `IntradayView.vue`、`helpers.ts` | 每股价格按自身昨收归一到主图昨收；独立量柱行仍以手为单位；重复色盘后以线型区分 |
| 图表分钟/竞价读数与键盘访问 | Element Slider、分钟读数表 | 用标准滑块的键盘行为替代手写 SVG 方向键；显示实际价格/均价/涨幅/量/额与对比差；缺失分钟明确标注 |
| 午间分段与真实分钟 | `chartSlot/chartClock` | 图表独立保留 11:30 和 13:00 两条真实观测；时间轴继续采用原有压缩午休坐标；不合成行情点 |
| 当日涨停池、首封/最终封板/回封/开板/放量事件 | `timelineRows`、`TimelinePanel.vue` | 完全消费后台事件；仅补呈现 pool 提供的来源首封；保留 source/minute 精度；首次 09:25 来源封板可见；排除午休伪节点；等价 source 时间去重 |
| 节点类型、首板/连板、放量 2/3/5 倍、屏蔽创业板 | `TimelinePanel.vue` Element 表单 | 原有参数口径 `window=2`、`multiple`、`exclude_gem` 不变；只筛选本股节点，不扩展跨股因果关系 |
| 股票定位、排除、标签开关、板高/首封排序 | `TimelinePanel.vue` | 定位不筛掉其他股票；排除优先；标签偏好 localStorage 不可用时回退内存 |
| 横向平移/分钟/秒序缩放、时间跳转、纵向股票浏览 | `TimelinePanel.vue` → `ChartPanel` dataZoom | 用 ECharts 标准滑块/缩放代替手写 SVG/指针/多滚动条同步与 resize 管理；精确来源秒数保留在节点与表格中 |
| 选中节点、解释依据、跳到个股对应分钟 | `TimelinePanel.vue`、`IntradayView.vue` | 图表点击与证据表操作均可选择节点；来源时间定位到实际存在的最近分钟，09:25 定位独立竞价 |
| 全天证据记录与键盘可用入口 | `TimelinePanel.vue` Element 表格/折叠面板 | 提供时间/股票/节点/精度/依据及可 Tab 访问的“查看”操作，替代 SVG 专用方向键导航 |
| 来源秒级首封/末封时间补齐、手动刷新 | `loadTimeline` | 非暂定池、可编辑、缺少时间时按原逻辑尝试；每日期自动尝试一次；手动刷新传 force；失败保留原有分钟精度 |
| 补齐当日分时、三并发、停止、失败统计与缓存保留 | `collectTimeline/stopCollection` | 复制当前 jobs、保留 job.force；最多 3 个 worker；取消停止启动新请求并使迟到结果失效；已取得的后台缓存不删除 |
| 盘中每分钟更新可见股/涨停池、非交易时段暂停 | `refreshLive` | 仅 today + enabled，池采集另须 editable + polling；隐藏文档不刷新；60 秒限频，3 worker；空/旧响应不能覆盖已显示缓存 |
| 路由切换/日期切换/卸载取消与迟到响应保护 | feature generation + stock/timeline/collection generation，API channels | 取消旧 channel，并检查日期、主图、比较成员与 generation；组件卸载清除 interval 与请求 |

## 与共享 ChartPanel 的边界

- 本特性仅创建类型化 ECharts option；初始化、resize、销毁由共享 `ChartPanel.vue` 完成。
- `click` 事件按 unknown 逐层收窄；时间轴使用数据项 eventId 查回实际 API 节点，不解析 HTML。
- tooltip 固定 `renderMode: richText`，不将 API 文本交给 HTML formatter。
- 图表选中信息由 Vue 展示，不为选中状态重建 option，避免仅点击节点就重置用户缩放。
- 价格图与成交量图传同一个日期/主票 group，使用共享组件提供的 ECharts 联动；resetKey 同日期/主票，避免跨票沿用缩放。
- 时间轴 resetKey 为日期，在同日期数据刷新中保留缩放；定位/分钟/秒序通过明确 dataZoom 配置变更调整窗口。共享组件负责恢复普通 option 更新的用户窗口，仍需浏览器验收实际表现。

## 已执行验证

- 对照阅读：迁移前的 `web/modules/intraday.mjs`（现保留于 `tests/legacy_frontend/modules/`）、`lianban/intraday/queries.py`、`timeline.py`、`timeline_rules.py`、`rules.py`，核对接口与事件语义。
- Node 24 原生 TypeScript smoke 两组通过：竞价扣除、午休分段、来源首封/最终封板、去重、最近实际分钟、过期与空响应保护、归一化与量柱刻度、叶标签/行业回退。
- 已添加 `helpers.test.ts` 的确定性 fixture 用例；不访问真实行情网络。
- 使用已安装的官方 `@vue/compiler-sfc` 对两个 Vue 文件执行 parse、compileScript、compileTemplate，均通过；此项验证语法与模板编译，不替代 vue-tsc 类型检查。
- 正式执行 `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`，全项目返回 0；分时特性的日期回调改为显式 `Date` 参数函数。
- 正式执行 `node node_modules/eslint/bin/eslint.js src/features/intraday --fix`，返回 0，特性内无错误或警告。
- 工具链安装完成后正式执行 Vitest：9 项分时 fixture 用例通过。包括竞价扣除、午休边界独立读数、来源时间精度、空/过期缓存保护及多股归一化。
- 静态搜索未发现 any、类型抑制、v-html、innerHTML、直接 fetch 或本地 SVG/指针/resize 管理。

## 尚待验证

- Vite 生产构建已完成并使用本地资源；实际浏览器检查由主代理在统一验收记录中汇总。
- 桌面浏览器已验证合成缓存的目录、图表绘制、图内滚轮缩放、范围恢复和分钟键盘读数，无新的 JS 错误；窄屏、全部多股量图组合、时间轴全部筛选与秒序缩放未逐项实测，详见根目录 `FRONTEND_VALIDATION.md`。
- 使用固定响应的 UI 验收应检查：只读零采集 POST、快速换日/换股、取消中的迟到响应、collection 部分失败与 retry、缓存离线阅读、盘中隐藏/暂停/分钟刷新和缩放保留。
- 此迁移没有实盘取数或改动个人数据；静态及 fixture 结果不代表真实来源采集成功。
