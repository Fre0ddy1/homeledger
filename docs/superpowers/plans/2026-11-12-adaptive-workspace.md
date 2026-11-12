# 自适应工作区 Implementation Plan

> **For agentic workers:** 按当前会话逐任务执行；交付前按仓库要求使用独立审查代理。设计已获维护者确认，不再重复询问执行方式。

**Goal:** 让保存随时可达，工作页面充分利用宽屏，相关字段合理并排且模块间距稳定。

**Architecture:** 保留SSR和原生表单，修改现有模板及workspace布局。新增报表只读分析函数供UI/API共用，不改变资金写入服务。

**Tech Stack:** Express、EJS、SQLite、原生JS/CSS，无新运行时依赖。

**Spec:** ../specs/2026-11-12-adaptive-workspace-design.md（2026-11-12已批准）。

## Global Constraints

- 测试仅隔离DATA_DIR，不改真实账目；Node≥22.5。
- 内容自然高度、普通内容不加内部纵向滚动；无JS仍可选分类和提交。
- 保留账户资格、草稿、自动还款、本金无分类与双口径。
- 明暗、移动、编辑与只读验证；测试和独立审查通过后合并main，不发tag。

### Task 1: 分类选择和保存区

Files: src/views/txn-form.ejs、entry-workspace.ejs、partials/finance-payment-form.ejs、public/js/app.js、public/css/workspace.css、test/verify-ui-browser.cjs。

- [x] 浏览器增加旧页面失败检查：`#submit-btn`在首屏及中部可见；`.cat-group:visible`每种口径仅一组。
- [x] 分类使用原生select作无JS来源、增强分组按钮/搜索；JS选择同步select，保留历史已删分类。
- [x] 创建共用entry-actions操作条，`form`指向可见原生表单；普通/还款切换触发更新。
- [x] 检查移动底栏替换、安全区、首个错误字段、原生无JS提交和草稿往返。

### Task 2: 工作区与语义字段

Files: workspace.css及accounts/subscriptions/recurring/goals/budgets/debts/finance等现有模板。

- [x] 增加有针对性的浏览器检查：账户组到新增区24px、宽屏编辑列≥520px、日期160–220px（窄屏适配）。
- [x] 用现有页面标识取消工作页面窄上限，明确各任务列；表单按字段语义排布，保留阅读页宽度。
- [x] 订阅空态优先创建、字段并排、选填信息展开；账户卡片展开整行，金融列表与登记独立列。
- [x] 按设计§7全站清单逐一复核与截图，公共组件变化覆盖设置/编辑变体。

### Task 3: 报表数据与UI/API

Files: src/lib/cashflow.js、src/routes/reports.js、src/routes/openapi.js、cashflow-report.ejs、reports.ejs、两份API技能、test/verify-cashflow.js。

- [x] 在现有隔离套件增加分析断言：分组合计、笔均/日均、前期对比、空数据、历史锚点、未来区间。
- [x] 共用`flow.analysis(lid,start,end,{today})`返回区间分析；现有cashflow接口增加analysis，月份锚点可选并校验。
- [x] 渲染左排行/对比与右趋势/构成，消费参考独立标注；消费报表使用独立自然列。
- [x] 同步两份API技能字段和时间规则，验证服务、SSR与API同口径。

### Task 4: 验收、文档与交付

Files: test/verify-ui-browser.cjs、docs/ui-development.md、finance-development.md、BOARD与本轮归档。

- [x] 静态检查和全量Windows22/24回归；命令`node test/selfcheck-static.js`、`node test/run-all.js`。
- [x] 浏览器5断点×明暗全路由及相关编辑/只读/无JS状态，检查截图、滚动和保存操作。
- [x] 独立审查，修复发现并复测受影响项；更新同一归档的产出、数据、风险与接续入口。
- [ ] PR、Linux CI22/24、合并main，确认本地/远端文件树一致；重启本任务5112演示并说明。
