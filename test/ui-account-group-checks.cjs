// Isolated browser acceptance: type sections share page width, cards keep natural
// heights, and balances in different currencies never get added together.
module.exports=async function(page,base){
 const checks=[];
 for(const theme of ['light','dark'])for(const width of [390,820,1280,1920,2560]){
  await page.setViewportSize({width,height:900});
  await page.goto(base+'/theme/'+theme);await page.goto(base+'/accounts');
  const metrics=await page.locator('.account-groups').evaluate(root=>{
   const sections=[...root.querySelectorAll('.account-type-group')],bounds=root.getBoundingClientRect();
   const amount=text=>Number(text.replace(/[^\d.-]/g,''));
   const groups=sections.map(section=>{
    const cards=[...section.querySelectorAll('.account-entry')],r=section.getBoundingClientRect(),totals={};
    for(const card of cards){
     const currency=card.querySelector('.account-entry-head .tiny').textContent.trim().split(/\s/)[0];
     totals[currency]=(totals[currency]||0)+Math.round(amount(card.querySelector('.account-entry-head .amount').textContent)*100);
    }
    const shown=[...section.querySelectorAll('.account-type-balances .amount')];
    const currencies=shown.every(el=>{const currency=el.textContent.trim().split(/\s/).at(-1);return Math.round(amount(el.textContent)*100)===totals[currency];})&&shown.length===Object.keys(totals).length;
    const count=Number(section.querySelector('h2 span').textContent.replace(/\D/g,''))===cards.length;
    return {id:section.id,count:cards.length,validCount:count,currencies,fullWidth:Math.abs(r.left-bounds.left)<1&&Math.abs(r.width-bounds.width)<1};
   });
   return {groups,allGrouped:root.querySelectorAll('.account-entry').length===groups.reduce((n,g)=>n+g.count,0),noOverflow:document.documentElement.scrollWidth<=innerWidth+1,gaps:sections.slice(1).map((s,i)=>Math.round(s.getBoundingClientRect().top-sections[i].getBoundingClientRect().bottom))};
  });
  let editor=true;
  if(await page.locator('.acc-edit').count()){
   await page.locator('.acc-edit').first().click();
   editor=await page.locator('.account-entry:has(.account-editor:not(.hidden))').evaluate(el=>{
    const r=el.getBoundingClientRect(),p=el.closest('.account-cards').getBoundingClientRect();
    return Math.abs(r.left-p.left)<1&&Math.abs(r.width-p.width)<1&&el.scrollHeight<=el.clientHeight+2;
   });
  }
  checks.push({theme,width,...metrics,editor,pass:metrics.allGrouped&&metrics.noOverflow&&metrics.groups.length>0&&metrics.groups.every(g=>g.validCount&&g.currencies&&g.fullWidth)&&metrics.gaps.every(g=>g===24)&&editor});
 }
 return checks;
};
