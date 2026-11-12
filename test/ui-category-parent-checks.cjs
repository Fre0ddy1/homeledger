module.exports=async function(browser,session,base){
 const checks=[];
 for(const native of [false,true])for(const theme of ['light','dark'])for(const width of [390,1920]){
  const context=await browser.newContext({storageState:await session.storageState(),javaScriptEnabled:!native,viewport:{width,height:844},reducedMotion:'reduce'});
  try{
   const page=await context.newPage();await page.goto(base+'/theme/'+theme);await page.goto(base+'/categories');
   const entry=page.locator('.category-children-grid .category-entry').first();
   await entry.locator('summary').click();
   let form=native?entry.locator('.category-edit-form'):page.locator('.category-modal .category-edit-form');
   let select=form.locator('[name=parent_id]');const original=await select.inputValue();
   const target=await select.evaluate(el=>[...el.options].find(o=>o.value!==el.value).value);
   async function choose(field,value){
    const wrapper=field.locator('..');
    if(await wrapper.locator('.hl-select-trigger').count()){
     const index=await field.evaluate((el,id)=>[...el.options].findIndex(o=>o.value===id),value);
     await wrapper.locator('.hl-select-trigger').click();await wrapper.locator('.hl-select-opt').nth(index).click();
    }else await field.selectOption(value);
   }
   await choose(select,target);
   await page.screenshot({path:'.screenshots/audit-after/category-parent-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',animations:'disabled'});
   await Promise.all([page.waitForNavigation(),form.locator('button[type=submit]').click()]);
   const moved=new URL(page.url()),focus=moved.searchParams.get('focus');
   const newEntry=page.locator('.category-entry[data-category-id="'+focus+'"]');await newEntry.locator('summary').click();
   form=native?newEntry.locator('.category-edit-form'):page.locator('.category-modal .category-edit-form');select=form.locator('[name=parent_id]');
   const changed=moved.searchParams.get('group')===target&&await select.inputValue()===target;
   await choose(select,original);await Promise.all([page.waitForNavigation(),form.locator('button[type=submit]').click()]);
   const returned=new URL(page.url());
   checks.push({native,theme,width,changed,returned:returned.searchParams.get('group')===original&&returned.searchParams.get('focus')===focus,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
  }finally{await context.close();}
 }
 return checks;
};
