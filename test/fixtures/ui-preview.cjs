// This fixture always writes its own disposable preview directory.
const path=require('node:path');
const safeRoot=path.resolve(__dirname,'../../.tmp');
const chosen=path.resolve(process.env.UI_FIXTURE_DIR||path.join(safeRoot,'data-ui-preview'));
if(!chosen.startsWith(safeRoot+path.sep))throw new Error('演示数据必须位于项目 .tmp 下');
process.env.DATA_DIR=chosen;
const db=require('../../src/db');
db.init();
const txn=require('../../src/lib/txn');
const auth=require('../../src/lib/auth');
db.setSetting('site.allow_register','true');
if(!db.get("SELECT id FROM users WHERE username='qa_empty'"))db.run("INSERT INTO users(username,password_hash,display_name,created_at)VALUES('qa_empty',?,'新成员',?)",auth.hashPassword('testpass123'),db.nowStr());
if(!db.get("SELECT id FROM ledger_invites WHERE code='ui-qa-invite'"))db.run("INSERT INTO ledger_invites(ledger_id,code,role,created_by,created_at)VALUES(1,'ui-qa-invite','viewer',1,?)",db.nowStr());
const uid=db.get("SELECT id FROM users WHERE username='admin'").id;
const acc=db.get("SELECT id FROM accounts WHERE ledger_id=1 AND name='银行卡'").id;
if(!db.get("SELECT id FROM transactions WHERE merchant='UI 演示工资'")){
 const salary=db.get("SELECT id FROM categories WHERE name='工资' AND kind='income'").id;
 const bonus=db.get("SELECT id FROM categories WHERE name='奖金' AND kind='income'")?.id||salary;
 for(const [amount,cat,merchant]of [[1880000,salary,'UI 演示工资'],[240000,bonus,'UI 演示奖金']]) txn.createTransaction(1,uid,{type:'income',amount_cents:amount,account_id:acc,category_id:cat,txn_date:db.todayStr(),merchant});
 for(const [name,target,saved]of [['下一站，去旅行',1500000,960000],['家里的安心储备',10000000,4250000]])db.run("INSERT INTO goals(ledger_id,name,icon,target_cents,saved_cents,status,created_at)VALUES(1,?,'🎯',?,?,'active',?)",name,target,saved,db.nowStr());
}
for(const [word,name]of [['食堂','午餐'],['外卖','午餐'],['油','加油'],['超市','日用品'],['烧烤','晚餐'],['孩子','零食']]){
 const cat=db.get("SELECT id FROM categories WHERE name=? AND kind='expense'",name)?.id;
 if(cat)db.run("UPDATE transactions SET category_id=? WHERE ledger_id=1 AND type='expense' AND merchant LIKE ?",cat,'%'+word+'%');
}

db.run("UPDATE transactions SET note=? WHERE merchant IN (?,?)", "长备注与详情阅读验证。".repeat(25), "UI 演示工资", "UI 演示奖金");
