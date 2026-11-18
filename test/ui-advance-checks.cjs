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
   await form.locator('[name=advance_person]').fill('同事小王');await form.locator('[name=advance_amount]').fill('18.99');
   await Promise.all([page.waitForURL(/\/transactions(?:\?|$)/),page.locator('#submit-btn').click()]);
   await page.goto(base+'/transactions?q='+encodeURIComponent(merchant));
   const rows=page.locator('.transactions-primary .txn'),primary=rows.first();
   const oneBill=await rows.count()===1&&await primary.locator('.txn-amt').innerText()==='-100.00';
   const pendingStatus=await primary.getByText('待收 18.99',{exact:true}).count()===1;
   const workspace=()=>page.locator('.transactions-workspace').evaluate(el=>{const r=el.getBoundingClientRect(),p=el.querySelector('.transactions-primary').getBoundingClientRect();return {left:r.left,width:r.width,primaryLeft:p.left,primaryWidth:p.width};});
   const beforeFilter=await workspace();
   const filter=page.locator('.chip-row').getByRole('link',{name:'代垫与回收',exact:true});
   await filter.click();
   await page.waitForURL(url=>url.pathname==='/transactions'&&url.searchParams.get('advance_related')==='1');
   const afterFilter=await workspace();
   const filterStable=Object.keys(beforeFilter).every(key=>Math.abs(beforeFilter[key]-afterFilter[key])<=1)&&new URL(page.url()).searchParams.get('q')===merchant&&await primary.count()===1&&await filter.getAttribute('aria-current')==='true';
   await page.screenshot({path:'.screenshots/audit-after/advance-filter-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',fullPage:true,animations:'disabled'});
   await filter.click();
   await page.waitForURL(url=>url.pathname==='/transactions'&&!url.searchParams.has('advance_related'));
   const afterClear=await workspace();
   const filterCleared=Object.keys(beforeFilter).every(key=>Math.abs(beforeFilter[key]-afterClear[key])<=1);
   const primaryId=await primary.getAttribute('data-txn-id');
   const saved=(await (await page.request.get(base+'/transactions/'+primaryId+'/json')).json()).txn;
   const correctParts=saved.amount_cents===8101&&saved.advance?.total_cents===10000&&saved.advance.advance_cents===1899;
   const advancePath='/advances/'+saved.advance.id;
   const billUrl=base+'/transactions?q='+encodeURIComponent(merchant);
   const editPath='/transactions/'+primaryId+'/edit';
   const splitText=primary.getByText('自用 81.01 · 代垫 18.99',{exact:true});
   const plainSummary=await splitText.evaluate(el=>el.tagName==='SPAN'&&!el.closest('a,button'))&&await primary.locator('a[href="'+advancePath+'"]').count()===0;
   const summaryChip=await splitText.evaluate(el=>{
    const meta=el.closest('.txn-sub');
    const status=meta.querySelector('.chip.warn');
    const style=getComputedStyle(el),statusStyle=getComputedStyle(status);
    const original=el.textContent;
    el.textContent='自用\u00a099,999,999.99 · 代垫\u00a099,999,999.99';
    const fits=el.getBoundingClientRect().right<=meta.getBoundingClientRect().right+1&&el.scrollWidth<=el.clientWidth+1;
    el.textContent=original;
    return style.display===statusStyle.display&&style.borderRadius===statusStyle.borderRadius&&
      style.backgroundColor!==statusStyle.backgroundColor&&Number(style.fontWeight)>=600&&fits;
   });
   let viewDetails=true;
   if(!native){
    await splitText.click();
    const panel=page.getByRole(width===390?'dialog':'region',{name:'账单详情',exact:true});
    await panel.waitFor();
    viewDetails=new URL(page.url()).pathname==='/transactions'&&await panel.getByText('待收 18.99',{exact:true}).isVisible()&&await panel.locator('a[href^="/advances/"]').count()===0;
    await panel.getByRole('link',{name:'编辑',exact:true}).click();
    await page.waitForURL(url=>url.pathname===editPath);
    viewDetails=viewDetails&&await page.locator('#txn-form[data-advance-edit] .advance-recovery').isVisible();
   }
   let readonlyPath=true;
   if(theme==='light'&&width===390){
    await page.request.post(base+'/members/invite',{form:{_csrf:csrf,role:'viewer',days:'1'}});
    await page.goto(base+'/members');
    const invite=(await page.getByText(/^\/join\//).innerText()).trim();
    const reader=await browser.newContext({javaScriptEnabled:!native,viewport:{width,height:844},reducedMotion:'reduce'});
    try{
     await reader.addCookies([{name:'hl_simple',value:'0',url:base}]);
     const view=await reader.newPage();
     await view.goto(base+'/login');
     await view.locator('[name=username]').fill('qa_empty');
     await view.locator('[name=password]').fill('testpass123');
     await Promise.all([view.waitForURL(base+'/'),view.locator('button[type=submit]').click()]);
     await view.goto(base+invite);
     await Promise.all([view.waitForURL(base+'/'),view.locator('form[action^="/join/"] button[type=submit]').click()]);
     await view.goto(billUrl);
     const row=view.locator('.transactions-primary [data-advance-main]');
     readonlyPath=await row.locator('[data-del-txn],a[href*="/edit"]').count()===0;
     if(!native)await row.press('Enter');
     await view.getByRole('link',{name:'查看代垫详情',exact:true}).click();
     await view.waitForURL(base+advancePath);
     readonlyPath=readonlyPath&&await view.getByRole('heading',{name:'付款分项',exact:true}).isVisible()&&await view.locator('#advance-recovery-form').count()===0&&(await view.request.get(base+editPath)).status()===403;
    }finally{await reader.close();}
   }
   await page.goto(base+'/calendar?month=2026-01&date=2026-01-15');
   const calendarParts=await page.getByRole('link',{name:'管理代垫',exact:true}).count()===1&&await page.getByText('实际付款 100.00',{exact:true}).count()===1&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
   if(width===390)await page.screenshot({path:'.screenshots/audit-after/advance-calendar-'+theme+'-'+(native?'native':'js')+'.png',fullPage:true,animations:'disabled'});
   await context.addCookies([{name:'hl_simple',value:'1',url:base}]);await page.goto(base+'/');
   const minimalRow=page.locator('.m-txn[href="/advances/'+saved.advance.id+'"]');
   const minimalParts=await minimalRow.count()===1&&(await minimalRow.innerText()).includes('自用 81.01 · 代垫 18.99')&&(await minimalRow.locator('.amt').innerText()).includes('100.00')&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
   if(width===390)await page.screenshot({path:'.screenshots/audit-after/advance-minimal-'+theme+'-'+(native?'native':'js')+'.png',fullPage:true,animations:'disabled'});
   await context.addCookies([{name:'hl_simple',value:'0',url:base}]);
   await page.goto(base+'/accounts');
   const managed=page.locator('.account-entry').filter({hasText:'代垫待收款'});
   const managedAccount=await managed.count()===1&&await managed.getByRole('link',{name:'代垫与回收',exact:true}).getAttribute('href')==='/advances'&&await managed.locator('.acc-adjust,form[action$="/archive"],form[action$="/delete"]').count()===0&&await managed.locator('[name=include_in_net][disabled]').count()===1&&await managed.locator('input[type=hidden][name=include_in_net][value="1"]').count()===1;
   await page.goto(base+'/advances');
   await page.locator('a[href="'+advancePath+'"]').click();await page.waitForURL(base+advancePath);
   const returnButton=await page.locator('.detail-navigation a').count()===1;
   const summaryColumns=await page.locator('.advance-summary').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);
   const summaryLayout=summaryColumns===(width<540?2:3);
   await page.screenshot({path:'.screenshots/audit-after/advance-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',fullPage:true,animations:'disabled'});
   const payment=page.locator('[data-advance-collection]');
   const amend=page.locator('#txn-form[data-advance-edit]');
   const saveDetails=page.getByRole('button',{name:'保存修改',exact:true});
   async function openEditor(){
    await page.locator('.entry-actions').getByRole('link',{name:'编辑',exact:true}).click();
    await page.waitForURL(url=>url.pathname===editPath);
   }
   await openEditor();
   const checkEditorLayout=wide=>amend.evaluate((form,wide)=>{
    const payment=form.querySelector('.grid-main > div:first-child > .card').getBoundingClientRect();
    const category=form.querySelector('#f-cat-wrap').getBoundingClientRect();
    const recovery=form.querySelector('.advance-recovery').getBoundingClientRect();
    const save=document.querySelector('.entry-actionbar button');
    const point=save.getBoundingClientRect();
    const aligned=wide?Math.abs(payment.top-category.top)<=1&&category.left>=payment.right:category.top>=payment.bottom&&Math.abs(category.left-payment.left)<=1;
    return aligned&&Math.abs(recovery.left-category.left)<=1&&recovery.top>=category.bottom&&
      save.form===form&&!save.disabled&&point.top>=0&&point.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth+1;
   },wide);
   let editorLayout=await checkEditorLayout(width>1250);
   if(width===1920&&!native){
    for(const viewportWidth of [1280,1250,820]){
     await page.setViewportSize({width:viewportWidth,height:844});
     editorLayout=(await checkEditorLayout(viewportWidth>1250))&&editorLayout;
    }
    await page.setViewportSize({width,height:844});
   }
   const amendStyles=await amend.evaluate(form=>{
    const text=form.querySelector('[name=personal]');
    const amount=form.querySelector('#f-amount');
    const receipt=form.querySelector('[data-advance-collection] [name=amount]');
    return parseFloat(getComputedStyle(amount).fontSize)>parseFloat(getComputedStyle(text).fontSize)&&Math.abs(text.getBoundingClientRect().width-text.parentElement.clientWidth)<=1&&
      receipt.form.id==='advance-recovery-form'&&new FormData(form).getAll('amount').length===1&&!new FormData(receipt.form).has('category_id');
   });
   await page.screenshot({path:'.screenshots/audit-after/advance-amend-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',fullPage:true,animations:'disabled'});
   await page.getByRole('link',{name:'取消',exact:true}).click();
   await page.waitForURL(base+advancePath);
   const editorReturns=await payment.isVisible()&&await amend.count()===0;
   await openEditor();
   await payment.locator('[name=amount]').fill('20');await choose(payment.locator('[name=account_id]'),account);
   if(native)await payment.locator('[name=date]').fill('2026-02-02');else await payment.locator('[name=date]').evaluate(el=>{el.value='2026-02-02';el.dispatchEvent(new Event('change',{bubbles:true}));});
   await payment.locator('[name=time]').fill('09:10:11');
   let draftProtected=true;
   if(!native){
    await amend.locator('[name=note]').fill('尚未保存的账单备注');
    await payment.getByRole('button',{name:'确认收回'}).click();
    const dialog=page.getByRole('alertdialog');
    draftProtected=(await dialog.innerText()).includes('未保存的修改');
    await dialog.getByRole('button',{name:'取消'}).click();
    draftProtected=draftProtected&&await amend.locator('[name=note]').inputValue()==='尚未保存的账单备注';
    await amend.locator('[name=note]').fill('');
   }
   async function submit(action,confirmation=false){
    const navigation=page.waitForNavigation();
    if(action.endsWith('/details'))await saveDetails.click();
    else if(action.endsWith('/collect'))await payment.getByRole('button',{name:'确认收回'}).click();
    else if(action.includes('/collections/'))await page.locator('button[formaction="'+action+'"]').click();
    else await page.locator('form[action="'+action+'"] button').click();
    if(confirmation&&!native)await page.locator('.modal-mask [data-act=ok]').click();
    await navigation;
   }
   const key=await payment.locator('[name=operation_key]').inputValue();
   const preview=native||((await payment.locator('[data-excess-preview]').innerText()).includes('实际到账 20.00 · 回本 18.99 · 凑整收入 1.01'));
   await submit(advancePath+'/collect');
   const retry=payment;
   const retryState={amount:await retry.locator('[name=amount]').inputValue(),key:await retry.locator('[name=operation_key]').inputValue(),account:await retry.locator('[name=account_id]').inputValue(),expectedAccount:account,expectedKey:key};
   const rejected=new URL(page.url()).pathname===editPath&&await page.locator('.flash.error').count()===1&&await retry.count()===1&&Number(await retry.locator('[name=amount]').inputValue())===20&&await retry.locator('[name=operation_key]').inputValue()===key&&await retry.locator('[name=account_id]').inputValue()===account;
   await retry.locator('[name=excess_handling]').check();
   await page.screenshot({path:'.screenshots/audit-after/advance-rounding-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',fullPage:true,animations:'disabled'});
   await submit(advancePath+'/collect');
   const split=(await amend.locator('.advance-recovery').innerText()).includes('回本 18.99 · 凑整收入 1.01');
   const collected=new URL(page.url()).pathname===editPath&&await amend.locator('.advance-recovery .chip').innerText()==='已收齐'&&await payment.count()===0;
   async function billStatus(text){
    await page.goto(base+'/transactions?q='+encodeURIComponent(merchant));
    const visible=await page.locator('.transactions-primary .txn').getByText(text,{exact:true}).count()===1;
    if(text==='代垫已收齐')await page.screenshot({path:'.screenshots/audit-after/advance-bill-settled-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',fullPage:true,animations:'disabled'});
    await page.goto(base+advancePath);
    return visible;
   }
   const settledStatus=await billStatus('代垫已收齐');
   await page.goto(billUrl);
   const editButton=primary.locator('a[aria-label="编辑"]');
   const deleteButton=primary.locator('button[aria-label="删除"]');
   const inspector=page.locator('.txn-detail:visible');
   const narrow=width===390;
   const standardActions=await editButton.locator('svg use').getAttribute('href')==='#i-pencil'&&await deleteButton.locator('svg use').getAttribute('href')==='#i-trash-2';
   let protectedDelete=true;
   if(!native){
    if(narrow)await primary.press('Enter');
    await (narrow?inspector.getByRole('button',{name:'删除',exact:true}):deleteButton).click();
    await page.getByRole('alertdialog').getByRole('button',{name:'删除',exact:true}).click();
    await page.getByText('请先撤销该笔代垫的所有回款，再撤销付款',{exact:true}).waitFor();
    protectedDelete=await primary.count()===1;
   }
   const activeEdit=narrow?(native?primary.getByRole('link',{name:'编辑',exact:true}):inspector.getByRole('link',{name:'编辑',exact:true})):editButton;
   await activeEdit.click();
   await page.waitForURL(url=>url.pathname===editPath);
   const detailsForm=amend;
   const categoryField=detailsForm.locator('[name=category_id]');
   const changedCategory=await categoryField.evaluate(el=>[...el.options].find(o=>o.value&&o.value!==el.value).value);
   if(native)await categoryField.selectOption('');
   else await detailsForm.getByRole('button',{name:'清除分类',exact:true}).click();
   const clearedCategory=await categoryField.inputValue()==='';
   if(native)await categoryField.selectOption(changedCategory);
   else{
    const path=await categoryField.locator('option[value="'+changedCategory+'"]').getAttribute('data-path');
    await detailsForm.getByLabel('搜索分类').fill(path);
    await detailsForm.locator('#category-search-results [data-id="'+changedCategory+'"]').click();
   }
   await detailsForm.locator('[name=owner_label]').fill('小刘');
   await detailsForm.locator('[name=tags]').fill('代买测试');
   await detailsForm.locator('[name=note]').fill('核对后的账单备注');
   await detailsForm.locator('[name=no_rhythm]').check();
   await detailsForm.getByLabel('代垫对象').fill('  ');
   await submit(advancePath+'/details');
   const editRetry=new URL(page.url()).pathname===editPath&&await detailsForm.locator('[name=note]').inputValue()==='核对后的账单备注'&&await categoryField.inputValue()===changedCategory&&await page.locator('.flash.error').getByText('请填写代垫对象',{exact:true}).count()===1;
   await detailsForm.getByLabel('代垫对象').fill('已收齐后修正的同事');
   await page.screenshot({path:'.screenshots/audit-after/advance-edit-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',fullPage:true,animations:'disabled'});
   await submit(advancePath+'/details');
   const updatedBill=(await (await page.request.get(base+'/transactions/'+primaryId+'/json')).json()).txn;
   const returnedToFilteredList=new URL(page.url()).pathname==='/transactions'&&new URL(page.url()).searchParams.get('q')===merchant;
   const editedDetails=updatedBill.advance.person==='已收齐后修正的同事'&&
     Number(updatedBill.category_id)===Number(changedCategory)&&updatedBill.owner_label==='小刘'&&updatedBill.tag_names==='代买测试'&&updatedBill.no_rhythm===1&&await billStatus('代垫已收齐');
   if(width===1920){
    await page.locator('.nav-item[href="/advances"]').click();
    await page.waitForURL(base+'/advances');
   }
   const sidebarNav=await page.locator('.nav-item[href="/advances"]'+(width===1920?'[aria-current="page"]':'')).count()===1;
   await context.addCookies([{name:'hl_simple',value:'1',url:base}]);
   await page.goto(base+advancePath+'?edit=1');
   const miniEditor=await page.locator('.m-tabbar').isHidden()&&await saveDetails.evaluate(button=>button.form?.id==='txn-form'&&button.getBoundingClientRect().bottom<=innerHeight);
   await page.goto(base+'/more');
   await page.locator('.m-more-group').getByRole('link',{name:'代垫与回收',exact:true}).click();
   await page.waitForURL(base+'/advances');
   const advanceNav=sidebarNav&&await page.getByRole('heading',{name:'代垫记录',exact:true}).count()===1&&await page.locator('.m-tab.active[href="/more"]').count()===1;
   await context.addCookies([{name:'hl_simple',value:'0',url:base}]);
   await page.goto(base+'/transactions?from=2026-02-02&to=2026-02-02');
   const receiptRows=page.locator('.transactions-primary .txn');
   const receiptList=await receiptRows.count()===1&&(await receiptRows.first().locator('.txn-amt').innerText()).trim()==='20.00'&&(await receiptRows.first().innerText()).includes('回本 18.99 · 凑整收入 1.01');
   let receiptDetail=true;
   if(!native){await receiptRows.first().click();const detail=page.locator('.txn-detail:visible');await detail.waitFor();const detailText=await detail.innerText();receiptDetail=detailText.includes('20.00')&&detailText.includes('18.99 / 1.01')&&detailText.includes('管理代垫');}
   await page.goto(base+'/calendar?month=2026-02&date=2026-02-02');
   const calendarReceipt=(await page.locator('body').innerText()).includes('回本 18.99 · 凑整收入 1.01')&&(await page.locator('.txn-amt').first().innerText()).includes('20.00')&&(await page.locator('body').innerText()).includes('收入 1.01');
   await context.addCookies([{name:'hl_simple',value:'1',url:base}]);await page.goto(base+'/');
   const receiptMini=page.locator('.m-txn[href="'+advancePath+'"]');
   const minimalReceipt=await receiptMini.count()===2&&(await receiptMini.first().innerText()).includes('回本 18.99 · 凑整收入 1.01')&&(await receiptMini.first().locator('.amt').innerText()).includes('20.00');
   await context.addCookies([{name:'hl_simple',value:'0',url:base}]);await page.goto(base+'/accounts/'+account+'?from=2026-02-02&to=2026-02-02');
   const accountAmounts=await page.locator('.txn .txn-amt').allInnerTexts();
   const accountParts=accountAmounts.length===2&&accountAmounts.some(v=>v.includes('18.99'))&&accountAmounts.some(v=>v.includes('1.01'));
   await page.goto(base+advancePath);
   await openEditor();
   const reverseCollectionAction=await page.locator('button[formaction*="/collections/"][formaction$="/reverse"]').getAttribute('formaction');
   await submit(reverseCollectionAction,true);
   const collectionReversed=new URL(page.url()).pathname===editPath&&await amend.locator('.advance-recovery .chip').innerText()==='待收 18.99';
   const reversedStatus=await billStatus('待收 18.99');
   await openEditor();
   await submit(reverseCollectionAction.replace(/reverse$/,'restore'),true);
   const collectionRestored=new URL(page.url()).pathname===editPath&&await amend.locator('.advance-recovery .chip').innerText()==='已收齐';
   const restoredStatus=await billStatus('代垫已收齐');
   await submit(reverseCollectionAction,true);
   const part=payment;
   await part.locator('[name=amount]').fill('18.99');await choose(part.locator('[name=account_id]'),account);await submit(advancePath+'/collect');
   const equal=(await page.locator('.card-head .chip').first().innerText())==='已收齐';
   const equalAction=await page.locator('button[formaction*="/collections/"][formaction$="/reverse"]').getAttribute('formaction');await submit(equalAction,true);
   await part.locator('[name=amount]').fill('10');await choose(part.locator('[name=account_id]'),account);await submit(advancePath+'/collect');
   const partialStatus=await billStatus('部分收回 · 待收 8.99');
   await part.locator('[name=amount]').fill('10');await choose(part.locator('[name=account_id]'),account);await part.locator('[name=excess_handling]').check();await submit(advancePath+'/collect');
   const multi=(await page.locator('.finance-detail').innerText()).includes('回本 8.99 · 凑整收入 1.01');
   const activeForms=await page.locator('button[formaction*="/collections/"][formaction$="/reverse"]').evaluateAll(els=>els.map(el=>el.getAttribute('formaction')));
   for(const action of activeForms)await submit(action,true);
   const componentId=Number((await page.locator('.finance-detail').getByText(/#\d+ · 代垫应收/).innerText()).match(/#(\d+)/)[1]);
   const secondaryDelete=await page.request.post(base+'/transactions/'+componentId+'/delete',{form:{_csrf:csrf,_json:'1'}});
   const protectedComponent=secondaryDelete.status()===400&&(await secondaryDelete.json()).ok===false;
   let deletedWhole=true;
   if(native)await submit(advancePath+'/reverse',true);
   else{
    await page.goto(billUrl);
    if(narrow)await primary.press('Enter');
    await (narrow?inspector.getByRole('button',{name:'删除',exact:true}):deleteButton).click();
    await Promise.all([page.waitForNavigation(),page.getByRole('alertdialog').getByRole('button',{name:'删除',exact:true}).click()]);
    deletedWhole=await primary.count()===0;
    await page.goto(base+advancePath);
   }
   const reversed=await page.locator('.card-head .chip').first().innerText()==='已撤销';
   await submit(advancePath+'/restore',true);
   const restored=await page.locator('.card-head .chip').first().innerText()==='待回收';
   await openEditor();
   await amend.locator('[name=person]').fill('更正后的同事');
   await amend.locator('#f-amount').fill('100');
   await amend.locator('[name=personal]').fill('80');
   await amend.locator('[name=no_rhythm]').uncheck();
   if(native)await amend.locator('[name=txn_date]').fill('2026-01-17');
   else await amend.locator('[name=txn_date]').evaluate(el=>{el.value='2026-01-17';el.dispatchEvent(new Event('change',{bubbles:true}));});
   await Promise.all([page.waitForURL(url=>/^\/advances\/\d+$/.test(url.pathname)&&url.pathname!==advancePath),saveDetails.click()]);
   const amendedPath=new URL(page.url()).pathname;
   const amendedId=Number((await page.locator('.finance-detail').getByText(/自用消费/).first().innerText()).match(/#(\d+)/)[1]);
   const amendedTxn=(await (await page.request.get(base+'/transactions/'+amendedId+'/json')).json()).txn;
   const amended=amendedPath!==advancePath&&(await page.locator('h2').first().innerText()).includes('更正后的同事')&&(await page.locator('.advance-summary').innerText()).includes('80.00')&&(await page.locator('.advance-summary').innerText()).includes('20.00')&&await page.getByText(/交易日期 2026-01-17/).count()===1&&amendedTxn.no_rhythm===0;
   let ordinaryCategory=true;
   if(!native&&width===1920){
    const response=await page.request.post(base+'/transactions',{form:{_csrf:csrf,_json:'1',type:'expense',amount:'5',account_id:account,currency:'CNY',category_id:changedCategory,txn_date:'2026-01-17'}});
    const ordinary=(await response.json()).id;
    await page.goto(base+'/transactions/'+ordinary+'/edit');
    const clear=page.getByRole('button',{name:'清除分类',exact:true});
    const picker=page.locator('#f-category');
    await clear.click();
    const cleared=await picker.inputValue()===''&&await page.locator('#category-query').evaluate(el=>el===document.activeElement);
    await page.locator('.cat-section:not(.hidden) .cat-group:visible .cat-item').first().click();
    await page.locator('#txn-form [data-type="transfer"]').click();
    await page.locator('#txn-form [data-type="expense"]').click();
    ordinaryCategory=cleared&&await clear.isHidden()&&await picker.inputValue()===''&&await page.locator('#cat-hint').innerText()==='未选择';
    await page.goto(base+amendedPath);
   }
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
   const outcomes={oneBill,plainSummary,summaryChip,viewDetails,readonlyPath,pendingStatus,settledStatus,editRetry,editedDetails,clearedCategory,ordinaryCategory,returnedToFilteredList,advanceNav,reversedStatus,restoredStatus,partialStatus,filterStable,filterCleared,correctParts,calendarParts,minimalParts,managedAccount,returnButton,summaryLayout,editorLayout,editorReturns,miniEditor,amendStyles,amended,preview,rejected,split,multi,equal,collected,receiptList,receiptDetail,calendarReceipt,minimalReceipt,accountParts,collectionReversed,collectionRestored,reversed,restored,sourceConversion,sourceRetry,standardActions,protectedDelete,protectedComponent,deletedWhole,draftProtected};
   checks.push({native,theme,width,...outcomes,retryState,overflow,internalScroll,errors,pass:Object.values(outcomes).every(Boolean)&&!overflow&&!internalScroll&&!errors.length});
  }finally{
   if(ledgerId&&csrf)await context.request.post(base+'/ledgers/'+ledgerId+'/delete',{form:{_csrf:csrf,confirm:name}});
   if(originalLedger&&csrf)await context.request.post(base+'/ledgers/switch',{form:{_csrf:csrf,ledger_id:originalLedger}});
   await context.close();
  }
 }
 return checks;
};
