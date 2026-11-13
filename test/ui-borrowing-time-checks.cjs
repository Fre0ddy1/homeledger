module.exports=async function(browser,session,base){
 const checks=[];
 for(const native of [false,true])for(const theme of ['light','dark']){
  const context=await browser.newContext({storageState:await session.storageState(),javaScriptEnabled:!native,viewport:{width:390,height:844},reducedMotion:'reduce'});
  try{
   const page=await context.newPage();await page.goto(base+'/theme/'+theme);await page.goto(base+'/debts');
   const target=await page.locator('a[href^="/debts/"]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')).find(h=>/^\/debts\/\d+$/.test(h)));
   if(!target)throw Error('借钱时间验收需要真实条目fixture');
   await page.goto(base+target);
   for(const width of [390,820,1280,1920,2560]){
    await page.setViewportSize({width,height:844});
    const row=page.locator('form[action$="/settle"] .transaction-clock-row');await row.evaluate(el=>el.scrollIntoView({block:'center'}));
    const layout=await row.evaluate(el=>{const date=el.querySelector('[name=date]'),clock=el.querySelector('[name=time]'),a=(date.closest('.hl-date')?.querySelector('.hl-date-trigger')||date).getBoundingClientRect(),b=clock.getBoundingClientRect();const separate=a.right<=b.left+1||b.right<=a.left+1;return {aligned:separate?Math.abs(a.top-b.top)<2:b.top>=a.bottom&&Math.abs(a.left-b.left)<2,overflow:document.documentElement.scrollWidth>innerWidth+1};});
    await page.screenshot({path:'.screenshots/audit-after/borrowing-time-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',animations:'disabled'});
    checks.push({native,theme,width,...layout,pass:layout.aligned&&!layout.overflow});
   }
  }finally{await context.close();}
 }
 return checks;
};
