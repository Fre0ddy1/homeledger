# 代垫凑整实施计划

- `advance_collections` 保留 `amount_cents` 为实收，新增 `principal_cents`、`excess_cents`、`excess_transaction_id`；启动与恢复数据库时补列，旧记录本金等于原金额。
- `collect` 接受 `excess_handling: 'income'` 与可选 `excess_category_id`；超额未确认拒绝，缺省分类使用当前账本有效其他收入，否则未分类。请求参数纳入幂等签名，旧精确回款签名保持兼容。原子生成本金转账和差额收入，撤销恢复同时处理，恢复容量按本金计算。
- `detail.received_cents` 保持本金口径，新增 `actual_received_cents`、`excess_received_cents`。流水关联暴露 `advance_collection: {id, advance_id, role, total_cents, principal_cents, excess_cents, person}`。普通列表展示实收，收入筛选及账户分项保留差额流水；资金流一张收据计一笔。
- 覆盖等额、部分、分次超额、确认与分类、重试变参、跨月、撤销恢复、旧库迁移与重开、分项保护、列表与资金统计；运行隔离套件及全量回归。

以上实施项均已完成。Windows与Linux Node22/24均32套1695项通过，独立审查及全站浏览器通过；PR #11已合并main。完整过程及边界见[本轮归档](../validation/2026-11-17_00-41_代垫凑整回款方案.md)。
