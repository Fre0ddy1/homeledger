module.exports=async function(browser,session,base){
 const checks=[];
 for(const native of [false,true])for(const theme of ['light','dark'])for(const width of [390,1920]){
  const context=await browser.newContext({storageState:await session.storageState(),javaScriptEnabled:!native,viewport:{width,height:844},reducedMotion:'reduce'});
  try{
   const page=await context.newPage(),entry=await context.newPage();await page.goto(base+'/theme/'+theme);await page.goto(base+'/categories?sort=1');
   const labels=()=>page.locator('.category-nav-item > a').allTextContents();
   const before=await labels();
   await Promise.all([page.waitForNavigation(),page.locator('.category-nav-item').nth(1).locator('[data-direction=up]').click()]);
   const movedRoot=new URL(page.url()).searchParams.get('focus');
   const rootChanged=(await labels())[0]===before[1];
   await entry.goto(base+'/transactions/new');
   const rootSynced=await entry.locator('#f-category optgroup[data-kind=expense]').first().evaluate((el,id)=>el.querySelector('option').value===id,movedRoot);
   await Promise.all([page.waitForNavigation(),page.locator('.category-nav-item').first().locator('[data-direction=down]').click()]);
   const rootReturned=(await labels()).join('|')===before.join('|');
   const group=await page.locator('.category-nav-item > a').evaluateAll(nodes=>nodes.find(el=>Number(el.querySelector('.count').textContent)>=2).getAttribute('href'));
   await page.goto(base+group);
   const childLabels=()=>page.locator('.category-child-item .category-entry-name').allTextContents();
   const childBefore=await childLabels();
   await Promise.all([page.waitForNavigation(),page.locator('.category-child-item').nth(1).locator('[data-direction=up]').click()]);
   const movedChild=new URL(page.url()).searchParams.get('focus'),parent=new URL(page.url()).searchParams.get('group');
   const childChanged=(await childLabels())[0]===childBefore[1];
   await entry.goto(base+'/transactions/new');
   const childSynced=await entry.locator('#f-category').evaluate((el,{parent,id})=>[...el.querySelectorAll('optgroup')].find(g=>g.querySelector('option').value===parent)?.querySelectorAll('option')[1]?.value===id,{parent,id:movedChild});
   const movedVisible=await page.locator('#category-order-'+movedChild).evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=90&&r.bottom<=innerHeight-70;});
   await page.screenshot({path:'.screenshots/audit-after/category-sort-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',animations:'disabled'});
   await Promise.all([page.waitForNavigation(),page.locator('.category-child-item').first().locator('[data-direction=down]').click()]);
   const childReturned=(await childLabels()).join('|')===childBefore.join('|');
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   checks.push({native,theme,width,rootChanged,rootSynced,rootReturned,childChanged,childSynced,childReturned,movedVisible,overflow,pass:rootChanged&&rootSynced&&rootReturned&&childChanged&&childSynced&&childReturned&&movedVisible&&!overflow});
  }finally{await context.close();}
 }
 return checks;
};
