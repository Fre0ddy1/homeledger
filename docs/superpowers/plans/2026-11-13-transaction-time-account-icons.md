# 交易时刻、账户类型与Emoji Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 已知交易时刻贯通所有真实流水入口，未知留空，账户类型一致可见，300余Emoji可分组检索。

**Architecture:** 保留SSR/原生JS及txn_date统计口径；新增可空txn_time，共用小型时间校验模块。Emoji、导入导出和金融付款按文件边界分别实施，主任务维护核心/API/AI/共享展示与集成；全部工作共享本分支。

**Tech Stack:** Express/EJS、Node内置SQLite、原生JS，无新运行依赖。

**Spec:** docs/superpowers/specs/2026-11-13-transaction-time-account-icons-design.md（用户已批准方案A）

## Global Constraints

- 未知时刻NULL，不取创建时刻、不猜餐时；date按实例时区解释，统计及信用卡账期仍按txn_date。
- 不写真实data，不重启5111；只用隔离DATA_DIR，8099/5113任务串行，按精确PID清理。
- 两份SKILL及金融参考同步一致；API部分更新未传time保留，显式null/空清除。
- 已有金融保护、操作幂等和来源核销不变；只通过公共服务写事实。
- 自然高度、明暗/移动/无JS、原有自定义图标和24常用保留；不发版或tag。

## 任务1：时间核心与API/手工/账户展示（主任务）

Files: src/lib/transaction-time.js（新）、src/db.js、src/lib/txn.js、src/routes/transactions.js、src/routes/openapi.js、src/views/txn-form.ejs、src/views/partials/txn-list.ejs、public/js/app.js、test/verify-transaction-time.js（新）、test/run-all.js。

Interfaces: normalizeDate(value,fallback)严格日历校验返回YYYY-MM-DD；normalizeTime(value,fallback=null)返回HH:mm:ss或null，undefined保留fallback，null/空显式清除；extractTime(text)只提取明确时刻；formatTime(value)返回HH:mm或含非零秒。

- [x] 新套件先断言服务与API：create({txn_date:'2026-11-12',txn_time:'18:35'})应为18:35:00，created_at不改；update未传保留、null清除；24:00和2026-02-30拒绝；同日有时刻优先、时间排序、账户两端类型。
- [x] 在db.init现有addColumn迁移处添加transactions.txn_time可空；核心create/update使用normalizeDate/Time并修改SQL占位；修改sort映射，decorate派生账户类型标签和时刻展示，不动统计。
- [x] API收date/txn_date及time/txn_time，recent/列表/详情回执贯通；ping返回实例时间和时区；手工表单时间输入、此刻、清除及错误回显；app.js普通/还款草稿来回携带txn_time。
- [x] 共享列表、详情及账户选择使用统一类型标签，未知账户不伪造类型；按已批准文案区分录入/交易时间。
- [x] 运行新套件及原交易/详情/账户资格回归，记录真实失败和修复。

## 任务2：金融实际付款时间（独立边界）

Files: src/lib/finance-schema.js、src/lib/finance/payments.js、src/routes/finance.js、src/routes/finance-api.js、金融付款/还款partials与详情、test/verify-finance*.js。

Consumes: 时间模块上述normalizeDate/Time；createTransaction接受txn_time。
Produces: 付款接受time/txn_time，与所有分项流水一致；签名规范化后纳入实际时刻，未传更正保留、显式清除；已有来源不被核销时刻覆盖。

- [x] 加付款创建/幂等变时刻冲突/保留来源、更正撤销恢复时刻用例。
- [x] 在既有付款表增可空txn_time，规范化body后签名与写入；向本金/费用事实传txn_time，保护恢复快照时刻。
- [x] 手工金融表单和API带入time，详情明确发生与录入；记一笔还款partials与核心输入名约定date/time。
- [x] 只运行自有内存/隔离单元；8099联测由主任务统一跑，避免抢端口。

## 任务3：导入导出时间（独立边界）

Files: src/lib/importers.js、导入导出相关routes/views、test/verify-importers.js。

Consumes: normalizeTime；transactions已有可空txn_time。
Produces: rec.txn_time、独立CSV时间列及完整日期时间解析，JSON/Excel现有导出保全；预览呈现，时刻参与可靠去重。

- [x] 新增支付宝/微信完整日期时间、独立日期/时间CSV回导、同日同金额不同时间及缺时刻用例。
- [x] 既有normalizeRow/导入SQL/导出列精确接入，完整交易时间与独立时间列不混抓；无时刻保持NULL，非法值按行错误。
- [x] 更新预览，避免只在存储保留却不让用户核验；不修改无关导入账户策略。
- [x] 只跑自有内存/隔离逻辑，8099统一联测。

## 任务4：Emoji分组搜索（独立边界）

Files: 分类候选数据模块（新）、category-icon-picker.ejs、独立前端脚本（可新建）、必要分类CSS、test/ui-category-icon-checks.cjs。

Produces: 唯一候选>300，24常用、场景分组、中文别名检索；初始化/reset与现有initCategoryIcons协调，由主任务接入脚本资源戳。

- [x] 扩充候选并验证唯一性/UTF-16长度<=8；保留原96和常用24。
- [x] 共用数据供新建/编辑/原生datalist；搜索只隐藏候选，选值仍走原icon，空命中提示可自定义。
- [x] 更新浏览器任务：搜索猫砂/牙科等同义词，分组选择保存、新建编辑/取消复位/无JS均验证；不为紧凑加普通内部滚动。
- [x] 只做不占8099/5113的渲染检查，浏览器由主任务统一运行。

## 任务5：AI、Agent契约及集成验收（主任务）

Files: src/lib/ai.js、src/routes/ai.js、src/routes/openapi.js AI段、public/js/app.js AI草稿段、skills与openclaw-skill两份SKILL及finance-api.md、相关测试、docs/BOARD.md/本轮归档。

- [x] 规则extractTime只提取明确钟点；模型结构txn_time可空、normalize拒绝捏造餐时；草稿编辑、确认、聊天、开放AI入库传递。
- [x] 添加“昨天18:35消费”与“昨天午饭”对照用例，API/人工/AI/导入最终事实一致；API部分编辑不清空时刻。
- [x] 同步两份技能：date/time参数、ping时区、未知留空、准确回执、金融时间及返回账户类型，校验副本逐字一致。
- [ ] Windows22/24全量、静态、浏览器明暗五断点/编辑/无JS和实际截图；各子任务修复后独立审查整体资金与交互。
- [ ] 更新同一归档；功能分支→PR→Linux22/24CI→授权合并main；文件树核验，纯文档尾记独立补审。

## 自检

三项设计分别映射任务1/2/3/5（时间）、任务1（账户）、任务4（Emoji）；未省略来源保护、相对时间、字段清除、计划日期不臆造、导出回导及未知排序。标准子技能本机未安装，按本计划文件边界执行并保留独立审查门禁；用户已明确要求实施，无需重复询问执行方式。
