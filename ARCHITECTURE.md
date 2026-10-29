# 连板档案的模块与开发边界

本分支是一套本地模块化单体：一个 Python HTTP 服务、主档案与分时两份 SQLite，以及自托管原生网页。模块化调整不增加产品能力，不改变来源口径、用户记录、接口字段或页面布局。

## 后端职责

| 位置 | 所有权与约束 |
| --- | --- |
| `lianban/core/` | 股票标识、板块、时区和小型校验规则；不依赖 SQLite、来源请求或任务线程 |
| `lianban/storage/` | 主库连接、版本迁移、事务、设置及资料存储；普通连接不初始化 |
| `lianban/archive/` | 确认档案写入、日期/个股查询、周期和关系分析；纯规则与取数分开 |
| `lianban/research/` | 标签有效值与层级、备注历史、黑名单、发布默认值合并；完整编辑用例拥有事务 |
| `lianban/profiles/` | 行业、注册省份、概念、股东和停牌资料的来源处理及刷新用例；公开股东初始缓存只补缺 |
| `lianban/intraday/` | 分时规则、来源标准化、独立存储、只读查询、显式采集与时间轴推导 |
| `lianban/readside/` | 组合当前资料、有效标签及备注的展示投影；股东关系与今天同涨停投影；不参与历史推导 |
| `lianban/adapters/providers/` | 涨停池和辅助日期来源的请求、响应校验及标准化 |
| `lianban/ingestion/` | 收盘归档、手动回补、暂定池用例；不依赖命令行入口 |
| `lianban/runtime/` | 服务创建、任务生命周期、刷新通用机制和时钟对齐 |
| `lianban/interfaces/` | HTTP 参数、响应及状态码、CLI 参数；不承载关系推导算法 |

`app.py`、`desktop.py`、`sync_data.py` 等根文件是入口或兼容门面。新包通过实际模块公开接口协作，不反向导入根兼容模块。静态测试维护这条规则、纯规则的依赖边界和模块导入无环。

HTTP/CLI/定时任务调用现有用例；用例组合来源、规则和存储。查询侧允许直接使用专门 SQL 投影，避免通用 CRUD 仓库强迫复杂查询逐行取数。这里没有依赖注入框架，服务通过明确参数创建。

## 初始化与事务

- `lianban.storage.connect(path)` 只打开连接及设置 WAL；`initialize(path)` 初始化并返回连接，调用者负责关闭。
- `initialize_connection(conn)` 接收空闲连接，在一次事务中处理空库、未编号旧库和版本升级。主库当前结构版本为 2，记录于 SQLite `user_version`；v1→v2 只新增股东快照、股东明细和名称索引，不重跑个人资料的历史迁移。分时库仍为版本 1。迁移失败回滚 DDL 和版本号；较新版本的库会被拒绝。
- 分时 `lianban.intraday.store` 有同样的连接/初始化契约，正常查询使用只读缓存路径，不因访问页面创建分时缓存。
- 一个完整写入用例使用 `storage.transaction.transaction(conn)`。最外层取得 `BEGIN IMMEDIATE`、提交或回滚；内层加入已有事务，不提前提交。不要在组合操作中混用会自动提交的嵌套 `with conn`。
- 归档记录整池先校验。是否允许写入、旧日状态保护和最终替换在同一事务内完成，失败不能降级其他连接刚确认的记录。
- 标签 revision/CAS 和全局目录修订检查保留；发布默认值、层级及版本标记一起提交。标签仍以现有名称和 JSON 归属保存，本轮没有进行身份/关联表迁移。

## 事实与展示模型

历史确认记录、暂定快照、日期覆盖、采集尝试和待核验的分析结果有不同含义。暂定池不进入历史事实表；确认日优先于暂定池。失败请求保留原确认结果，分时较差快照不能覆盖更完整的缓存。

`archive.models` 表达必要的内部观察和周期契约。周期、竞争及时间轴规则接收已取得的输入，不访问 SQLite 或来源。查询层负责日期范围、预热观察和数据缺口，展示投影再补当前行业、标签和备注。当前资料不改变历史当时的名字和竞争证据。

HTTP v1 的现有返回字段继续兼容，包括元数据中的既有设置字段；没有在本轮顺便收缩接口、按需加载或新增历史分类回测语义。以后调整接口时应另建明确的版本或兼容转换。

## 前端职责

`web/app.js` 仅创建安全浏览器环境、组装应用并启动。`web/modules/` 使用浏览器原生 ES modules，无需 npm 安装或打包。

| 模块 | 所有权 |
| --- | --- |
| `application.mjs` | 创建特性实例，维持现有事件注册和启动顺序 |
| `environment.mjs` | 浏览器原生接收者、方法绑定、惰性存储访问；存储被禁用时保留降级行为 |
| `api.mjs` | 请求通道、取消、超时和错误转换 |
| `navigation.mjs` | 当前视图、URL、浏览器前进后退 |
| `preferences.mjs` / `format.mjs` | 偏好持久化、转义与展示格式 |
| `shell.mjs` | 元数据、公共说明、整体协调与初始化 |
| `daily.mjs` / `stock.mjs` | 各自的查询、筛选、周期与关系显示状态 |
| `intraday.mjs` | 分时、对比、时间轴、任务及过期响应保护状态 |
| `tags.mjs` / `notes.mjs` / `blacklist.mjs` | 各自编辑、修订、请求和事件 |
| `shareholders.mjs` | 共同股东浮窗、分类偏好、今日提示和请求生命周期；通过元数据及公开特性方法协作 |

每个特性闭包持有自己的 `featureState`，公开 `read/write` 只接受该模块拥有的字段。跨特性协作使用显式功能方法及受限状态接口；不要恢复一个通用可变全局 `state`。浏览器全局对象由环境注入，构造器不绑定，原生方法绑定真实 Window，访问 localStorage 时才触发其 getter。

既有 JavaScript 回归通过真实工厂和命名方法运行。`tests/frontend-contract.cjs`、`frontend-harness.cjs` 仅用于隔离测试，不进入运行时网页或分发清单。不再通过 `indexOf/slice` 抽取 `app.js` 中的一段函数作为实现。

旧 `realtime.py` / `web/realtime.js` 保留为历史兼容扩展及对应测试，正常入口使用 `ingestion.live_pool`，不加载旧扩展。清理旧扩展需另行核对支持入口与旧安装数据，不在这次结构拆分中直接删除。

## 分发与检查

`SOURCE_BASELINE.json` 保留上游 `dfde734` 的来源记录，原值不改。它不再用于要求重构代码等于上游文件。

`BUILD_BASELINE.json` 记录本分支全部根运行模块、`lianban/**/*.py` 和网页资产；`BUNDLE.json` 再覆盖代码、资源、随包 Python、wheels、种子库及安装脚本。校验会独立枚举实际运行文件，因此新增模块缺入清单也会失败。

修改运行代码或网页之后先执行 `python tools/build_manifest.py`，再执行 `python tools/check_all.py`。后者使用当前 Python 运行完整 unittest，并使用 Node 运行所有 JavaScript 测试，任意检查失败都会返回非零。Node.js 24 是本轮实际验证的开发环境；普通使用者仍不需要 Node。

`python tools/check_compatibility.py --baseline-ref b04ba1f` 在 `.build/` 中提取固定旧模块，使用相同公开种子库及发布标签，对照元数据、日期、个股、股票对比和标签目录。子进程禁止网络；完整 JSON 与计时留在忽略目录，不提交个人数据。

分发验收还需要独立安装副本、实际 HTTP 模块与 MIME、启停、两库升级保护及必要浏览器路径。源码单元测试不能替代真实安装或浏览器验证。重构分支只向个人 fork 的工程分支保存，不发布上游 Release、不覆盖正式试用目录。
