// Real form journeys in disposable ledgers; call with an authenticated isolated
// browser session. Each ledger is deleted and the original selection restored.
module.exports=async function(browser,session,base){
 const checks=[],runId=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6);
 async function choose(select,value){
  const index=await select.evaluate((el,v)=>[...el.options].findIndex(o=>o.value===v),value);
  const wrapper=select.locator('..'),trigger=wrapper.locator('.hl-select-trigger');
  if(await trigger.count()){await trigger.click();await wrapper.locator('.hl-select-opt').nth(index).click();}else await select.selectOption(value);
 }
 for(const native of [false,true])for(const theme of ['light','dark'])for(const width of [390,1920]){
  const context=await browser.newContext({storageState:await session.storageState(),javaScriptEnabled:!native,viewport:{width,height:844},reducedMotion:'reduce'});
  let ledgerId,originalLedger,csrf;
  const name='代垫浏览器 '+runId+' '+(native?'N':'J')+theme[0]+width;
  try{
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/theme/'+theme);await page.goto(base+'/ledgers');
   originalLedger=await page.locator('.ledger-switch [name=ledger_id]').inputValue();
   csrf=await page.locator('[name=_csrf]').first().inputValue();
   await page.request.post(base+'/ledgers',{form:{_csrf:csrf,name,currency:'CNY',kind:'personal'}});
   await page.goto(base+'/transactions/new');ledgerId=await page.locator('.ledger-switch [name=ledger_id]').inputValue();
   const form=page.locator('#txn-form');
   await form.locator('[name=amount]').fill('100');
   const account=await form.locator('[name=account_id]').evaluate(el=>[...el.options].find(o=>o.textContent.includes('现金')).value);
   await choose(form.locator('[name=account_id]'),account);
   if(native){
    await form.locator('[name=txn_date]').fill('2026-01-15');
    await form.locator('[name=txn_time]').fill('12:34:56');
    await form.locator('[name=txn_time_mode]').selectOption('explicit');
    const category=await form.locator('#f-category').evaluate(el=>[...el.options].find(o=>o.value).value);await form.locator('#f-category').selectOption(category);
   }else{
    await form.locator('[name=txn_date]').evaluate(el=>{el.value='2026-01-15';el.dispatchEvent(new Event('change',{bubbles:true}));});
    await form.locator('[name=txn_time]').fill('12:34:56');
    await form.locator('.cat-section:not(.hidden) .cat-group:visible .cat-item').first().click();
   }
   const merchant='混合代买 '+runId+' '+theme+' '+width+' '+native;
   await form.locator('[name=merchant]').fill(merchant);
   await form.getByText('部分代垫（帮别人付款）',{exact:true}).click();
   await form.locator('[name=advance_person]').fill('同事小王');await form.locator('[name=advance_amount]').fill('60');
   await Promise.all([page.waitForURL(/\/transactions(?:\?|$)/),page.locator('#submit-btn').click()]);
   await page.goto(base+'/transactions?q='+encodeURIComponent(merchant));
   const rows=page.locator('.transactions-primary .txn'),primary=rows.first();
   const oneBill=await rows.count()===1&&await primary.locator('.txn-amt').innerText()==='-100.00';
   const primaryId=await primary.getAttribute('data-txn-id');
   const saved=(await (await page.request.get(base+'/transactions/'+primaryId+'/json')).json()).txn;
   const correctParts=saved.amount_cents===4000&&saved.advance?.total_cents===10000&&saved.advance.advance_cents===6000;
   await page.goto(base+'/calendar?month=2026-01&date=2026-01-15');
   const calendarParts=await page.getByRole('link',{name:'管理代垫',exact:true}).count()===1&&await page.getByText('实际付款 100.00',{exact:true}).count()===1&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
   if(width===390)await page.screenshot({path:'.screenshots/audit-after/advance-calendar-'+theme+'-'+(native?'native':'js')+'.png',fullPage:true,animations:'disabled'});
   await context.addCookies([{name:'hl_simple',value:'1',url:base}]);await page.goto(base+'/');
   const minimalRow=page.locator('.m-txn[href="/advances/'+saved.advance.id+'"]');
   const minimalParts=await minimalRow.count()===1&&(await minimalRow.innerText()).includes('自用 40.00 · 代垫 60.00')&&(await minimalRow.locator('.amt').innerText()).includes('100.00')&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
   if(width===390)await page.screenshot({path:'.screenshots/audit-after/advance-minimal-'+theme+'-'+(native?'native':'js')+'.png',fullPage:true,animations:'disabled'});
   await context.addCookies([{name:'hl_simple',value:'0',url:base}]);
   await page.goto(base+'/accounts');
   const managed=page.locator('.account-entry').filter({hasText:'代垫待收款'});
   const managedAccount=await managed.count()===1&&await managed.getByRole('link',{name:'代垫与回收',exact:true}).getAttribute('href')==='/advances'&&await managed.locator('.acc-adjust,form[action$="/archive"],form[action$="/delete"]').count()===0&&await managed.locator('[name=include_in_net][disabled]').count()===1&&await managed.locator('input[type=hidden][name=include_in_net][value="1"]').count()===1;
   await page.goto(base+'/transactions?q='+encodeURIComponent(merchant));
   const advancePath='/advances/'+saved.advance.id;
   await primary.locator('a[href="'+advancePath+'"]').first().click();await page.waitForURL(base+advancePath);
   const returnButton=await page.locator('.detail-navigation a').count()===1;
   const summaryColumns=await page.locator('.advance-summary').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);
   const summaryLayout=summaryColumns===(width<540?2:3);
   await page.screenshot({path:'.screenshots/audit-after/advance-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',fullPage:true,animations:'disabled'});
   const payment=page.locator('form[action="'+advancePath+'/collect"]');
   await payment.locator('[name=amount]').fill('60');await choose(payment.locator('[name=account_id]'),account);
   if(native)await payment.locator('[name=date]').fill('2026-02-02');else await payment.locator('[name=date]').evaluate(el=>{el.value='2026-02-02';el.dispatchEvent(new Event('change',{bubbles:true}));});
   await payment.locator('[name=time]').fill('09:10:11');
   async function submit(action,confirmation=false){
    const current=page.locator('form[action="'+action+'"]');
    const done=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===action);
    await current.locator('button').last().click();
    if(confirmation&&!native)await page.locator('.modal-mask [data-act=ok]').click();
    await done;await page.goto(base+advancePath);
   }
   await submit(advancePath+'/collect');
   const collected=await page.locator('.card-head .chip').first().innerText()==='已收齐'&&await page.locator('form[action="'+advancePath+'/collect"]').count()===0;
   const reverseCollectionAction=await page.locator('form[action*="/collections/"][action$="/reverse"]').getAttribute('action');
   await submit(reverseCollectionAction,true);
   const collectionReversed=await page.locator('.card-head .chip').first().innerText()==='待回收';
   await submit(reverseCollectionAction.replace(/reverse$/,'restore'),true);
   const collectionRestored=await page.locator('.card-head .chip').first().innerText()==='已收齐';
   await submit(reverseCollectionAction,true);await submit(advancePath+'/reverse',true);
   const reversed=await page.locator('.card-head .chip').first().innerText()==='已撤销';
   await submit(advancePath+'/restore',true);
   const restored=await page.locator('.card-head .chip').first().innerText()==='待回收';
   let sourceConversion=true,sourceRetry=true;
   if(native){
    const sourceResponse=await page.request.post(base+'/transactions',{form:{_csrf:csrf,type:'expense',amount:'50',account_id:account,currency:'CNY',txn_date:'2026-01-16',txn_time:'13:14:15',txn_time_mode:'explicit',merchant:merchant+'原支出',_json:'1'}});
    const source=(await sourceResponse.json()).id;await page.goto(base+'/transactions/'+source+'/edit');
    await page.getByText('从这笔支出分离代垫',{exact:true}).click();
    const convert=page.locator('form[action="/transactions/'+source+'/advance"]');
    await convert.locator('[name=advance_person]').fill('另一位同事');await convert.locator('[name=advance_amount]').fill('30');await convert.locator('[name=confirm_source]').check();
    const retryBody=await convert.evaluate(el=>Object.fromEntries(new FormData(el)));
    await Promise.all([page.waitForURL(/\/advances\/\d+$/),convert.locator('button').click()]);
    const convertedPath=new URL(page.url()).pathname;
    const retry=await page.request.post(base+'/transactions/'+source+'/advance',{form:retryBody,maxRedirects:0});
    sourceRetry=retry.status()===302&&retry.headers().location===convertedPath;
    sourceConversion=await page.getByText('50.00 CNY',{exact:true}).count()===1&&await page.getByText('拆分前原记录',{exact:false}).count()===1&&await page.getByText('2026-01-16 13:14:15',{exact:false}).count()===1;
    await page.screenshot({path:'.screenshots/audit-after/advance-conversion-'+theme+'-'+width+'.png',fullPage:true,animations:'disabled'});
   }
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   const internalScroll=await page.locator('.finance-detail').evaluate(el=>[...el.querySelectorAll('*')].filter(n=>n.getClientRects().length&&!n.matches('select,input,textarea')&&!n.closest('.hl-select-menu,.hl-date-menu')&&['auto','scroll'].includes(getComputedStyle(n).overflowY)&&n.scrollHeight>n.clientHeight+2).length>0);
   checks.push({native,theme,width,oneBill,correctParts,calendarParts,minimalParts,managedAccount,returnButton,summaryLayout,collected,collectionReversed,collectionRestored,reversed,restored,sourceConversion,sourceRetry,overflow,internalScroll,errors,pass:oneBill&&correctParts&&calendarParts&&minimalParts&&managedAccount&&returnButton&&summaryLayout&&collected&&collectionReversed&&collectionRestored&&reversed&&restored&&sourceConversion&&sourceRetry&&!overflow&&!internalScroll&&!errors.length});
  }finally{
   if(ledgerId&&csrf)await context.request.post(base+'/ledgers/'+ledgerId+'/delete',{form:{_csrf:csrf,confirm:name}});
   if(originalLedger&&csrf)await context.request.post(base+'/ledgers/switch',{form:{_csrf:csrf,ledger_id:originalLedger}});
   await context.close();
  }
 }
 return checks;
};
