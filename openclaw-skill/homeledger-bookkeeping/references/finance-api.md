# 借钱、贷款、信用卡及定期记账 API

所有路径前缀为 `$HOMELEDGER_URL/api/open`，带 `Authorization: Bearer $HOMELEDGER_TOKEN`。读取允许当前账本成员，写入要求可写成员；写操作审计、令牌频控及账本隔离由服务端执行。返回JSON顶层`ok`及业务字段；非2xx或`ok:false`不能宣称成功。金额首选整数分`*_cents`，不让模型算总额/利息，读取服务端计算结果。本轮金融核销仅支持账本本位币、同币种账户，不自动换汇。

## 选择模块和重试

- 亲友资金往来：借钱台账`/debts`。银行贷款、车贷、房贷和信用卡：`/finance`。工资/房租等固定收支：`/recurring`定期记账。会员套餐及续费：`/subscriptions`。
- 本金使用`lend/borrow/repay_receive/repay_pay/transfer`，分类为空，不计收入支出；实际贷款/信用卡利息是`expense`，手续费是`fee`。`interest`仍代表利息收入。
- 先读取对象、账户及现有流水，确认用户要求的是计划、已发生付款还是关联已有记录。计划和到期提醒不会产生实际还款，不声称已向银行支付。
- 贷款创建、实际还款、费用补记使用唯一`operation_key`（建议UUID），持久保存到操作完成；网络超时复用原key和完全相同参数重试。更正付款使用新key。同key参数不同会被拒绝。请求成功后以返回ID查询核验，不能把改key当重试。
- `confirm`、`confirm_sources`、`release_credit`、`confirm_revision`代表不同的具体确认范围。只在用户已经授权该范围时传true；不因技能或HTTP错误自行扩大授权。部分成功时逐项汇报，不重复整批入库。

## 实际交易时刻与录入时间

更正时省略日期保留原发生日；明确传`date/txn_date`为空串或null会被拒绝，不能清除日期或偷偷改成今天。

- 真实借出/借入、收还款、贷款/信用卡付款和已发生费用接收`date`（兼容`txn_date`）及可选`time`（兼容`txn_time`，`time`优先），格式`HH:mm`或`HH:mm:ss`，规范化为`HH:mm:ss`后保存并参与操作签名。重试保持原operation_key和请求字段；不为重试生成新时刻。
- 未提供时刻为`null`，不取调用/调度执行时刻；只有用户或原账单明确钟点才填写。`created_at`始终是系统录入时间。普通交易更新和付款`amend`省略时刻保留，显式`null`/空串清除，但已有来源保护仍生效。发生日期/时刻按`GET /ping`的`timezone`解释，相对日期先读`today/server_time`。
- 有已有来源时，付款采用资金账户扣款行的发生日期；未传时刻继承该来源。来源时刻已知时，显式冲突（包括清空）会拒绝；需要更正应通过受支持的来源更正流程，不用核销时刻覆盖来源事实。来源时刻未知时可补本次付款/新分项的实际时刻，原始来源及快照不修改，各来源原时刻独立保留。
- 来源预览返回`txn_date/txn_time/source_times`。付款详情/实际付款回执含`txn_date/txn_time/created_at`，分项transactions含各自时刻及两端`account_type/account_type_label`、`to_account_type/to_account_type_label`；付款头也有两端类型。恢复会核验来源日期与时刻没有变化，不能先改源流水再盲目恢复旧核销。
- 期初借钱登记`create_txn:false`和贷款`snapshot`没有本次资金事实，不传非空时刻。计划到期日、信用卡posted_date和实际发生时刻语义不同；定期/订阅只有计划日期时不猜时刻，不能把执行时间当消费时间。

## 普通记账账户资格

GET /accounts 每个账户含 type/type_label（如credit/信用卡、debit/储蓄卡）及 transaction_types 数组，列出普通记账可用类型；空数组不表示账户失效，只表示应在对应台账操作。普通收支（含订阅、定期消费）排除 loan/receivable/payable，保留 credit 消费和退款；普通 transfer 两端另外排除 credit，投资和其他自有资产账户仍可划转。借钱本金用实际资金账户，不能选择应收/应付账户代替现金流。

POST /transactions 及编辑、订阅、定期规则会在服务端检查，不符合时返回400。source 或 channel 请求字段不能获得金融服务权限。实际还款用 POST /finance/repayments；银行导入的已发生放款/还款可保留为待关联来源，再由金融服务确认核销，不新记第二次资金流。

首页两套口径同屏，不相加；GET /summary 及 /cashflow 等 API 统计口径保持原约定。

## 自动还款（2026-11-12）

- GET /finance/repayment-options 的信用卡对象新增 due_cents、prepaid_cents、suggested_amount_cents；贷款新增 next_installment（id/due_date/本金、利息、费用和amount_cents）及建议金额。
- 信用卡付款省略 allocations 时使用自动模式：按最早到期已出账账单抵扣，余款作为预还款，出账、退款、撤销/恢复及更正后自动重算关联。负账单退款余额在出账后自动抵扣后续待还。自动抵扣仅改变关联，不重复生成资金流水，不要求先确认银行账单。
- POST /finance/repayments 及 /finance/loans/:id/payments，正常贷款可省略principal_cents/interest_cents/fee_cents，提供amount_cents（须等于最近未还期总额）或完全使用该期计划。服务端带出分项及期次；同operation_key重试先返回原付款，不会因期次变化重复记账。实际分项与计划不同时必须明确提供分项。
- 付款响应新增 allocation_mode（auto/manual）；账单新增 credit_applied_cents（退款余额抵扣），remaining_cents已扣除它。普通调用不需要手动allocate；明确传allocations（含空数组）才转手动模式，后续仅改日期不能静默覆盖该安排。手工改额不足原指定账单金额时须明确调整分配。
- 银行金额校正是可选例外，已校正的金额/版本仍保留；不会因为简化界面擅自改回本地归集值。实际资金、更正、来源替换及撤销的既有保护继续有效。

## 借钱台账

`GET /debts`返回有效条目及应收/应还；`?show=deleted`查询已归档。`GET /debts/:id`含稳定ID、余额、历史关联流水，已归档也可查。

`POST /debts`：`counterparty,direction(receivable/payable),amount_cents,currency,account_id,date,time,due_date,note,create_txn,operation_key`。`create_txn:true`表示新发生借出/借入，生成本金流水；false只登记期初余额，不生成现金流。创建同名对象仍是独立借款。`POST /debts/:id`修改姓名、备注、到期日及`remind_enabled`，不改本金。

`POST /debts/:id/settle`：`account_id,amount_cents,date,time,operation_key`；金额省略表示全余额。生成实际收还并核销，拒绝超额；回执新增`txn_date/txn_time/created_at`，重试返回原记录的时间。普通`POST /transactions`可传明确`debt_id`；未知的收还款保持待关联，不能凭商家名自动选择对象。

`POST /debts/:id/link`：`transaction_id,opening_included`。仅补关联、不再记现金流，也不修改原流水的发生日期/时刻或录入时间。`opening_included:true`仅在用户确认该原流水已包含在登记期初余额时使用，避免重复改变台账本金。

`POST /debts/:id/delete`归档；`POST /debts/:id/restore`恢复，历史流水保留。

## 贷款合同和预计计划

读取：`GET /finance`总览；`GET /finance/loans`；`GET /finance/loans/:id`含账户、剩余本金、计划与付款；`GET /finance/loans/:id/installments`。

`POST /finance/loans`示例（已验证相同字段组合）：

```json
{"name":"车贷","kind":"car","institution":"示例银行","original_principal_cents":12000000,"remaining_principal_cents":12000000,"term_n":36,"annual_rate":3.6,"method":"equal_principal","start_date":"2026-11-01","due_day":20,"opening_mode":"snapshot","operation_key":"<持久化UUID>"}
```

`kind`为loan/car/mortgage；`method`为equal_payment/equal_principal/interest_only/manual；名义年利率用百分数。月末自动钳制，尾期分币归整。manual传`schedule:[{due_date,principal_cents,interest_cents,fee_cents}]`，本金和必须等于剩余本金。snapshot新建期初负债；可传已有`account_id`接管同币种loan账户，要求账面负债完全一致；disbursement新建贷款并传`funding_account_id`记录放款到账。不会改写已有账户余额来凑数。disbursement可传`time/txn_time`记录实际到账时刻，发生日期仍为`start_date`，详情的`disbursement`可核验真实流水；snapshot传非空时刻会拒绝。

`POST /finance/loans/:id`修改name/institution/remind_enabled；`/:id/delete`归档；`/:id/restore`恢复。

调整计划：`POST /finance/loans/:id/plan/preview`传新term_n/annual_rate/method/start_date/due_day或schedule，返回schedule、剩余本金及basis。用户审阅后`POST /finance/loans/:id/plan`传相同参数、`basis,confirm:true`；期间余额变化会拒绝，重新预览。已还部分和旧计划快照保留。

## 实际付款、已有来源及核销

`POST /finance/loans/:id/payments`：`account_id,principal_cents,interest_cents,fee_cents,date,time,operation_key`。账户为现金/储蓄/支付资金账户。服务计算总额；若同时传amount_cents，必须与分项和一致。可选`installment_id`；按银行实扣校正该期费用时传`adjust_installment:true`。也可传`allocations:[{installment_id,principal_cents,interest_cents,fee_cents}]`明确多期分配，分项合计必须等于付款；缺省按到期顺序分配。计划不足时先核对并调整，不能虚构金额。

`POST /finance/cards/:id/payments`：`account_id,amount_cents,date,time,operation_key`。产生一笔资金账户到信用卡的transfer，不重复记支出。可选`allocations:[{statement_id,amount_cents}]`，支持一笔多期、一期多笔。默认核销已出账且无待核对差异的账单，剩余保留为未分配预还款；溢缴款按真实账户余额显示。

**付款已经导入/记过时**：先调用`POST /finance/loans/:id/sources/preview`或`/finance/cards/:id/sources/preview`，传与付款相同的金额和账户及`existing_transaction_ids:[id]`（或单个existing_transaction_id）。正确等额transfer只关联；一条资金扣款expense/fee/未关联repay_pay，可再带一条目标账户等额income/refund/未关联repay_receive。返回来源ID、发生日期/时刻与原始`source_times`、原/整理后资金扣款及整理后费用，用户确认替换后在实际payments请求传相同来源及`confirm_sources:true`。来源替换会保留原记录、生成规范分项，不再叠加一份扣款；不确定来源时停止该写入并说明缺少的对应关系，不猜测或自动匹配。

`GET /finance/payments/:id`返回分项transactions、原始sources、allocations、撤销与更正状态。`POST /finance/payments/:id/amend`使用新operation_key及更正字段，原子撤销旧组并建立新组；旧组replaced_by指向更正记录。`/:id/reverse`要求`confirm:true`整体撤销；新建资金流水撤销，原有正确transfer只解除核销、资金流水保留。`/:id/restore`检查来源、账单/期次状态和余额后整体恢复，冲突会拒绝。信用卡`/:id/allocate`传完整allocations替换核销，不移动资金。

## 信用卡自动账单、银行校正、退款和分期

`GET /finance/cards`列信用卡账户；`POST /finance/cards/:id/configure`传bill_day(1–31)、due_day(1–31)、due_month_offset(0/1/2)、remind_enabled。必须明确还款月份，不推测；当月还款日不得早于账单日。初次设置可指定opening_closing（期初余额所属出账日），缺省本期；账户期初余额归入账单但不计消费。改账期从最后确认账单次日生效。

`GET /finance/cards/:id`返回余额、溢缴款、未分配预还款、账单及分期；`GET /finance/cards/:id/statements`；`POST /finance/cards/:id/refresh`重新归集。真实流水变更也会刷新。pending流水不归集，消费与退款按posted_date（缺省txn_date）入账，分期本金替代原消费全额归集，入账还款不会当收入抵销消费。

`GET /finance/statements/:id`返回items快照、expected_items当前归集、computed_cents、confirmed_cents、dirty、paid_cents、remaining_cents及修订记录。草稿可自动更新，已确认银行账单不会静默被覆盖。

`POST /finance/statements/:id/confirm`传`confirm:true,confirmed_cents,note`（金额省略采用当前归集）。银行金额允许有符号的贷项。低于已核销时，须用户明确同意`release_credit:true`，多余核销释放为未分配预还款，不移动现金。`/:id/unconfirm`传confirm:true，必要时release_credit，撤销确认后可整理原流水，旧版本保留。dirty账单须重新核对确认后再核销。金额校正不是造消费；缺少真实费用时使用下述费用接口。

`POST /finance/transactions/:id/posting`：posted_date，可选refund_of_id（仅同卡refund关联同卡原expense）。`POST /finance/transactions/:id/installment`：term_n(1–120)、first_closing、interest_cents、fee_cents；后两项仅为预计总费用，不提前产生支出。`POST /finance/plans/:id/cancel`取消计划；已确认账单来源先撤销账单确认再整理。活动分期原消费资金字段受控，须先取消分期。

`POST /finance/statements/:id/charges`：实际interest_cents、fee_cents、date、可选time、operation_key，可选interest_category_id/fee_category_id。产生真实卡片利息/费用流水；账单已确认时要用户确认`confirm_revision:true`并保留/明确传confirmed_cents银行总额，保存新版本。回执含`transaction_ids/txn_date/txn_time`；账单items及付款allocations也可读取真实时刻。不能把预计费用当实际费用重复入账。

`GET /transactions/:id`的transaction包含txn_date/txn_time/created_at、两端账户类型、debt_id、finance_payments、credit_statements、credit_plan、posted_date/refund_of_id/recurring_run_id。关联付款请在付款接口整体操作，不绕过受控分项。金融账户类型、币种、期初余额与账期受引用保护，不能通过账户编辑/删除/调整余额破坏台账。

## 定期记账边界与幂等

`GET /recurring`读取next_run_at及规则；`POST /recurring`传name、items（type为income/expense/fee/transfer）、frequency、interval_n、day_of_month、next_run_at、auto_post。transfer须有account_id/to_account_id。不在这里建立第二份贷款或信用卡还款计划。首次日期须是真实ISO日期。

`POST /recurring/:id/run`必须传`scheduled_date`等于读取到的next_run_at；可选date作为实际记账日。以规则ID+scheduled_date唯一执行，返回run_id/txn_ids/next_run_at，超时重试复用原scheduled_date。不要重新读新日期作为同次重试。`GET /recurring/:id/runs`查询执行记录；已软删除的执行流水不会因重复执行复活。

`GET /recurring/overlaps`只返回与订阅/金融计划可能重复的候选，匹配不代表事实相同。用户确认后`POST /recurring/:id/pause {"confirm":true}`暂停旧规则，保留已生成流水。toggle/delete仍可用。金融到期只发送提醒，不自动建立真实付款或重复定期规则。

## 记一笔还款入口与统一API

网页“记一笔 → 还款”（/transactions/new?type=repayment）可选择贷款或信用卡，复用相同付款、已有来源核对、核销和撤销恢复。还款是操作入口，不是新的transactions.type，不能向普通交易接口发送type=repayment。

- GET /finance/repayment-options：返回targets，每项target_kind（loan/card）、target_id、name、remaining_principal_cents。信用卡target_id是账户ID，贷款target_id是合同ID。
- POST /finance/repayments：传target_kind、target_id，以及对应贷款/信用卡实际付款的完整参数、operation_key；调用同一服务，权限/幂等/来源替换语义不变。

## 资金流与消费收支

首页、报表默认资金流，可显式切换basis=consumption查看消费收支。预算、年度消费报告、原消费问账继续使用消费口径，不能混称。用户问“实际资金流出/还款后现金少多少”使用cashflow；问“餐饮消费/消费预算”使用consumption，回复时说明口径。

- GET /cashflow?from=YYYY-MM-DD&to=YYYY-MM-DD&months=6&month=YYYY-MM：返回basis=cashflow、inflow/outflow/net（分）、income/expense别名、daily/trend、inflow_groups/outflow_groups；可加kind=expense或income、group=分组名、page/page_size，返回有分页的entries。
- GET /summary?basis=cashflow&from=&to=：顶层按资金流汇总，另有consumption及cashflow两个明确对象；原/summary缺省仍为consumption以保持已有调用语义。务必显式传basis，不根据数值猜测口径。
- GET /reports/categories?basis=cashflow及/reports/trend?basis=cashflow支持同口径；缺省仍为consumption。资金流分组不是收支分类ID，不拿它创建分类或传category_id。

资金账户限定cash/debit/virtual/prepaid。内部互转抵销；借入/放款/收回借款等入账为流入，还本/借出/转入投资等为流出；信用卡消费计消费，实际还款计资金流，不能把两套金额相加当支出。待确认流水与余额调整不算实际资金流，期初余额也不是本期入账。金额和分组取服务端SQL结果，模型不加总。

### 资金流分析与历史趋势（2026-11-12）

GET /cashflow 新增 analysis：outflow_count/inflow_count、avg_outflow、avg_daily_outflow（金额为整数分，空笔均/未来日均为null）、elapsed_days/effective_to、max_day、compare_from/compare_to、current_comparable/previous、change_pct、chart_unit/chart。日均只计算区间内截至今天的自然日，前期为零时change_pct=null，不解释为0%增长。完整月份比较上月；进行中的月份比较上月同进度；自定义区间比较紧邻等长前期。界面消费参考独立，不与资金流相加。

GET /cashflow 和 GET /reports/trend 支持可选 month=YYYY-MM，作为趋势截止月份；省略仍截至本月，非法月份返回400。cashflow分析日期须为真实日期且from<=to。GET /reports/trend 的消费口径也支持相同月份锚点。展示时说明区间与截止月份；本金和还款资格不变。


## 部分代垫与回收

所有金额为整数分，目前仅账本本位币、同币种；每组一个对方，可多次回收。先读取账户和消费分类。不要先创建普通 expense 再创建新代垫，否则会重复扣款；已有支出必须使用来源转换。

- `GET /advances`：有效代垫列表，`include_deleted=1` 包含撤销；返回 `advances` 数组。
- `GET /advances/:id`：付款头、transactions分项、collections回款，`amount_cents/personal_cents/advance_cents/received_cents/remaining_cents` 分别为总付、自用、代垫、已收、待收。
- `POST /advances`：`{operation_key,amount_cents,personal_cents,person,account_id,category_id?,currency?,txn_date?,txn_time?,note?,merchant?,tags?}`。例如总付10000、自用4000，服务算代垫6000；自用可0，必须小于总额。收支分类只用于自用。付款账户允许现金、储蓄卡、支付账户、预付及信用卡。
- 已有普通支出转换：在上述请求中加 `source_transaction_id` 与 `confirm_source:true`，金额/账户/币种须与来源相同，日期/已知时刻不得冲突。确认范围是替换原支出为消费与应收，原记录软停用并保留追溯，不再次扣款。已报销、分摊、分期、确认信用卡账单及其他业务来源不能绕过保护。
- `POST /advances/:id/amend`：完整提交与创建相同的付款字段及新的 operation_key，整体更正并返回新版本；原记录 replaced_by 指向新版本，已有回款须先撤销，已有来源的总额不能变。
- `POST /advances/:id/collect`：`{operation_key,amount_cents,account_id,txn_date?,txn_time?}`，account_id 为实际收款资金账户，不能信用卡；不超待收，日期不早于付款。返回回款及更新后的 `advance`。
- `POST /advances/:id/reverse`、`/restore`：整体撤销/恢复；有效回款须先撤销。转换来源的撤销会恢复原整笔支出，恢复代垫时再检查来源未变化。
- `POST /advance-collections/:id/reverse`、`/restore`：单次回款撤销/恢复，恢复重新检查待收容量和付款有效性。

create/collect 必填稳定 operation_key，同请求重试复用原结果，同key变参拒绝；撤销后同key重试仍返回原撤销记录，不自动复活。读允许账本成员，写要求可写成员，全部写入审计。不要用普通交易接口编辑、删除、恢复代垫分项或回款，不直接改“代垫待收款”账户的余额/类型/币种/净资产归属。

交易列表与recent按付款组只展示一张主单；`amount_cents` 保持该主资金分项的原语义，自用40对应4000，新增 `advance:{id,role,total_cents,personal_cents,advance_cents,person,primary_transaction_id}` 提供完整付款100。消费汇总4000，不能把 `advance.total_cents` 再相加。回款行有 `advance_collection:{advance_id}`。单笔详情同样返回关联；代垫详情 transactions 保留所有真实分项与来源。原始导出是资金分项，不是每行一张付款组。资金流笔数按实际付款组去重，分组明细仍可含多项。

例：11月付款100、自用40、代垫60：11月消费40、资金流出100、应收60；12月收回60：12月消费收入0、资金流入60、应收0。信用卡付款出账100；其后的信用卡还款仍用金融付款接口，不再次计消费。

普通交易列表 `sort=created_desc|created_asc` 按完整录入时间排序；网页按录入日分组同时标实际交易日。`/transactions/recent` 默认最近录入，补记旧账也能找到。`date_desc/date_asc` 仍按发生日期。普通合并视图的金额筛选/排序按显示付款总额，账户筛选为 `component_view:true` 分项视图，保留真实分项金额。
