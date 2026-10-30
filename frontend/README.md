# 连板档案前端

Vue 3 + TypeScript + Element Plus + ECharts + Vite。用于本地复盘工作台，优先清晰、紧凑、可检索的数据展示。后端仍是原来的 Python + SQLite，v1 接口、个人数据与来源口径保持兼容。

## 开发

Node.js 24 LTS（最低 24.15，本轮验证 24.22.2）、npm。推荐版本记录于 `.node-version`，依赖版本与完整性固定在 `package.json` / `package-lock.json`，不依赖全局组件安装。系统 Node 不满足时可使用项目外或忽略目录中的便携开发工具，不修改用户正式应用的 Python 环境。

```powershell
cd frontend
npm ci
npm run dev
```

开发服务只监听本机，API 和字体等资源代理到 `127.0.0.1:18770`，可在 `vite.config.ts` 中调整。后端请使用隔离测试副本，避免联调写入正式个人记录。

```powershell
npm run typecheck
npm run lint
npm test
npm run build
cd ..
python tools/build_manifest.py
python tools/check_all.py
```

`build` 生成 `web/index.html`、`web/app.js`、`web/assets/` 及源码散列记录、第三方许可说明。普通使用者继续使用原安装/启动命令，无需 npm 或前端开发服务器。构建文件随本分支保存，离线安装不访问 CDN。

## 开发约定

- 文案（2026-10-30 用户反馈）：删除常驻免责声明、重复来源/口径自证、显然的布局解释及无关宣传入口。页面保留事实、日期、数量、当前筛选、具体加载/缺失/错误状态和可执行操作；不反复显示“仅供参考”“不代表”“待核实”等套话。作者主页与本机保存宣传文案按用户要求移除。该反馈优先于早期设计文档中的长口径说明要求。

- 特性目录拥有业务状态和组件；数据转换、分组和时间模型放在纯 TypeScript helper，与 Vue/DOM 分开测试。公共状态只放导航、元数据、编辑入口和变更通知。
- 使用 Composition API 和明确的类型。外部 JSON 在 HTTP 边界处理，复杂数据的真实字段由特性接口表达；不使用 `any` 或类型/规范抑制注释绕过问题。
- 基础交互优先 Element Plus：表单、选择器、表格、Dialog、Popover、Scrollbar、Slider、反馈及空状态。业务结构如股票矩阵可用语义 HTML + 小型组件，避免硬套通用表格损失信息层次。
- 图表统一通过 `ChartPanel` 使用 ECharts。组件负责创建、观察大小、可见性、联动、缩放状态及销毁。图表只消费真实 API 数据，缺失留空，禁止插值伪造市场事实。
- 异步查询使用独立通道取消，并在特性中核对请求代次/当前日期和股票。写入使用原 revision/CAS 协议，409 保留输入并提示重新核对。
- 标签/备注未保存时保护关闭与页面退出。保存中继续输入的草稿不能被旧响应覆盖。批量操作先解析预览再提交；删除、合并保留明确确认。
- API 文本只用 Vue 插值或安全属性，不用 `v-html`。图表提示使用 `richText`；配置外链校验协议、主机和凭据。不要把个人数据、服务 token 或原始响应打进静态文件。
- 浏览器偏好沿用旧键并允许禁用 localStorage。日期、股票、筛选与对比保留已有 query 参数，浏览器前进/后退须恢复状态。
- 视觉：保留本地 Noto Sans SC、Element Plus 图标与 ECharts。每日档案正在进行已确认的 A「梯队优先」样板改造：14px正文、白色表面、语义 `--la-*` token、768/1200/1440px断点，样板规则集中于 `features/archive/daily.css`，仅在 `.daily-prototype` / `.daily-overlay` 下应用。其他页面仍使用 `theme.css` 的原样式与1100/760px断点，待样板人工确认后逐页推广，不将两套布局混用于同一页面。不加入装饰动画。

## 验证边界

`tests/legacy_frontend/` 是历史原生实现及行为参考，不是当前运行页面。其 Node 检查保留旧语义证据；新实现必须通过自己的类型、规范、Vitest 和真实浏览器验证。不要通过保留旧实现使新实现未被检验却宣称兼容。

真实分时来源依赖外部行情网络。图表自动化检查可使用明确标注的合成缓存，不能将其描述为已验证全天盘中采集。正式试用安装和源码验收副本保持分离。
