'use strict';
/**
 * 账单导入 / 导出
 *  - 支付宝账单 CSV（GBK 编码，含表头说明行）
 *  - 微信支付账单 CSV（UTF-8）
 *  - 通用 CSV（按表头智能匹配）
 * 自动识别编码、自动映射分类与账户、自动去重
 */
const { all, get, run, tx, nowStr, todayStr, recalcBalances } = require('../db');
const { parseAmountToCents, monthOf } = require('./util');
const transactionTime = require('./transaction-time');
const { classifyByKeywords, guessAccountName, resolveCategoryId, resolveAccountId, cleanOwnerLabel } = require('./ai');

/* ------------------------------- 编码与 CSV ------------------------------- */

/** 支付宝导出为 GBK，微信为 UTF-8：先按 UTF-8 解，出现替换字符则按 GBK 重解 */
function decodeBuffer(buf) {
  const tryDecode = (enc) => {
    try { return new TextDecoder(enc, { fatal: false }).decode(buf); } catch { return null; }
  };
  const utf8 = tryDecode('utf-8');
  if (utf8 && !utf8.includes('\uFFFD')) return { text: utf8.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
  const gbk = tryDecode('gbk') || tryDecode('gb18030');
  if (gbk) return { text: gbk.replace(/^\uFEFF/, ''), encoding: 'gbk' };
  return { text: utf8 || '', encoding: 'utf-8' };
}

/** 支持引号包裹与转义的 CSV 行解析 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text) {
  const input = String(text || '');
  const rows = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '"') {
      if (quoted && input[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && (input[i] === '\n' || input[i] === '\r')) {
      const row = input.slice(start, i).trimEnd();
      if (row) rows.push(parseCsvLine(row));
      if (input[i] === '\r' && input[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  const last = input.slice(start).trimEnd();
  if (last) rows.push(parseCsvLine(last));
  return rows;
}

const HEADER_KEYS = ['交易时间', '交易分类', '交易类型', '金额', '收/支', '收/付款方式', '支付方式', '日期', '时间', 'amount', 'date'];

function isHeaderRow(cells) {
  const joined = cells.join(',');
  return HEADER_KEYS.some((k) => joined.includes(k)) && cells.length >= 4;
}

/** 表头名 → 索引（支持模糊） */
function headerIndex(header, candidates) {
  for (const c of candidates) {
    const i = header.findIndex((h) => h === c);
    if (i >= 0) return i;
  }
  for (const c of candidates) {
    const i = header.findIndex((h) => h && h.includes(c));
    if (i >= 0) return i;
  }
  return -1;
}

function detectSource(headerLine, fullText) {
  const h = headerLine.join(',');
  if (h.includes('交易分类') || /支付宝/.test(fullText.slice(0, 2000))) return 'alipay';
  if (h.includes('交易类型') || h.includes('当前状态') || /微信/.test(fullText.slice(0, 2000))) return 'wechat';
  return 'generic';
}

/* ------------------------------- 单条规范化 ------------------------------- */

const SKIP_STATUS = /已关闭|交易关闭|已退款|全额退款|退款成功|失败|已撤销|已取消|待付款|待收货|银行处理中|已退回/;

/** 导出 CSV type_key 列的合法值 */
const TXN_KEYS = new Set(['expense','income','transfer','lend','borrow','repay_receive','repay_pay','reimburse','refund','fee','interest','invest_buy','invest_sell','adjust']);

function normalizeRow({ date, time, clockSource, direction, amountText, currencyText, baseAmountText, merchant, desc, categoryText, accountText, toAccountText, status, orderNo, typeKey, ownerText, noRhythmText }) {
  const amountCents = parseAmountToCents(amountText);
  const dir = String(direction || '').trim();
  const key = String(typeKey || '').trim();
  let type = 'expense';
  let neutral = false;
  if (TXN_KEYS.has(key)) {
    // 回导自家导出的 CSV：type_key 机读列优先精确还原。人读「类型」列是中文标签，
    // 靠正则只能认出支出/收入，转账/借贷/投资/调整等会整体漂移（v1.4.1 导出列此前在导入侧未接线）
    type = key;
  } else if (/不计/.test(dir)) {
    // 转账 / 提现 / 充值 等「不计收支」记录：默认不导入（成对记录只导一半会破坏余额）
    type = 'transfer';
    neutral = true;
  } else if (/^\/?$/.test(dir) || !dir) {
    // 微信账单里零钱充值/提现/亲属卡等行的「收/支」列是 "/"——同属资金搬移，归入不计收支
    type = 'transfer';
    neutral = true;
  } else if (/收入|收/.test(dir)) type = 'income';
  else if (/支出|支/.test(dir)) type = 'expense';
  const text = `${categoryText || ''} ${desc || ''} ${merchant || ''}`;
  let txnDate,txnTime=null,importError=null;
  try {
    txnDate=normalizeDate(date);
    if(time===undefined&&clockSource&&/\d{4}[-\/年.]/.test(clockSource)&&normalizeDate(clockSource)!==txnDate)throw Error('交易日期与完整交易时间不一致');
    const rawTime=time===undefined?timeFromDate(clockSource===undefined?date:clockSource):time;
    txnTime=transactionTime.normalizeTime(rawTime ? String(rawTime).trim().replace(/^(\d):/,'0$1:') : null);
  } catch(e) {
    txnDate=String(date||'').slice(0,40);
    importError=e.message;
  }
  const rawCurrency = String(currencyText || '').trim().toUpperCase();
  let currency = null;
  if (rawCurrency) {
    if (/^[A-Z]{3}$/.test(rawCurrency)) currency = rawCurrency;
    else {
      currency = rawCurrency.slice(0, 10);
      if (!importError) importError = '币种格式无效，应为三位字母代码（如 CNY、USD）';
    }
  }
  const rawBase = String(baseAmountText || '').trim();
  let baseAmountCents = null;
  if (rawBase) {
    const parsedBase = parseAmountToCents(rawBase);
    if (!parsedBase) {
      if (!importError) importError = '折算金额格式无效';
    } else if (type === 'adjust' && amountCents && Math.sign(parsedBase) !== Math.sign(amountCents)) {
      if (!importError) importError = '折算金额方向与原币金额不一致';
    } else {
      baseAmountCents = parsedBase;
    }
  }
  return {
    skip: false,
    neutral,
    type,
    amount_cents: amountCents,
    currency,
    base_amount_cents: baseAmountCents,
    txn_date: txnDate,
    txn_time: txnTime,
    import_error: importError,
    merchant: (merchant || desc || '').slice(0, 60) || null,
    note: [categoryText, desc, status].filter(Boolean).join(' · ').slice(0, 200) || null,
    category_hint: categoryText || null,
    text,
    account_hint: accountText || guessAccountName(text) || null,
    to_account_hint: toAccountText || null,
    // 归属人（P11）：自家导出的「归属人」列回读；微信/支付宝原生账单无此列，恒空
    owner_label: cleanOwnerLabel(ownerText),
    // 一次性大额（P7 修订）：自家导出的「一次性大额」列回读（1/是），外部账单无此列恒 0
    no_rhythm: /^(1|是|y|yes)$/i.test(String(noRhythmText || '').trim()) ? 1 : 0,
    order_no: orderNo || null,
  };
}

function normalizeDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/);
  if (m) return transactionTime.normalizeDate(`${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`);
  m = s.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (m) return transactionTime.normalizeDate(`${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`);
  return transactionTime.normalizeDate(s,todayStr());
}

function timeFromDate(value) {
  const s=String(value||'').trim();
  const m=/(?:^|[T\s])(\d{1,2}:\d{2}(?::\d{2})?)(?=$|\s)/.exec(s);
  if(m)return m[1];
  if(/[T\s]\d+:/.test(s))throw Error('交易时刻格式无效');
  return null;
}

// 独立「时间」列只能精确匹配，避免误抓「交易时间」「最近修改时间」。
function headerName(value) {return String(value||'').replace(/[（(].*?[)）]/g,'').trim().toLowerCase();}
function exactHeaderIndex(header,candidates) {
  return header.findIndex(h=>candidates.includes(headerName(h)));
}

/* --------------------------------- 主解析器 -------------------------------- */

function parseBill(buffer) {
  const { text, encoding } = decodeBuffer(buffer);
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex(isHeaderRow);
  if (headerIdx < 0) {
    return { source: 'unknown', encoding, header: [], records: [], totalLines: rows.length, error: '未找到有效表头，请确认为支付宝/微信导出的 CSV 账单' };
  }
  const header = rows[headerIdx];
  const source = detectSource(header, text);
  const body = rows.slice(headerIdx + 1).filter((r) => r.length > 2 && r.join('').replace(/[-,\s]/g, '').length > 0);

  const iDate = exactHeaderIndex(header,['交易日期','日期','date','txn_date']);
  const timestampIndices=['付款时间','交易时间','交易创建时间'].map(name=>exactHeaderIndex(header,[name])).filter(i=>i>=0);
  const iTime = exactHeaderIndex(header,['时间','时刻','交易时刻','time','txn_time']);
  const iDir = headerIndex(header, ['收/支', '收支', '类型', '方向']);
  const iAmount = headerIndex(header, ['金额(元)', '金额', 'amount']);
  const iCurrency = exactHeaderIndex(header, ['币种', '货币', 'currency']);
  const iBaseAmount = exactHeaderIndex(header, ['折算金额', '本位币金额', 'amount_base', 'base_amount']);
  const iMerchant = headerIndex(header, ['交易对方', '对方', 'merchant', '商家']);
  const iOwner = headerIndex(header, ['归属人', 'owner']);
  const iNoRhythm = headerIndex(header, ['一次性大额', 'no_rhythm']);
  const iDesc = headerIndex(header, ['商品说明', '商品', '备注', '描述', '说明', 'note', 'detail']);
  const iCategory = headerIndex(header, ['交易分类', '分类', 'category']);
  const iAccount = headerIndex(header, ['收/付款方式', '支付方式', '付款方式', '账户', 'account']);
  const iStatus = headerIndex(header, ['当前状态', '交易状态', '状态', 'status']);
  const iOrder = headerIndex(header, ['交易订单号', '交易单号', '订单号', 'order']);
  const iTypeKey = headerIndex(header, ['type_key']);
  const iToAccount = headerIndex(header, ['转入账户', '对方账户', 'to_account']);

  const records = [];
  const neutralRecords = []; // 提现 / 充值 / 余额宝转出等「不计收支」记录，默认不入库
  let skipped = 0;
  for (const r of body) {
    const status = iStatus >= 0 ? r[iStatus] : '';
    if (status && SKIP_STATUS.test(status)) { skipped++; continue; }
    const timestampIndex=timestampIndices.find(i=>r[i]);
    const norm = normalizeRow({
      date: (iDate>=0?r[iDate]:'') || (timestampIndex===undefined?'':r[timestampIndex]),
      time: iTime>=0?(r[iTime]||''):undefined,
      // 订单创建时间不是付款时刻：只在没有其他日期时沿用其日期，不伪造发生时刻。
      clockSource: timestampIndex===undefined?undefined:headerName(header[timestampIndex])==='交易创建时间'?'':r[timestampIndex],
      direction: iDir >= 0 ? r[iDir] : '',
      amountText: iAmount >= 0 ? r[iAmount] : '',
      currencyText: iCurrency >= 0 ? r[iCurrency] : '',
      baseAmountText: iBaseAmount >= 0 ? r[iBaseAmount] : '',
      merchant: iMerchant >= 0 ? r[iMerchant] : '',
      desc: iDesc >= 0 ? r[iDesc] : '',
      categoryText: iCategory >= 0 ? r[iCategory] : '',
      accountText: iAccount >= 0 ? r[iAccount] : '',
      toAccountText: iToAccount >= 0 ? r[iToAccount] : '',
      status,
      orderNo: iOrder >= 0 ? r[iOrder] : '',
      typeKey: iTypeKey >= 0 ? r[iTypeKey] : '',
      ownerText: iOwner >= 0 ? r[iOwner] : '',
      noRhythmText: iNoRhythm >= 0 ? r[iNoRhythm] : '',
    });
    if (norm.skip || !norm.amount_cents) { skipped++; continue; }
    if (iTypeKey >= 0 && iDesc >= 0) norm.note = r[iDesc]?.slice(0, 300) || null;
    if (norm.neutral) neutralRecords.push(norm);
    else records.push(norm);
  }
  return { source, encoding, header, records, neutralRecords, totalLines: rows.length, skipped };
}

/* --------------------------------- 执行导入 -------------------------------- */

function ensureAccount(ledgerId, name, createdList, defaultCurrency = 'CNY') {
  if (!name) return null;
  const id = resolveAccountId(ledgerId, name);
  if (id) return id;
  const type = /信用/.test(name) ? 'credit' : /支付宝|微信|京东|云闪付/.test(name) ? 'virtual' : /银行|卡/.test(name) ? 'debit' : 'other';
  const icon = type === 'credit' ? '💳' : type === 'virtual' ? '📱' : type === 'debit' ? '🏦' : '📦';
  const r = run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, note, created_at)
     VALUES (?,?,?,?,?,0,0,999,?,?)`,
    ledgerId, String(name).slice(0, 30), type, icon, defaultCurrency, '由账单导入自动创建', nowStr()
  );
  createdList.push(name);
  return r.lastInsertRowid;
}

/** 规范化单条导入记录的币种与估值参数（预览与提交共用同一边界规则） */
function resolveImportValuation(ledgerId, rec, accountId = null, toAccountId = null) {
  const ledgerBase = get('SELECT currency FROM ledgers WHERE id = ?', ledgerId)?.currency || 'CNY';
  const currency = rec.currency ? String(rec.currency).trim().toUpperCase() : ledgerBase;
  if (!/^[A-Z]{3}$/.test(currency)) throw Error('币种格式无效，应为三位字母代码（如 CNY、USD）');
  const signedAmount = rec.type === 'adjust' ? rec.amount_cents : Math.abs(rec.amount_cents);
  if (!signedAmount) throw Error('金额必须大于 0');
  const fxOptions = {};
  if (rec.base_amount_cents != null) {
    const signedBase = rec.type === 'adjust' ? rec.base_amount_cents : Math.abs(rec.base_amount_cents);
    if (!signedBase) throw Error('折算金额格式无效');
    if (rec.type === 'adjust' && Math.sign(signedBase) !== Math.sign(signedAmount)) throw Error('折算金额方向与原币金额不一致');
    if (currency === ledgerBase) {
      if (signedBase !== signedAmount) throw Error(`本位币（${ledgerBase}）记录的折算金额与原币金额不一致`);
    } else {
      fxOptions.settlement_amount_cents = signedBase;
    }
  }
  const value = require('./fx').transactionValuation(ledgerId, currency, signedAmount, fxOptions, accountId, toAccountId);
  return { ledgerBase, currency, signedAmount, value };
}

/** 「不计收支」记录（提现/充值）找不到对方账户时使用的兜底账户，保证转账双边平衡 */
const NEUTRAL_FALLBACK_ACCOUNT = '外部往来账户';

/**
 * 把解析结果写入数据库
 * @param {object} o
 * @param {boolean} [o.includeNeutral] 是否同时导入「不计收支」记录（提现 / 充值等）
 * @returns {{imported:number, skipped:number, failed:number, createdAccounts:string[], jobId:number}}
 */
function importRecords({
  ledgerId, userId, records, neutralRecords = [], includeNeutral = false,
  source, fileName, autoCreateAccount = true, defaultAccountId = null,
}) {
  const createdAccounts = [];
  const errors = [];
  let imported = 0, skipped = 0, failed = 0;
  const ledgerBase = get('SELECT currency FROM ledgers WHERE id = ?', ledgerId)?.currency || 'CNY';
  const list = includeNeutral ? records.concat(neutralRecords) : records.slice();
  const dupSet = new Set(),baseSet = new Set(),unknownSet = new Set();
  // 预载已有记录指纹，避免重复导入（含币种，防止同额不同币误判重）
  for (const t of all(
    'SELECT txn_date, txn_time, currency, amount_cents, merchant FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND source = ?',
    ledgerId, 'import'
  )) {
    const cur = String(t.currency || 'CNY').toUpperCase();
    const base=`${t.txn_date}|${cur}|${t.amount_cents}|${t.merchant || ''}`;
    baseSet.add(base);
    dupSet.add(`${base}|${t.txn_time||''}`);
    if(!t.txn_time)unknownSet.add(base);
  }

  tx(() => {
    for (const rec of list) {
      const createdBefore = createdAccounts.length;
      try {
        require('../db').db.exec('SAVEPOINT import_row');
        if(rec.import_error)throw Error(rec.import_error);
        const txnDate=transactionTime.normalizeDate(rec.txn_date,todayStr());
        const txnTime=transactionTime.normalizeTime(rec.txn_time);
        const currency = rec.currency ? String(rec.currency).trim().toUpperCase() : ledgerBase;
        if (!/^[A-Z]{3}$/.test(currency)) throw Error('币种格式无效，应为三位字母代码（如 CNY、USD）');
        // 余额调整回导保留负金额（调减为带符号数），方向不能翻转；
        // 但 expense/income 直接以负数入库会把方向写反（txnEffects 对 expense 取 -a），钳回正数
        const signedAmount = rec.type === 'adjust' ? rec.amount_cents : Math.abs(rec.amount_cents);
        const base = `${txnDate}|${currency}|${signedAmount}|${rec.merchant || ''}`;
        const fp = `${base}|${txnTime||''}`;
        if (txnTime ? dupSet.has(fp)||unknownSet.has(base) : baseSet.has(base)) { skipped++; require('../db').db.exec('RELEASE import_row'); continue; }

        let categoryId = null;
        let toAccountId = null;
        const accountId = autoCreateAccount
          ? ensureAccount(ledgerId, rec.account_hint, createdAccounts, ledgerBase) || defaultAccountId
          : resolveAccountId(ledgerId, rec.account_hint) || defaultAccountId;

        if (rec.neutral) {
          // 提现 / 充值：账户之间搬钱，不计入收支。对方账户优先取回导的「转入账户」列，再从说明文字推断
          const cpName = rec.to_account_hint || guessAccountName(rec.text) || NEUTRAL_FALLBACK_ACCOUNT;
          toAccountId = autoCreateAccount
            ? ensureAccount(ledgerId, cpName, createdAccounts, ledgerBase) || ensureAccount(ledgerId, NEUTRAL_FALLBACK_ACCOUNT, createdAccounts, ledgerBase)
            : resolveAccountId(ledgerId, rec.to_account_hint) || resolveAccountId(ledgerId, guessAccountName(rec.text)) || null;
        } else if (rec.type === 'transfer' || rec.type === 'invest_buy' || rec.type === 'invest_sell') {
          // 回导的双边类型（转账/借贷/投资）：对方账户优先取「转入账户」列，其次从说明文字推断；推不出就按 transfer 兜底（一方账户仍保留）
          const cpName = rec.to_account_hint || guessAccountName(rec.text) || NEUTRAL_FALLBACK_ACCOUNT;
          toAccountId = autoCreateAccount
            ? ensureAccount(ledgerId, cpName, createdAccounts, ledgerBase)
            : resolveAccountId(ledgerId, rec.to_account_hint) || resolveAccountId(ledgerId, guessAccountName(rec.text)) || null;
          if (!toAccountId) rec.type = 'transfer';
        } else if (!require('./txn').PRINCIPAL_TYPES.includes(rec.type)) {
          const kind = rec.type === 'income' ? 'income' : 'expense';
          // P8：预览阶段富化的分类直接采信（服务端 previewCache 产生，提交侧仍校验存在/未归档/kind 相符——纵深防御）
          const pre = require('./categories').find(ledgerId, rec.category_id, true);
          if (pre && pre.kind === kind) categoryId = pre.id;
          const kw = classifyByKeywords(rec.text);
          if (rec.category_hint) {
            // hint 解析成功才覆盖（可能覆盖 pre——但富化本就跳过 hint 可解析的记录，两者互斥）；
            // 解析失败必须保留 pre：微信/支付宝真实账单普遍带「交易分类」列，很多值默认树解析不了，
            // 无条件赋 null 会把富化结果打掉（预览与落库不一致）
            const hintId = resolveCategoryId(ledgerId, rec.category_hint, kind);
            if (hintId) categoryId = hintId;
          }
          if (!categoryId && kw) categoryId = resolveCategoryId(ledgerId, kw.category, kw.kind === 'income' ? 'income' : kind);
          if (!categoryId) categoryId = resolveCategoryId(ledgerId, kind === 'income' ? '其他收入' : '其他支出', kind);
        }
        require('./finance/common').account(ledgerId,accountId);
        if(rec.type==='adjust'&&require('./finance/account-guard').bound(ledgerId,accountId))throw Error('金融账户不能通过导入调整余额，请在对应台账核对本金及实际流水');
        if(toAccountId)require('./finance/common').account(ledgerId,toAccountId);
        if(['transfer','invest_buy','invest_sell'].includes(rec.type)&&(!toAccountId||Number(toAccountId)===Number(accountId)))throw Error('转账与投资交易须有两个不同的当前账本账户');
        require('./account-policy').validate(ledgerId,rec.type,accountId,toAccountId,'import');
        const { value } = resolveImportValuation(ledgerId, { ...rec, currency }, accountId, toAccountId);

        const inserted=run(
          `INSERT INTO transactions
           (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
            user_id, txn_date, txn_time, note, merchant, status, source, ai_json, owner_label, no_rhythm, created_at, updated_at,
            rate_source, rate_date, account_amount_cents, to_account_amount_cents)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ledgerId, rec.type, signedAmount, currency, value.rate, value.amountBase,
          accountId, toAccountId, categoryId, userId, txnDate, txnTime, rec.note, rec.merchant,
          'cleared', 'import', JSON.stringify({ source, order_no: rec.order_no, neutral: !!rec.neutral }),
          rec.owner_label || null,
          rec.no_rhythm ? 1 : 0,
          nowStr(), nowStr(), value.source, value.date, value.accountAmount, value.toAccountAmount
        );
        if(require('./txn').PRINCIPAL_TYPES.includes(rec.type))run('UPDATE transactions SET category_id=NULL WHERE id=?',inserted.lastInsertRowid);
        require('./borrowing').record(ledgerId,inserted.lastInsertRowid,null,true);
        require('./borrowing').recalculate(ledgerId);
        require('./finance/cards').afterTransactions(ledgerId,[inserted.lastInsertRowid]);
        require('../db').db.exec('RELEASE import_row');
        dupSet.add(fp);
        baseSet.add(base);
        if(!txnTime)unknownSet.add(base);
        imported++;
      } catch (e) {
        require('../db').db.exec('ROLLBACK TO import_row');require('../db').db.exec('RELEASE import_row');
        createdAccounts.length = createdBefore;
        if(errors.length<50)errors.push({date:rec.txn_date,merchant:rec.merchant||null,error:e.message});
        failed++;
      }
    }
  });

  // 导入是直接写表，必须重算账户余额，否则余额与流水不一致
  if (imported > 0) recalcBalances(ledgerId);

  const job = run(
    `INSERT INTO import_jobs (ledger_id, user_id, source, file_name, total, imported, skipped, failed, status, message, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, userId, source, fileName, list.length, imported, skipped, failed, 'done',
    [createdAccounts.length?`自动创建账户：${createdAccounts.join('、')}`:'',...errors.map(e=>`${e.merchant||e.date}：${e.error}`)].filter(Boolean).join('；').slice(0,4000)||null, nowStr()
  );
  return { imported, skipped, failed, createdAccounts, errors, jobId: job.lastInsertRowid };
}

/* --------------------------------- 导出 ---------------------------------- */

function csvEscape(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // 公式注入防护：以 = + - @ 开头的单元格加前缀，防止 Excel/WPS 打开时当公式执行
  if (/^[=+\-@]/.test(s)) s = `'` + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  // 加 BOM 让 Excel 正确识别 UTF-8
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// 「类型」是人读中文 label，type_key 是机读枚举（回导时优先用它精确还原类型）；
// 「一次性大额」是 P7 修订的人工标记（1/空），回读后预测节奏外推必剔
const EXPORT_HEADER = ['日期', '时间', '类型', '金额', '币种', '折算金额', '分类', '账户', '转入账户', '成员', '归属人', '一次性大额', '商家', '备注', '标签', '来源', '状态', '备注2', 'type_key'];

function exportRows(ledgerId, rows) {
  return rows.map((t) => [
    t.txn_date, t.txn_time || '', t.type_label || t.type, (t.amount_cents / 100).toFixed(2), t.currency,
    (t.amount_base_cents / 100).toFixed(2), t.category_path || '', t.account_name || '',
    t.to_account_name || '', t.member_name || '', t.owner_label || '',
    Number(t.no_rhythm) === 1 ? '1' : '', t.merchant || '', t.note || '',
    t.tag_names || '', t.source, t.status, '', t.type,
  ]);
}

module.exports = { parseBill, importRecords, resolveImportValuation, toCsv, csvEscape, EXPORT_HEADER, exportRows, decodeBuffer, normalizeDate, parseCsvLine };
