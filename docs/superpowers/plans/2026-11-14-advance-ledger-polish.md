# 排序、即时记账、账户归组与部分代垫 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 未知时刻排序稳定、即时手工录入省操作、账户清晰归组、代垫与回款不污染消费收入。

**Architecture:** 保留 SSR 和原生增强。部分代垫使用同一付款组中的消费与应收转账分项，沿用现有余额、消费及信用卡账单引擎；回款以应收转资金账户的转账核销。

**Tech Stack:** Express / EJS / node:sqlite / 原生 JS，Node ≥ 22.5。

**Spec:** ../validation/2026-11-14_18-07_排序默认时刻账户分组与代垫分析.md；维护者已明确授权开始实施。

## Global Constraints

- 不改真实 data/，所有验证隔离；不发 tag、镜像或部署。
- 流水为唯一资金事实；金额整数分；API 与页面共用服务；同 key 同请求幂等。
- 未知历史时刻不回填；即时手动默认保存时刻；明确清除保持未知。
- 普通内容自然高度，全宽类型段内账户平铺，明暗与手机可用。
- 全量回归、独立审查和 CI 通过后按既有授权合并 main。

### Task 1: 排序和默认时刻

Files: transaction-time.js、txn.js/cashflow.js 排序片段、记账表单及 app.js、记账/金融路由、verify-entry-time.js。

- [x] 添加例：同日未知时刻录入18:00排在17:00之后；保留 txn_time=null。
- [x] 将发生日内排序改为 `COALESCE(t.txn_time, substr(t.created_at,12,8))`，再按 created_at/id 稳定排序。
- [x] 网页新建传 `txn_time_mode=auto|explicit|unknown`；仅今天 auto 在成功保存时解析实例当前时刻。编辑、AI、导入不隐式启用。
- [x] 测试默认、清除、补记、显式时刻、往返草稿及无JS。

### Task 2: 账户类型段

Files: accounts.ejs、workspace.css 账户规则、浏览器验收辅助。

- [x] 按类型渲染独立 section，段头显示数量及按币种余额，段内 auto-fit 卡片。
- [x] 隐藏空段，保留编辑展开、新增/归档间距。
- [x] 不等账户数、展开编辑、390/1920 明暗实际截图检查。

### Task 3: 部分代垫资金服务

Files: advances.js、advance-schema.js、db.js 初始化、account-guard.js、txn.js 关联保护、verify-advances.js。

Interfaces: create(lid,uid,d)、detail(lid,id)、list(lid)、collect(lid,uid,id,d)、cancel/restore、guardTransaction。

- [x] 验证付款100、自用40、代垫60：扣款100，消费40，应收60；信用卡出账100。
- [x] 服务事务创建个人消费40及应收转账60；全额代垫只建转账；回款转账冲应收。
- [x] operation_key 重试复用，变参拒绝；拒绝跨账本/跨币种/超收/普通接口改分项。
- [x] 撤销/恢复付款和回款保护容量、关联及金融来源，重算同事务。
- [x] 测试跨月回款收入0、部分回收、重复请求、撤销恢复、信用卡及失败回滚。

### Task 4: 页面、API、技能与验收

Files: transactions 路由/表单/列表、advances 页面与路由、openapi.js、navigation.js、两份 Agent 技能、开发文档和 BOARD。

- [x] 记一笔支出提供代垫展开项（对方与代垫金额），一张付款单显示合计和自用/代垫；旧 AA 明示仅备注。
- [x] 提供代垫列表、详情、回收、撤销/恢复及从已有支出分离入口，统一按钮与返回。
- [x] Bearer 新增 /advances 列表/详情/创建/回收/撤销/恢复；读写授权、审计、幂等与页面一致。
- [x] 同步技能主副本及金融参考，以实际字段为准；运行 quick_validate（UTF-8）。
- [ ] `node test/run-all.js`、`node test/selfcheck-static.js` 与相关浏览器实操，独立审查修复后 PR/CI/main。
- [ ] 维护本轮归档，记录确切证据、边界和最终状态。
