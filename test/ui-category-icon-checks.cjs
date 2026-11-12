module.exports=async function(browser,session,base){
 const checks=[];
 for(const native of [false,true])for(const theme of ['light','dark'])for(const width of [390,1920]){
  const context=await browser.newContext({storageState:await session.storageState(),javaScriptEnabled:!native,viewport:{width,height:844},reducedMotion:'reduce'});
  try{
   const page=await context.newPage();await page.goto(base+'/theme/'+theme);await page.goto(base+'/categories');
   await page.locator('.category-create-disclosure > summary').click();
   const create=native?page.locator('.category-create-form'):page.locator('.category-modal .category-create-form');
   const picker=create.locator('.category-icon-picker');
   if(!await picker.count()){checks.push({native,theme,width,missingPicker:true,pass:false});continue;}
   let selected=true,reset=true;
   if(native){
    selected=await picker.locator('datalist option').count()>=24&&await picker.locator('[data-icon-choice]:visible').count()===0;
    await picker.locator('[name=icon]').fill('☕');
   }else{
    await picker.getByRole('button',{name:'选择咖啡图标',exact:true}).focus();await page.keyboard.press('Enter');
    selected=await picker.locator('[name=icon]').inputValue()==='☕'&&await picker.locator('[data-icon-choice="☕"]').getAttribute('aria-pressed')==='true'&&await picker.locator('.category-icon-preview').textContent()==='☕';
    await page.keyboard.press('Escape');await page.locator('.category-create-disclosure > summary').click();
    reset=await picker.locator('[name=icon]').inputValue()==='🏷️'&&await picker.locator('[data-icon-choice="🏷️"]').getAttribute('aria-pressed')==='true';
    await picker.getByRole('button',{name:'选择咖啡图标',exact:true}).click();
   }
   await create.locator('[name=name]').fill('图标回归 '+theme+' '+width+' '+(native?'原生':'交互'));
   await page.screenshot({path:'.screenshots/audit-after/category-icon-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',animations:'disabled'});
   await Promise.all([page.waitForNavigation(),create.locator('button[type=submit]').click()]);
   const id=new URL(page.url()).searchParams.get('focus'),entry=page.locator('.category-entry[data-category-id="'+id+'"]');
   const created=(await entry.locator('summary .category-entry-icon').textContent()).trim()==='☕';
   await entry.locator(':scope > summary').click();
   const edit=native?entry.locator('.category-edit-form'):page.locator('.category-modal .category-edit-form');
   await edit.locator('[name=icon]').fill('🌻');
   const custom=native||await edit.locator('.category-icon-preview').textContent()==='🌻'&&await edit.locator('[data-icon-choice][aria-pressed=true]').count()===0;
   await Promise.all([page.waitForNavigation(),edit.locator('button[type=submit]').click()]);
   const persisted=(await page.locator('.category-entry[data-category-id="'+id+'"] summary .category-entry-icon').textContent()).trim()==='🌻';
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   checks.push({native,theme,width,selected,reset,created,custom,persisted,overflow,pass:selected&&reset&&created&&custom&&persisted&&!overflow});
  }finally{await context.close();}
 }
 return checks;
};
