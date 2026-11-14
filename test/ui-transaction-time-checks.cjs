module.exports=async function(browser,session,base){
 const checks=[],runId=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6);
 async function choose(select,value){
  const index=await select.evaluate((el,v)=>[...el.options].findIndex(o=>o.value===v),value);
  const wrapper=select.locator('..'),trigger=wrapper.locator('.hl-select-trigger');
  if(await trigger.count()){await trigger.click();await wrapper.locator('.hl-select-opt').nth(index).click();}else await select.selectOption(value);
 }
 for(const native of [false,true])for(const theme of ['light','dark'])for(const width of [390,1920]){
  const context=await browser.newContext({storageState:await session.storageState(),javaScriptEnabled:!native,viewport:{width,height:844},reducedMotion:'reduce'});
  try{
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/theme/'+theme);await page.goto(base+'/transactions/new');
   const form=page.locator('#txn-form'),clock=form.locator('[name=txn_time]'),date=form.locator('[name=txn_date]');
   const blank=await form.locator('[name=txn_time_mode]').inputValue()==='auto'&&(native?await clock.inputValue()==='':/^\d{2}:\d{2}:\d{2}$/.test(await clock.inputValue()));let nowWorks=true,clearWorks=true,repaymentSynced=true,targetSynced=true,clearSynced=true;
   if(!native){
    await form.locator('[data-txn-now]').click();nowWorks=/^\d{2}:\d{2}:\d{2}$/.test(await clock.inputValue());
    await form.locator('[data-txn-time-clear]').click();clearWorks=await clock.inputValue()==='';
   }
   if(native)await date.fill('2026-11-12');else await date.evaluate(el=>{el.value='2026-11-12';el._hlRefresh?.();el.dispatchEvent(new Event('change',{bubbles:true}));});await clock.fill('18:35:42');if(native)await choose(form.locator('[name=txn_time_mode]'),'explicit');await form.locator('[name=amount]').fill('12.34');
   const clockAligned=await clock.evaluate(el=>{const date=el.form.querySelector('[name=txn_date]'),a=(date.closest('.hl-date')?.querySelector('.hl-date-trigger')||date).getBoundingClientRect(),b=el.getBoundingClientRect();return Math.abs(a.top-b.top)<2;});
   if(!native){
    await page.locator('[data-entry-type=repayment]').click();
    let active=page.locator('[data-repayment-target]:not(.hidden) .finance-form');
    repaymentSynced=await active.locator('[name=time]').inputValue()==='18:35:42';
    await choose(active.locator('[name=account_id]'),'');
    const targets=page.locator('#repayment-target'),values=await targets.evaluate(el=>[...el.options].map(o=>o.value));
    if(values.length<3)throw Error('时间验收需要三个不同还款对象');
    await choose(targets,values[1]);active=page.locator('[data-repayment-target]:not(.hidden) .finance-form');
    targetSynced=await active.locator('[name=account_id]').inputValue()===''&&await active.locator('[name=time]').inputValue()==='18:35:42'&&await active.locator('[name=date]').inputValue()==='2026-11-12';
    await active.locator('[data-txn-time-clear]').click();await choose(targets,values[2]);
    clearSynced=await page.locator('[data-repayment-target]:not(.hidden) [name=time]').inputValue()==='';
    await page.locator('[data-entry-type=expense]').click();
   }
   const merchant='时刻验收 '+runId+' '+theme+' '+width+' '+(native?'原生':'交互');await form.locator('[name=merchant]').fill(merchant);
   await page.screenshot({path:'.screenshots/audit-after/transaction-time-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',animations:'disabled'});
   await Promise.all([page.waitForURL(/\/transactions(?:\?|$)/),page.locator('#submit-btn').click()]);
   await page.goto(base+'/transactions?q='+encodeURIComponent(merchant));
   const row=page.locator('.txn').filter({hasText:merchant}).first();const id=await row.getAttribute('data-txn-id');
   let saved=(await (await page.request.get(base+'/transactions/'+id+'/json')).json()).txn;
   const persisted=saved.txn_date==='2026-11-12'&&saved.txn_time==='18:35:42'&&!!saved.created_at;
   const listTime=await row.locator('.txn-sub').innerText();let detail=true;
   if(!native){await row.locator('.txn-main').click();const inspector=page.locator('.txn-detail:visible').first();await inspector.waitFor();const text=await inspector.innerText();detail=text.includes('交易时间')&&text.includes('18:35:42')&&text.includes('录入时间')&&text.includes(saved.account_type_label);}
   await page.goto(base+'/transactions/'+id+'/edit');const edit=page.locator('#txn-form');const retained=await edit.locator('[name=txn_time]').inputValue()==='18:35:42';
   if(native)await edit.locator('[name=txn_time]').fill('');else await edit.locator('[data-txn-time-clear]').click();
   await Promise.all([page.waitForURL(/\/transactions(?:\?|$)/),page.locator('#submit-btn').click()]);
   saved=(await (await page.request.get(base+'/transactions/'+id+'/json')).json()).txn;const cleared=saved.txn_time===null&&saved.txn_date==='2026-11-12';
   // Long two-sided accounts must remain visibly readable, including the compact home variant.
   await page.goto(base+'/transactions/new');const csrf=await page.locator('[name=_csrf]').first().inputValue();
   for(const [name,type]of [['用于验证类型可见的很长很长银行卡账户一','debit'],['用于验证类型可见的很长很长银行卡账户二','debit']])await page.request.post(base+'/accounts',{form:{_csrf:csrf,name,type,currency:'CNY',include_in_net:'1'}});
   await page.goto(base+'/transactions/new');const accounts=await page.locator('#f-account').evaluate(el=>[...el.options].filter(o=>o.textContent.includes('用于验证类型可见')).map(o=>o.value));
   const response=await page.request.post(base+'/transactions',{form:{_csrf:csrf,type:'transfer',amount:'1.23',currency:'CNY',account_id:accounts.at(-2),to_account_id:accounts.at(-1),txn_date:'2026-11-12',txn_time:'22:45',merchant:merchant+'转账',_json:'1'}});const transfer=(await response.json()).id;
   await page.goto(base+'/transactions?q='+encodeURIComponent(merchant+'转账'));const transferRow=page.locator('[data-txn-id="'+transfer+'"]');await transferRow.evaluate(el=>el.scrollIntoView({block:'center'}));
   const typesVisible=await transferRow.locator('.txn-sub').evaluate(el=>{const rect=el.getBoundingClientRect();const parts=[...el.querySelectorAll('span')].filter(s=>s.textContent.includes('储蓄卡'));return parts.length===2&&el.scrollWidth<=el.clientWidth+1&&parts.every(s=>{const r=s.getBoundingClientRect();return r.right<=rect.right+1&&r.bottom<=rect.bottom+1&&r.top>=75&&r.bottom<=innerHeight-(innerWidth<=820?88:15);});});
   await page.screenshot({path:'.screenshots/audit-after/transaction-accounts-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',animations:'disabled'});
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   checks.push({native,theme,width,blank,nowWorks,clearWorks,clockAligned,repaymentSynced,targetSynced,clearSynced,persisted,listTime:listTime.includes('18:35:42'),detail,retained,cleared,typesVisible,errors,overflow,pass:blank&&nowWorks&&clearWorks&&clockAligned&&repaymentSynced&&targetSynced&&clearSynced&&persisted&&listTime.includes('18:35:42')&&detail&&retained&&cleared&&typesVisible&&!errors.length&&!overflow});
  }finally{await context.close();}
 }
 return checks;
};
