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
   let selected=true,reset=true,searchMatches=true,noMatchesPreserved=true,searchReset=true,grouped=true,searchAcrossGroups=true;
   const choices=await picker.locator('datalist option').evaluateAll(nodes=>nodes.map(n=>n.value));
   const expandedChoices=choices.length>300&&new Set(choices).size===choices.length&&choices.includes('🚇')&&choices.includes('📅')&&choices.includes('🪣')&&choices.includes('🦷');
   if(native){
    selected=await picker.locator('datalist option').count()>300&&await picker.locator('[data-icon-choice]:visible').count()===0;
    await picker.locator('[name=icon]').fill('🚇');
   }else{
    await picker.getByRole('button',{name:'选择咖啡图标',exact:true}).focus();await page.keyboard.press('Enter');
    selected=await picker.locator('[name=icon]').inputValue()==='☕'&&await picker.locator('[data-icon-common-grid] [data-icon-choice="☕"]').getAttribute('aria-pressed')==='true'&&await picker.locator('.category-icon-preview').textContent()==='☕';
    await picker.locator('.category-icon-more > summary').click();
    await picker.locator('[data-icon-search]').fill('猫砂');
    searchMatches=await picker.getByRole('button',{name:'选择猫砂清洁图标',exact:true}).isVisible();
    await picker.getByRole('button',{name:'选择猫砂清洁图标',exact:true}).click();
    await picker.locator('[data-icon-search]').fill('不存在的图标XYZ');
    noMatchesPreserved=await picker.locator('[data-icon-empty]').isVisible()&&await picker.locator('[name=icon]').inputValue()==='🪣'&&await picker.locator('[data-icon-choice]:visible').count()===0;
    await page.keyboard.press('Escape');await page.locator('.category-create-disclosure > summary').click();
    searchReset=await picker.locator('[data-icon-search]').inputValue()===''&&await picker.locator('[data-icon-group-filter]').inputValue()==='food';
    reset=await picker.locator('[name=icon]').inputValue()==='🏷️'&&await picker.locator('[data-icon-common-grid] [data-icon-choice="🏷️"]').getAttribute('aria-pressed')==='true';
    await picker.getByRole('button',{name:'选择地铁图标',exact:true}).click();
    selected=selected&&await picker.locator('[name=icon]').inputValue()==='🚇'&&await picker.locator('[aria-label=常用分类图标] [data-icon-choice]').count()===24;
   }
   await create.locator('[name=name]').fill('图标回归 '+theme+' '+width+' '+(native?'原生':'交互'));
   await page.screenshot({path:'.screenshots/audit-after/category-icon-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',animations:'disabled'});
   await Promise.all([page.waitForNavigation(),create.locator('button[type=submit]').click()]);
   const id=new URL(page.url()).searchParams.get('focus'),entry=page.locator('.category-entry[data-category-id="'+id+'"]');
   const created=(await entry.locator('summary .category-entry-icon').textContent()).trim()==='🚇';
   await entry.locator(':scope > summary').click();
   let edit=native?entry.locator('.category-edit-form'):page.locator('.category-modal .category-edit-form');
   if(native){await edit.locator('[name=icon]').fill('📅');}else{
    await edit.locator('.category-icon-more > summary').click();
    const select=edit.locator('[data-icon-group-filter]'),wrapper=select.locator('..');
    if(await wrapper.locator('.hl-select-trigger').count()){
     await wrapper.locator('.hl-select-trigger').click();
     await wrapper.locator('.hl-select-opt').filter({hasText:'收入理财'}).click();
    }else await select.selectOption('finance');
    grouped=await edit.locator('[data-icon-group=finance]').isVisible()&&!await edit.locator('[data-icon-group=food]').isVisible();
    await edit.locator('[data-icon-search]').fill('牙科');
    await edit.locator('[data-icon-search]').press('Enter');
    searchAcrossGroups=await edit.isVisible()&&await edit.getByRole('button',{name:'选择牙科图标',exact:true}).isVisible();
    await edit.locator('[data-icon-search]').fill('');
    await edit.getByRole('button',{name:'选择定期图标',exact:true}).click();
   }
   const moreSelected=await edit.locator('[name=icon]').inputValue()==='📅';
   await page.screenshot({path:'.screenshots/audit-after/category-icon-more-'+theme+'-'+width+'-'+(native?'native':'js')+'.png',animations:'disabled'});
   await Promise.all([page.waitForNavigation(),edit.locator('button[type=submit]').click()]);
   const morePersisted=(await page.locator('.category-entry[data-category-id="'+id+'"] summary .category-entry-icon').textContent()).trim()==='📅';
   await page.locator('.category-entry[data-category-id="'+id+'"] > summary').click();
   edit=native?page.locator('.category-entry[data-category-id="'+id+'"] .category-edit-form'):page.locator('.category-modal .category-edit-form');
   await edit.locator('[name=icon]').fill('🌻🌻');
   const custom=native||await edit.locator('.category-icon-preview').textContent()==='🌻🌻'&&await edit.locator('[data-icon-choice][aria-pressed=true]').count()===0;
   await Promise.all([page.waitForNavigation(),edit.locator('button[type=submit]').click()]);
   const persisted=(await page.locator('.category-entry[data-category-id="'+id+'"] summary .category-entry-icon').textContent()).trim()==='🌻🌻';
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   checks.push({native,theme,width,expandedChoices,selected,reset,searchMatches,noMatchesPreserved,searchReset,grouped,searchAcrossGroups,created,moreSelected,morePersisted,custom,persisted,overflow,pass:expandedChoices&&selected&&reset&&searchMatches&&noMatchesPreserved&&searchReset&&grouped&&searchAcrossGroups&&created&&moreSelected&&morePersisted&&custom&&persisted&&!overflow});
  }finally{await context.close();}
 }
 return checks;
};
