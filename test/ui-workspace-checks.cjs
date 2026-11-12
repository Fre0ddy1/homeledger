// Task-level layout assertions; use an already authenticated isolated page.
module.exports=async function(page,base){
 const checks=[];
 for(const width of [390,1920,2560]){
  await page.setViewportSize({width,height:844});
  await page.goto(base+'/transactions/new');await page.waitForTimeout(250);
  const categoryGroups=await page.locator('.cat-section:not(.hidden) .cat-group:visible').count();
  const parents=await page.locator('.cat-section:not(.hidden) .cat-parent:visible').count();
  const action=page.locator('.entry-actionbar button[type=submit]');
  let reachable=await action.count()===1;
  for(const position of [0,.5,1]){
   await page.evaluate(p=>scrollTo(0,(document.documentElement.scrollHeight-innerHeight)*p),position);
   reachable=reachable&&await action.evaluateAll(nodes=>nodes.every(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===el;}));
  }
  let categoryChoice=false,targetBinding=false,invalidDate=false,invalidAccount=false;
  if(await page.locator('.entry-category-picker:not(.hidden)').count()){
   await page.locator('.cat-section:not(.hidden) .cat-parent').nth(1).click();
   await page.locator('.cat-section:not(.hidden) .cat-group:visible .cat-item').first().click();
   const selected=await page.locator('#f-category').inputValue();
   await page.locator('.cat-section:not(.hidden) .cat-parent').first().click();
   categoryChoice=selected!==''&&await page.locator('#f-category').inputValue()===selected&&await page.locator('.cat-section:not(.hidden) .cat-group:visible').count()===1;
  }
  if(await action.count()){
   await page.locator('#f-amount').fill('10');
   const date=page.locator('#txn-form [name=txn_date]');
   await date.evaluate(el=>{el.value='';el.dispatchEvent(new Event('change',{bubbles:true}));});
   await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await action.click();await page.waitForTimeout(70);
   invalidDate=await date.evaluate(el=>{const trigger=el.closest('.hl-date')?.querySelector('.hl-date-trigger')||el;return document.activeElement===trigger&&trigger.getAttribute('aria-invalid')==='true'&&!!el.closest('.field').querySelector('.field-error');});
   await date.evaluate(el=>{el.value=new Date().toISOString().slice(0,10);el.dispatchEvent(new Event('change',{bubbles:true}));});
   await page.locator('[data-entry-type=repayment]').click();
   targetBinding=await action.evaluate(el=>!!el.form&&!!el.form.closest('[data-repayment-target]:not(.hidden)'));
   const account=page.locator('[data-repayment-target]:not(.hidden) [name=account_id]');
   await account.evaluate(el=>{el.value='';el.dispatchEvent(new Event('change',{bubbles:true}));});
   await action.click();await page.waitForTimeout(70);
   invalidAccount=await account.evaluate(el=>{const trigger=el.closest('.hl-select')?.querySelector('.hl-select-trigger')||el;return document.activeElement===trigger&&trigger.getAttribute('aria-invalid')==='true';});
   await page.locator('[data-entry-type=expense]').click();
   targetBinding=targetBinding&&await action.getAttribute('form')==='txn-form';
  }
  await page.goto(base+'/accounts');
  const gap=await page.locator('#new-account').evaluate(el=>Math.round(el.getBoundingClientRect().top-document.querySelector('.account-groups').getBoundingClientRect().bottom));
  await page.goto(base+'/subscriptions');
  const editor=await page.locator('#sub-form').evaluate(el=>Math.round(el.getBoundingClientRect().width));
  const dates=await page.locator('#sub-form .hl-date').evaluateAll(nodes=>nodes.filter(el=>el.getClientRects().length).map(el=>el.getBoundingClientRect().width));
  await page.goto(base+'/reports');
  const report=await page.locator('.report-workspace').count()===1&&await page.getByText('同期消费参考',{exact:true}).count()===1;
  checks.push({width,categoryGroups,parents,reachable,categoryChoice,targetBinding,invalidDate,invalidAccount,gap,editor,dates,report,pass:categoryGroups===1&&parents>1&&reachable&&categoryChoice&&targetBinding&&invalidDate&&invalidAccount&&gap===24&&(width<1100||editor>=520)&&dates.every(w=>w>=150&&w<=221)&&report});
 }
 return checks;
};
