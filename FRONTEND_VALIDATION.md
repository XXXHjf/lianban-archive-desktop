# 前端标准化验收

验收日期：2026-10-30。正式试用副本未替换，所有写入与合成行情均在 `.build/frontend-validation/` 或独立安装副本中完成。

## 方案与交付

Vue 3 Composition API、TypeScript、Element Plus、ECharts、Vite。按需构建组件与样式，所有资源本地提供。前端源码在 `frontend/`，普通使用者继续运行原有安装器和 Python 服务，无需 Node 或联网 CDN。

旧原生模块、HTML 和 CSS 原样移至 `tests/legacy_frontend/`，只作历史行为参考。当前 Vue 应用不导入旧 renderer，HTTP 不暴露测试源文件，分发清单不包含测试、Node 或前端开发依赖。

业务能力保留：交易日与精确板数筛选、四类分组、停牌高度；个股轨迹、周期、梯队证据与同期对比；分时、成交量、竞价、多股对比和节点时间轴；标签层级/成员/批量/来源、备注历史与冲突草稿、黑名单、共同股东与分类偏好；公告及桌面站内信。后端 v1 路径、字段、数据结构和来源口径未改。

## 检查命令

```powershell
cd frontend
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
cd ..
python tools/build_manifest.py
python tools/check_all.py
```

`tools/check_frontend_build.py` 核对源码、锁文件、构建配置与产物的散列记录；`BUILD_BASELINE.json` / `BUNDLE.json` 继续核对运行包真实文件。`SOURCE_BASELINE.json` 未改写。

## 当前结果

最终构建：`d89941b575f2034e`，181 个分发清单文件。源码指纹包含 56 个前端输入。开发工具使用隔离的官方 Node 24.22.2 LTS（下载 SHA256 已核对），没有替换系统 Node 或正式应用的 Python。

- Vue 类型检查、ESLint（零警告）、Prettier 检查通过。
- 11 个 Vitest 文件、56 项新前端测试通过，包含真实 Vue 组件挂载：备注关闭/退出守卫、图表生命周期与范围保持、同股刷新保留筛选/选择与失败回退；另含请求取消/冲突、分页全量可达、分组、时间与缓存模型。
- 350 项 Python 测试和 36 个历史 JavaScript 参考文件通过。历史参考测试通过不能单独证明新界面正确。
- Windows PowerShell 5.1 安装器 23 项校验通过，30 项端到端升级/失败恢复检查通过。故意制造的启动失败有预期报错，最终旧副本恢复且检查返回 PASS。
- 独立离线安装、文件散列校验、启停通过。实际 HTTP 检查 51 个入口/字体/JS/CSS 文件，核对字节与 MIME；桌面能力标记、状态接口不含关闭 token、gzip 和个股结果通过。
- 在独立安装副本写入合成备注与黑名单后重新安装，记录均保留。正式试用副本、原始来源清单、版本号及上游更新通知未改。

隔离公开 seed 在 2026-10-28 查询结果为 71 只、最高 5 板、连板 8 只、首板 63 只；个股 000678 为 67 个涨停日、最高 7 板、43 个周期。分时图表交互使用明确标注的合成缓存，不代表已验证全天盘中来源采集。

原生首页截图：`.build/frontend-validation/before.png`。详细日志、HTTP 响应和最终截图保存在该忽略目录，不提交个人记录或测试数据库。

## 真实浏览器记录

| 页面 / 操作 | 结果 |
| --- | --- |
| 交易日首页、精确五板、地区布局、股票跳转 | 首页统计与原版一致；五板筛选为 1 只，URL 保留日期与布局 |
| 000678 个股、关联筛选 000980、周期对比 | 统计一致；2,606 个关联股仍完整可查，初始仅挂载 50 个按钮；43 个闭合周期不创建内部竞争节点；每页 5 个完整对比周期 |
| 备注新增、历史编辑、保存关闭 | 隔离数据库复核保存内容一致；API 文本如尖括号按文本展示；同股刷新保留原查询上下文有组件测试保护 |
| 标签目录与新建标签 | 初始 219 标签 / 3,983 只股票；创建空父标签后由 API 复核成功，仅写入隔离副本 |
| 黑名单搜索、加入 | 搜索及键盘选中后写入，表格显示 1 只；重复安装后仍保留 |
| 桌面站内信 | Vue 弹窗显示当前版本；断网时提示不可联网，主功能继续可用 |
| 合成分时缓存 | 价格/量图实际绘制、图内滚轮缩放、范围恢复、分钟滑块键盘操作通过；来源明确标注合成数据 |

最终构建复查未出现新的 JavaScript 错误或组件弃用警告。重构期间发现并修正 ECharts 分块注册顺序、分页弃用参数，以及保存后同股刷新清空界面/筛选的问题。表格和图表的全部组合、窄屏断点、全天盘中自动采集及外部来源可用性未逐项实测，不把合成缓存验证描述为实盘验收。

截图：`.build/frontend-validation/after-home.png`、`after-intraday.png`。日志：`checks-final.log`、`build.log`、`http-final.json`、`install-final.log`、`reinstall-final.log`、`online-unit.log`、`online-integration.log`。
