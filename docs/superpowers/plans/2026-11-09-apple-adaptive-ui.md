# Apple Adaptive UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 全站采用统一 Apple 风格设计系统，宽屏有效利用空间，首页增加收入构成和增强储蓄进度。
**Architecture:** 保留 EJS SSR 与业务路由。直接维护原样式文件以沿用 mtime 缓存戳；首页拆分统计构成 partial，其他页面复用组件并使用页面标记作定向排版。
**Tech Stack:** Node ≥22.5，Express，EJS，SQLite，原生 CSS/JS。
**Spec:** docs/superpowers/specs/2026-11-09-apple-adaptive-ui-design.md

## Global Constraints

- 运行时依赖仍为现有三个包，不引入前端框架、在线字体或外网图表资源。
- 调试仅使用隔离 `DATA_DIR`，不接触真实账目。
- 所有代码留在功能分支，本次不推送、不合并、不打 tag、不部署。
- 视觉验收覆盖 390、820、1280、1920、2560 CSS 像素宽度，浅色与深色。

## Task 1: 公共设计系统与全站骨架

Files: `public/css/app.css`, `src/views/layout.ejs`, `src/views/layout-m.ejs`, `src/views/layout-blank.ejs`, `public/js/app.js`。
Consumes: 现有 CSS 类和 `activeNav`；Produces: `data-page` 页面标记、自适应布局、玻璃导航、键盘焦点行为。

- [x] 替换 `:root` / dark 色彩令牌、调整 `.content { max-width: none; }`，增加具有实色回退的导航材质与组件样式。
- [x] 三套 layout 添加 `data-page`，主内容添加 `id="main-content"` 和跳过导航入口；保留现有表单、角色判断和 DOM id。
- [x] 为确认/详情弹层实现焦点约束及关闭后焦点恢复，抽屉和用户菜单同步 ARIA。
- [x] 用 `node test/selfcheck-static.js` 验证模板/语法及版本一致性。

## Task 2: 首页模块和自适应信息密度

Files: `src/views/dashboard.ejs`, `src/views/partials/dashboard-composition.ejs`, `src/routes/dashboard.js`, `src/lib/charts.js`, `test/verify-dashboard.js`, `test/run-all.js`。
Consumes: `cur`, `prev`, `incomeCats`, `cats`, `goals`, `canWrite(ledger.role)`；Produces: 三列首页、真实收入占比、受保护的目标完成率。

- [x] 编写 HTTP 回归：空收入/空目标；种子收入 10000 分后构成显示真实金额；目标 0/超额不出现 NaN/Infinity；恶意名称转义；其他账本数据不泄漏；只读无写入入口。
- [x] 运行新套件确认失败；按 `test/verify-reports.js` 登录/隔离库约定实现。
- [x] 首页使用直接 grid 项分配趋势、流水、支出、收入、目标与辅助卡片，1600px 以上三列；移除固定 1240px 限制。
- [x] 构成 partial 使用 `charts.donutChart` 与可点击分类列表，统一语义色，零目标进度为 0，超额目标显示真实金额及 100% 进度。
- [x] 新套件登记 `run-all.js`；静态自检与全量回归通过。

## Task 3: 逐页适配、视觉验证与独立审查

Files: `public/css/app.css`, `src/views/*.ejs`, `docs/BOARD.md`, `docs/superpowers/validation/2026-11-09-ui.md`。
Consumes: 公共令牌与页面标记；Produces: 页面覆盖表与验证证据。

- [x] 记账表单与设置限制输入阅读宽度；报表/账户/计划卡片按最小内容宽度排布；日历、年度图表、AI、导入导出、认证页面检查移动重排。
- [x] 隔离演示数据运行预览服务器；浏览器检查所有可访问页面，浅深色和目标宽度，记录溢出/遮挡/操作结果并修复。
- [x] 执行 `node test/selfcheck-static.js` 与 `node test/run-all.js`，检查所有 20 套通过。
- [x] 按仓库规定交独立审查代理，修复全部 P1 及可修复发现，更新看板与验证说明。
- [x] 本地提交：`git commit -m "feat: 重构全站自适应界面与首页财务模块"`。

执行方式：依照用户“通过，进入实施”，在当前会话内执行，不增加选择确认步骤。
