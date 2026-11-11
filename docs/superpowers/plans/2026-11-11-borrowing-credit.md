# 借钱、贷款与信用卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.
> 本环境未提供上述两个执行子技能；维护者已明确要求开始工作，按本计划在当前会话内联执行，按仓库规则做独立审查，不再请求执行方式确认。

**Goal:** 完成已批准的本金分类、借钱台账、贷款/信用卡及定期记账边界改造，页面与API一致并同步Agent技能。

**Architecture:** 账户及transactions继续作为唯一资金事实；稳定借钱条目、合同、账单、付款/核销分配及执行记录分别建模。业务服务与页面/API解耦，核销、幂等及撤销在事务内完成，本轮按新模型实施，当前旧测试数据不要求兼容。

**Tech Stack:** Express + EJS + SQLite (`node:sqlite`, Node >=22.5)、原生JS；不增加运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-10-borrowing-and-credit-design.md`（2026-11-11维护者批准实施，补充全部API和技能同步）。

## Global Constraints

- 2026-11-11维护者追加：当前全为测试数据，无需兼容旧借钱/还款模型；移除历史自动汇总迁移和遗留分类保留分支，直接验证新模型。下文历史兼容任务据此取消，期初登记保留。

- 金额均整数分；本金/转账不计收支，利息支出使用expense，现有interest仍是利息收入。
- 账本隔离、RBAC、审计、CSRF/Bearer权限与令牌频控保持；不得修改真实data/账目。
- 内容自然高度，明暗主题及移动断点共同验收；分类/标签可换行。
- 前端、AI、导入、API、调度共同执行类型规则；稳定业务ID与现有入口URL保留，禁止凭名称自动关联账目。
- 新增业务套件登记run-all；Windows和Linux Node22/24全量通过后才完成，PR独立审查。

## Task 1：统一本金分类与稳定借钱条目

**Files:** 新建`src/lib/finance-schema.js`、`src/lib/borrowing.js`、`test/verify-borrowing.js`；修改`src/db.js`、`src/lib/txn.js`、`src/routes/planning.js`、`src/routes/transactions.js`、`src/routes/openapi.js`、`src/views/txn-form.ejs`、`src/views/debts.ejs`、`public/js/app.js`及导航。

**Interfaces:** `borrowing.record(ledgerId,txnId,debtId?)`、`recalculate(ledgerId)`、`create(ledgerId,userId,body)`、`settle(ledgerId,userId,id,body)`、`link(ledgerId,id,txnId)`、`archive/restore`。依赖db事务与txn余额引擎；不再DELETE重建自动台账ID。

- [x] 添加验证：新借钱本金category_id为空、同人两笔不同ID、收还指定条目、部分付款/拒绝超额、删除恢复流水重算、期初登记不造现金流、关联已有流水不重复、跨账本/只读拒绝。
  ```js
  const a=borrowing.create(lid,uid,{direction:'receivable',counterparty:'同一人',amount_cents:10000,account_id:cash,create_txn:true});
  const b=borrowing.create(lid,uid,{direction:'receivable',counterparty:'同一人',amount_cents:20000,account_id:cash,create_txn:true});
  check('独立借款',a.id!==b.id);
  borrowing.settle(lid,uid,a.id,{amount_cents:3000,account_id:cash});
  check('余额核销',borrowing.detail(lid,a.id).balance_cents===7000);
  ```
- [x] 实现可重入schema与服务，统一本金类型判定；核心写入按明确debt_id关联，无法确定历史还款时保留待关联。
- [x] 页面隐藏分类并显示对方/借款选择；所有新建入口执行服务校验，编辑也执行本金无分类语义。原`/debts` API改用同一服务，新增详情/关联/软删除恢复。
- [x] 更新历史A8聚合测试为新稳定关联口径，保留金额、方向与软删除覆盖。运行`node test/run-all.js`，确认新增套件由红转绿后提交。

## Task 2：公共付款、贷款合同与期次

**Files:** 新建`src/lib/finance/common.js`、`src/lib/finance/loans.js`、`src/lib/finance/payments.js`、`test/verify-finance.js`；扩展schema及txn关联保护。

**Interfaces:** `loans.create/update/detail/schedule/replan`；`payments.payLoan(ledgerId,userId,id,body)`、`reverse/restore/detail`。body使用明确整数分字段；重复操作用`operation_key`去重。

- [x] 验证贷款放款与还本的账户恒等、利息/手续费只计一次费用、重复提交、部分多期分配、期初负债绑定与跨币种拒绝。
  ```js
  const p=payments.payLoan(lid,uid,loan.id,{principal_cents:300000,interest_cents:10000,fee_cents:0,account_id:cash,operation_key:'loan-first'});
  check('费用单计',txn.summary(lid,'2000-01-01','2099-12-31').expense===10000);
  check('重复提交复用',payments.payLoan(lid,uid,loan.id,{...body,operation_key:'loan-first'}).id===p.id);
  ```
- [x] 用确定性代码生成等额本金/本息/先息后本及手工计划；尾期分币归整，实付与预计分开。修改未还计划须校验本金合计与剩余负债，展示预览后确认。
- [x] 一次付款创建本金transfer及interest/fee分项，关联统一付款ID；核销总和不能超付款/应还，撤销/恢复原子同步。普通明细修改受控付款时引导完整操作。
- [x] 运行全量回归，覆盖新旧数据库独占迁移与API权限，再提交。

## Task 3：信用卡账单、还款及分期

**Files:** 新建`src/lib/finance/cards.js`；扩展finance-schema、payments及verify-finance。

**Interfaces:** `cards.configure/detail/refresh/confirmStatement/correctPosting/installment`，`payments.payCard/allocate`；复用accounts.credit，按明确due_month_offset生成账期。

- [x] 验证消费1000再还1000支出仍1000、二月/月末账期、退款贷项、跨期分配/分次还款、预还溢缴款、分期本金不重复消费、已确认账单脏标记与修订。
  ```js
  const expense=txn.createTransaction(lid,uid,{type:'expense',amount_cents:100000,account_id:card,txn_date:'2026-11-10'});
  cards.refresh(lid,card);
  const payment=payments.payCard(lid,uid,card,{amount_cents:100000,account_id:cash,operation_key:'card-first'});
  check('消费与还款不双计',txn.summary(lid,'2026-11-01','2026-11-30').expense===100000);
  ```
- [x] 自动归集仅使用已有有效流水；草稿更新，已确认账单保留快照、差异与修订轨迹；校正不制造消费。
- [x] 消费本金分期按金额分配到多期；费用单独入账。已有银行/卡片付款可关联，不再次移动钱；来源不确定时先展示候选再由用户确认。
- [x] 全量回归通过后提交。

## Task 4：页面与完整API

**Files:** 新建`src/routes/finance.js`、`src/routes/finance-api.js`及`src/views/finance*.ejs`，扩展布局、明细、账户入口、workspace样式及浏览器测试。

**Interfaces:** 页面`/finance`及子资源；开放API`/api/open/finance`继承现有Bearer鉴权/频控，所有写路由用requireWrite并记录审计。旧`/debts`、`/recurring`保留。

- [x] GET概览/合同/期次/卡片/账单/付款详情；POST合同创建/修改/归档、计划预览/确认、还款/关联已有付款、付款撤销/恢复、信用卡配置/账单确认修订/入账日校正/分期、分配核销。
- [x] 表单与API调用同一服务；日期、金额、账户、币种、对象归属与operation_key由服务验证，API部分更新保全未传字段。
- [x] 借钱及金融页面提供自然展开的列表、详情、编辑、空状态、关联与审计入口；写入口对只读隐藏，后端仍拒绝越权。
- [x] 扩展浏览器矩阵及实际交互，覆盖新建/部分还款/修订/删除恢复/键盘/无JS/明暗主题；全量业务与静态检查通过后提交。

## Task 5：定期记账边界、导入及Agent技能

**Files:** `src/lib/scheduler.js`、`src/routes/planning.js`、`src/routes/openapi.js`、`src/lib/importers.js`、`src/lib/ai.js`、`src/views/recurring.ejs`、两份SKILL及各自`references/finance-api.md`、README/BOARD。

**Interfaces:** 通用`executeRecurring(ledgerId,ruleId,userId,date)`使用rule/date唯一执行记录；金融到期只提醒。订阅与定期生成的流水进入相同分类及关联策略。

- [x] 修首次日期正则，稳定执行ID取代备注统计；手动/自动/API执行共用幂等服务，工资/房租/转账等仍可独立使用。
- [x] 借钱/信用卡还款识别为本金或transfer，金额不交给模型计算；导入既有付款以候选关联，不自动新造已支付记录。
- [x] 定期/订阅/贷款相似规则只提示，用户确认后暂停旧规则，保留流水；从金融模块不再创建第二条通用规则。
- [x] 两份技能主/兼容内容完全一致，补完整金融API参数、确认范围、幂等/重试和成功依据，更新旧借钱/定期接口说明；用实际HTTP请求验证示例。
- [x] 执行`node test/run-all.js`、`node test/selfcheck-static.js`、`node test/verify-ui-browser.cjs`；Windows Node22/24和Linux CI通过，独立审查与修复后更新验收记录并保存本地提交。

## Coverage self-review

本金与历史兼容→Task1；亲友借钱稳定核销→Task1；贷款四种计划/付款与撤销→Task2；信用卡账期、校正、退款、分期及多对多付款→Task3；全部页面/API/RBAC→Task4；周期重复、调度、导入/AI/技能→Task5。付款和规则迁移均保留用户确认；未纳入银行实际扣款或跨币种自动换算。

## 实施与验收状态

2026-11-11：五项实现已完成，Windows24全量24套1226断言及330视图、4组无JS金融操作流程已绿；独立审查发现的资金/来源/账期/导入边界持续补回归。最终Windows22/24、Linux CI与审查结论以[验收记录](../validation/2026-11-11-finance.md)为准。

## Task 6：追加还款入口及默认资金流（用户2026-11-11批准）

- [ ] SQL确定性汇总资金账户净影响，排除自有资金互转及余额调整；验证还款不双计、借入借出、投资和退款、跨账本及软删除恢复。
- [ ] 首页/报表/手机版默认资金流，可切回消费收支；预算与AI查询明确消费口径。
- [ ] 记一笔还款入口选择贷款/信用卡，复用公共付款服务；开放还款对象及统一付款API。
- [ ] API/两份技能/文档、业务与HTTP/浏览器回归、独立审查通过后按授权合并main。
