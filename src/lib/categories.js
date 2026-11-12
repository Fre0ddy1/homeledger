'use strict';
// Shared templates remain immutable. A ledger gets private copies on first edit.
const { all, get, run, tx, nowStr, getSetting, setSetting } = require('../db');
const u = require('./util');

function resolveId(ledgerId, id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return Number(get('SELECT category_id FROM category_copies WHERE ledger_id=? AND source_id=?', ledgerId, n)?.category_id || n);
}
function find(ledgerId, id, activeOnly = false) {
  const c = get('SELECT * FROM categories WHERE id=? AND (ledger_id=? OR ledger_id IS NULL)', resolveId(ledgerId, id), ledgerId);
  if (!c) return null;
  if (activeOnly && (c.is_archived || (c.parent_id && get('SELECT is_archived FROM categories WHERE id=?', c.parent_id)?.is_archived))) return null;
  return c;
}
function forUpdate(ledgerId,id,existingId) {
  return find(ledgerId,id,resolveId(ledgerId,id)!==Number(existingId));
}
function list(ledgerId, kind = null, includeArchived = false) {
  const rows = all(`SELECT c.*, p.name AS parent_name, p.is_archived AS parent_archived FROM categories c
    LEFT JOIN categories p ON p.id=c.parent_id
    WHERE (c.ledger_id=? OR (c.ledger_id IS NULL AND NOT EXISTS
      (SELECT 1 FROM category_copies m WHERE m.ledger_id=? AND m.source_id=c.id)))
    ORDER BY c.kind DESC, COALESCE(p.sort_order,c.sort_order),c.sort_order,c.id`, ledgerId, ledgerId);
  return rows.filter(c => (!kind || c.kind === kind) && (includeArchived || (!c.is_archived && !c.parent_archived)));
}
function materialize(ledgerId) {
  return tx(() => {
    const sources = all(`SELECT c.* FROM categories c WHERE c.ledger_id IS NULL AND NOT EXISTS
      (SELECT 1 FROM category_copies m WHERE m.ledger_id=? AND m.source_id=c.id) ORDER BY c.id`, ledgerId);
    if (!sources.length) return;
    const map = new Map(all('SELECT source_id,category_id FROM category_copies WHERE ledger_id=?', ledgerId).map(r => [Number(r.source_id), Number(r.category_id)]));
    for (const c of sources) {
      const id = run('INSERT INTO categories(ledger_id,name,kind,parent_id,icon,color,is_system,is_archived,sort_order,deleted_at) VALUES(?,?,?,NULL,?,?,?,?,?,?)', ledgerId,c.name,c.kind,c.icon,c.color,c.is_system,c.is_archived,c.sort_order,c.deleted_at).lastInsertRowid;
      run('INSERT INTO category_copies(ledger_id,source_id,category_id) VALUES(?,?,?)', ledgerId,c.id,id);
      map.set(Number(c.id),id);
    }
    for (const c of sources) run('UPDATE categories SET parent_id=? WHERE id=?', c.parent_id ? (map.get(Number(c.parent_id)) || c.parent_id) : null,map.get(Number(c.id)));
    for (const [source,copy] of map) {
      for (const table of ['transactions','budgets','subscriptions']) run(`UPDATE ${table} SET category_id=? WHERE ledger_id=? AND category_id=?`,copy,ledgerId,source);
      run('UPDATE categories SET parent_id=? WHERE ledger_id=? AND parent_id=?',copy,ledgerId,source);
      for (const field of ['recommended','confirmed']) run(`UPDATE habit_feedback SET ${field}=? WHERE ledger_id=? AND field='category' AND ${field}=?`,String(copy),ledgerId,String(source));
    }
    // Preserve all three historical payload shapes, and every unrelated field.
    const remap = item => {
      if (!item || typeof item !== 'object') return;
      if (Array.isArray(item)) { item.forEach(remap); return; }
      if (item.category_id && map.has(Number(item.category_id))) item.category_id=map.get(Number(item.category_id));
      if (Array.isArray(item.items)) item.items.forEach(remap);
    };
    for (const rule of all('SELECT id,payload FROM recurring_rules WHERE ledger_id=?',ledgerId)) {
      let payload;
      try { payload=JSON.parse(rule.payload); } catch { throw new Error('周期账单数据无法读取，分类修改已取消'); }
      remap(payload); run('UPDATE recurring_rules SET payload=? WHERE id=?',JSON.stringify(payload),rule.id);
    }
    const key='dict.categories.'+ledgerId;
    let dict;
    try { dict=JSON.parse(getSetting(key,'[]')); } catch { throw new Error('分类词典数据无法读取，分类修改已取消'); }
    if (!Array.isArray(dict)) throw new Error('分类词典格式异常，分类修改已取消');
    remap(dict); if (dict.length) setSetting(key,JSON.stringify(dict));
  });
}
function mutable(ledgerId,id) {
  const existing=find(ledgerId,id);
  if (!existing) throw new Error('分类不存在或不属于当前账本');
  if (existing.ledger_id === null) materialize(ledgerId);
  const c=find(ledgerId,id);
  if (!c || Number(c.ledger_id)!==ledgerId) throw new Error('分类不存在或不属于当前账本');
  return c;
}
function create(ledgerId,body) {
  const name=String(body.name||'').trim().slice(0,20);
  if (!name) throw new Error('请填写分类名称');
  const kind=body.kind==='income'?'income':'expense';
  const parent=body.parent_id ? find(ledgerId,body.parent_id,true) : null;
  if (body.parent_id && (!parent || parent.parent_id || parent.kind!==kind)) throw new Error('请选择当前账本同类型的有效一级分类');
  return run('INSERT INTO categories(ledger_id,name,kind,parent_id,icon,color,is_system,sort_order) VALUES(?,?,?,?,?,?,0,999)',ledgerId,name,kind,parent?.id||null,String(body.icon||'🏷️').slice(0,8),u.safeColor(body.color,parent?.color||'#8c8c8c')).lastInsertRowid;
}
function update(ledgerId,id,body) {
  return tx(() => {
    const c=mutable(ledgerId,id);
    const name=String(body.name??c.name).trim().slice(0,20);
    if (!name) throw new Error('请填写分类名称');
    let parentId=c.parent_id;
    if (Object.prototype.hasOwnProperty.call(body,'parent_id')) {
      if (!c.parent_id) {
        if (body.parent_id!==null && body.parent_id!=='') throw new Error('一级分类不能调整为二级分类');
      } else {
        const parent=find(ledgerId,body.parent_id,true);
        if (!parent || parent.parent_id || parent.kind!==c.kind) throw new Error('请选择当前账本同类型的有效一级分类');
        if (Number(parent.id)!==Number(c.parent_id) && !find(ledgerId,c.id,true)) throw new Error('请先恢复分类及其所属一级分类，再调整所属一级分类');
        parentId=parent.id;
      }
    }
    run('UPDATE categories SET name=?,icon=?,color=?,parent_id=? WHERE id=? AND ledger_id=?',name,String(body.icon||c.icon).slice(0,8),u.safeColor(body.color,c.color),parentId,c.id,ledgerId);
    return c.id;
  });
}
function archive(ledgerId,id) {
  return tx(() => { const c=mutable(ledgerId,id); run('UPDATE categories SET is_archived=1,deleted_at=COALESCE(deleted_at,?) WHERE id=? AND ledger_id=?',nowStr(),c.id,ledgerId); return c.id; });
}
function restore(ledgerId,id) {
  return tx(() => {
    const c=mutable(ledgerId,id);
    if (c.parent_id && get('SELECT is_archived FROM categories WHERE id=?',c.parent_id)?.is_archived) throw new Error('请先恢复该分类所属的一级分类');
    run('UPDATE categories SET is_archived=0,deleted_at=NULL WHERE id=? AND ledger_id=?',c.id,ledgerId); return c.id;
  });
}
module.exports={resolveId,find,forUpdate,list,materialize,create,update,archive,restore};
