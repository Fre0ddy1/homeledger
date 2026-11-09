const {chromium}=require('../.tmp/ui-qa/node_modules/playwright');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const ejs=require('ejs');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const root=path.resolve(__dirname,'..');
function findContentScrollers(){return [...document.querySelectorAll('.page-body *')].filter(el=>el.getClientRects().length&&!el.matches('textarea,select,input')&&!el.closest('.hl-select-menu,.hl-date-menu')&&['auto','scroll'].includes(getComputedStyle(el).overflowY)&&el.scrollHeight>el.clientHeight+2).map(el=>el.tagName+'.'+el.className);}
const demoEnv={...process.env, DATA_DIR:path.join(root,'.tmp/data-ui-browser'), UI_FIXTURE_DIR:path.join(root,'.tmp/data-ui-browser')};
execFileSync(process.execPath,['scripts/seed-demo.js'],{cwd:root,env:demoEnv,stdio:'ignore'});
execFileSync(process.execPath,['test/fixtures/ui-preview.cjs'],{cwd:root,env:demoEnv,stdio:'ignore'});
const server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:root+'/.tmp/data-ui-browser',PORT:'5113',HOST:'127.0.0.1',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
const serverReady=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('QA服务器启动超时')),12000);server.stdout.on('data',buf=>{if(buf.toString().includes('家账簿 已启动')){clearTimeout(timer);resolve();}});server.once('exit',code=>{clearTimeout(timer);reject(new Error('QA服务器提前退出 '+code));});server.once('error',reject);});
const routes=['/','/transactions','/transactions/new','/calendar','/reports','/annual','/search','/accounts','/accounts/1','/budgets','/goals','/debts','/subscriptions','/recurring','/categories','/tags','/import','/export','/ledgers','/members','/notifications','/settings','/about','/ai','/attachments','/more','/not-found'];
(async()=>{
 let browser;
 try {
  await serverReady;
  for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:5113/healthz')).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({executablePath:process.env.UI_BROWSER_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context=await browser.newContext({viewport:{width:1920,height:1080}});
  const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5113/login');await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill('admin123456');await page.locator('button[type=submit]').click();await page.waitForURL('http://127.0.0.1:5113/');
  const results=[];fs.mkdirSync(root+'/.screenshots/audit-after',{recursive:true});
  for(const theme of ['light','dark']){
   await page.goto('http://127.0.0.1:5113/theme/'+theme);
   for(const width of [390,820,1280,1920,2560]){
    await page.setViewportSize({width,height:1080});
    for(const route of routes){
     const res=await page.goto('http://127.0.0.1:5113'+route);await page.waitForTimeout(40);
     const metrics=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,contentWidth:document.querySelector('.content')?.getBoundingClientRect().width,offenders:[...document.querySelectorAll('main *, .content *')].filter(x=>{const r=x.getBoundingClientRect();return r.width&&r.right>innerWidth+2&&!x.closest('.scroll-x,.hl-select-menu,.hl-date-panel');}).slice(0,5).map(x=>x.tagName+'.'+x.className)}));
     if(route==='/'){
      // The content scrolls with the document; navigation and popup menus have
      // their own bounded interaction and are outside this page-body audit.
      const layout=await page.evaluate(()=>{const cols=[...document.querySelectorAll('.dashboard-column')];return {columns:cols.length,gaps:cols.flatMap(col=>[...col.children].slice(1).map((card,i)=>Math.round(card.getBoundingClientRect().top-col.children[i].getBoundingClientRect().bottom)))};});
      metrics.dashboardColumns=layout.columns;metrics.columnGaps=layout.gaps;
     }
     if(route==='/transactions')metrics.listWidth=await page.locator('.transactions-primary').evaluate(el=>el.getBoundingClientRect().width);
     metrics.contentScrollers=await page.evaluate(findContentScrollers);
     if(route==='/categories')metrics.flatCategories=await page.locator('.category-navigation').evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display==='grid'&&s.position==='static'&&s.maxHeight==='none'&&[...el.querySelectorAll('a')].every(a=>{const b=a.getBoundingClientRect();return b.top>=r.top&&b.bottom<=r.bottom+1;});});
     if(width>=1280){
      metrics.pageWidth=await page.locator('.page-body').evaluateAll(nodes=>nodes[0]?.getBoundingClientRect().width||0);
      metrics.cards=await page.locator('.card').evaluateAll(nodes=>nodes.filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();const children=[...el.children].filter(c=>c.getClientRects().length);const end=Math.max(r.top,...children.map(c=>c.getBoundingClientRect().bottom));return {title:el.querySelector('h2')?.textContent,width:Math.round(r.width),height:Math.round(r.height),slack:Math.round(r.bottom-end-parseFloat(getComputedStyle(el).paddingBottom))};}));
     }
     if(width===1920){
      await page.waitForTimeout(230);const slug=route==='/'?'home':route.replaceAll('/','-').slice(1);
      await page.screenshot({path:root+`/.screenshots/audit-after/${theme}-${slug}.png`});
      await page.screenshot({path:root+`/.screenshots/audit-after/${theme}-${slug}-full.png`,fullPage:true});
     }
     results.push({theme,width,route,status:res.status(),...metrics});
     if(route==='/'&&[390,1920,2560].includes(width)||route==='/transactions/new'&&width===1920) await page.waitForTimeout(260);
     if(route==='/'&&[390,1920,2560].includes(width)||route==='/transactions/new'&&width===1920) await page.screenshot({path:root+`/.screenshots/${theme}-${width}-${route==='/'?'dashboard':'form'}.png`,fullPage:true});
     if(route==='/transactions'&&width===1920){await page.waitForTimeout(240);await page.screenshot({path:root+`/.screenshots/${theme}-transactions.png`,fullPage:true});}
     if(route==='/'&&width===1920&&theme==='light') await page.screenshot({path:root+'/.screenshots/desktop-preview.png'});
    }
   }
  }
  const variants=[];
  for(const theme of ['light','dark']){
   await page.goto('http://127.0.0.1:5113/theme/'+theme);await page.setViewportSize({width:1920,height:1080});
   for(const width of [390,820,1280,1920,2560]){
    await page.setViewportSize({width,height:1080});await page.goto('http://127.0.0.1:5113/settings');
    for(const tab of ['account','ai','api','site','admin','env']){
     await page.locator('.tabs a[href="#'+tab+'"]').click();await page.waitForTimeout(240);
     const visible=await page.locator('[data-tab="'+tab+'"]').isVisible();
     const cards=await page.locator('.card[data-tab="'+tab+'"], [data-tab="'+tab+'"] > .card').evaluateAll(nodes=>nodes.filter(el=>el.getClientRects().length).map(el=>el.getBoundingClientRect().width));
     const cardLimit=tab==='ai'||tab==='site'?841:tab==='api'?1081:961;
     variants.push({theme,state:'settings-'+tab,width,visible,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),cardsFit:cards.every(w=>w<=cardLimit),contentScrollers:await page.evaluate(findContentScrollers)});
     if(width===1920)await page.screenshot({path:root+`/.screenshots/audit-after/${theme}-settings-${tab}.png`,fullPage:true});
    }
   }
   await page.setViewportSize({width:1920,height:1080});
   await page.goto('http://127.0.0.1:5113/accounts');await page.locator('.acc-edit').first().click();
   await page.screenshot({path:root+`/.screenshots/audit-after/${theme}-account-edit.png`});
   await page.goto('http://127.0.0.1:5113/transactions');const editId=await page.locator('.txn').first().getAttribute('data-txn-id');
   for(const width of [390,1280,1920,2560]){
    await page.setViewportSize({width,height:1080});await page.goto('http://127.0.0.1:5113/transactions/'+editId+'/edit');
    variants.push({theme,state:'transaction-edit',width,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),pageWidth:await page.locator('.page-body').evaluate(el=>el.getBoundingClientRect().width),contentScrollers:await page.evaluate(findContentScrollers)});
    if(width===1920)await page.screenshot({path:root+`/.screenshots/audit-after/${theme}-transaction-edit.png`});
   }
  }
  // Regression checks for independent column flow, compact ledger and inspector.
  const dashboardGaps=results.filter(r=>r.route==='/').every(r=>r.columnGaps.every(g=>Math.abs(g-20)<=1));
  const compactLedger=results.filter(r=>r.route==='/transactions').every(r=>r.listWidth<=1101);
  await page.setViewportSize({width:1920,height:1080});await page.goto('http://127.0.0.1:5113/transactions');
  const compactPageSize=await page.locator('.transactions-primary .txn').count()<=20;
  const advancedCollapsed=!(await page.locator('.transaction-filters').getAttribute('open'))&&!(await page.locator('.transaction-filters').evaluate(el=>el.open));
  const listRow=page.locator('.transactions-primary .txn').first();await listRow.focus();await page.keyboard.press('Enter');await page.locator('.inspector-detail .txn-detail').waitFor();
  const inlineDetails=await page.locator('.modal-mask').count()===0;
  await page.setViewportSize({width:1920,height:720});
  await page.locator('.inspector-detail [data-act=close]').scrollIntoViewIfNeeded();
  await page.locator('.inspector-detail [data-act=close]').focus();
  const inspectorControlsReachable=await page.locator('.inspector-detail [data-act=close]').evaluate(el=>{const r=el.getBoundingClientRect(),side=el.closest('.transactions-secondary');return r.bottom<=innerHeight+1&&r.top>=0&&getComputedStyle(side).position==='static'&&side.scrollHeight<=side.clientHeight+2;});
  await page.setViewportSize({width:1920,height:1080});
  await page.keyboard.press('Escape');const inspectorFocusReturned=await listRow.evaluate(el=>el===document.activeElement);
  await listRow.focus();await page.keyboard.press('Enter');await page.locator('.inspector-detail').waitFor();await page.setViewportSize({width:390,height:844});
  const inspectorResizeReleased=await page.locator('.inspector-detail').count()===0;
  await page.keyboard.press('Enter');await page.locator('.modal-mask .txn-detail').waitFor();await page.keyboard.press('Escape');
  const mobileDetails=await listRow.evaluate(el=>el===document.activeElement);
  await page.goto('http://127.0.0.1:5113/');await page.setViewportSize({width:1920,height:1080});await page.setViewportSize({width:390,height:844});
  const mobileOrder=await page.locator('.dashboard-column').evaluate(el=>{const heads=[...el.children].slice(0,3).map(c=>c.querySelector('h2')?.textContent);return heads.join(',')==='收支趋势,今日速览,最近记录';});
  // Primary keyboard journeys.
  await page.setViewportSize({width:1920,height:1080});await page.goto('http://127.0.0.1:5113/');
  await page.locator('#userMenuBtn').click();await page.keyboard.press('Escape');
  const menuClosed=await page.locator('#userMenuBtn').getAttribute('aria-expanded')==='false';
  const focusReturned=await page.locator('#userMenuBtn').evaluate(el=>el===document.activeElement);
  const row=page.locator('.txn[data-txn-id]').first();await row.focus();await page.keyboard.press('Enter');await page.locator('.txn-detail').waitFor();await page.keyboard.press('Escape');
  const rowFocusReturned=await row.evaluate(el=>el===document.activeElement);
  await page.evaluate(()=>{window.hlConfirm('测试焦点');});await page.keyboard.press('Tab');await page.keyboard.press('Tab');
  const trapped=await page.evaluate(()=>!!document.activeElement.closest('.modal'));
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});await page.locator('#navBurger').click();await page.keyboard.press('Escape');
  const drawerClosed=await page.locator('#navBurger').getAttribute('aria-expanded')==='false';
  await page.locator('#navBurger').click();await page.setViewportSize({width:1280,height:900});
  const resizedDrawerReleased=await page.evaluate(()=>!document.body.classList.contains('nav-open')&&document.activeElement.id==='main-content');
  const bar=await page.locator('.topbar').boundingBox();await page.mouse.move(bar.x+100,bar.y+20);await page.waitForTimeout(60);
  const glassMaterial=await page.locator('.topbar').evaluate(el=>getComputedStyle(el).backdropFilter.includes('blur')&&el.style.getPropertyValue('--glass-x')!=='');
  await page.emulateMedia({reducedMotion:'reduce'});const reduced=await page.locator('.card').first().evaluate(el=>getComputedStyle(el).animationName==='none');
  await page.goto('http://127.0.0.1:5113/ui-mode?simple=1');
  const minimal=await page.locator('body').getAttribute('data-layout')==='m';
  await page.screenshot({path:root+'/.screenshots/minimal-390.png',fullPage:true});
  // Coarse pointer tablet uses the same drawer as CSS, without forcing phone UA.
  const touchContext=await browser.newContext({viewport:{width:1024,height:768},hasTouch:true,storageState:await context.storageState()});
  const touchPage=await touchContext.newPage();await touchPage.goto('http://127.0.0.1:5113/ui-mode?simple=0');
  const coarseTablet=await touchPage.locator('#navBurger').isVisible()&&await touchPage.evaluate(()=>!document.documentElement.scrollWidth||document.documentElement.scrollWidth<=innerWidth+1);
  // 1920 physical pixels at 200% scale: 960 CSS pixels and DPR 2.
  const tabletDrawerLayout=await touchPage.evaluate(()=>{const side=document.querySelector('.sidebar'),content=document.querySelector('.content').getBoundingClientRect();return getComputedStyle(side).position==='fixed'&&content.left<50&&content.width>=innerWidth-80;});
  const phoneContext=await browser.newContext({viewport:{width:390,height:844},storageState:await context.storageState()});
  const phonePage=await phoneContext.newPage();await phonePage.goto('http://127.0.0.1:5113/ui-mode?simple=0');
  const phoneDrawerLayout=await phonePage.evaluate(()=>{const side=document.querySelector('.sidebar'),content=document.querySelector('.content').getBoundingClientRect();return getComputedStyle(side).position==='fixed'&&content.left<30&&content.width>=innerWidth-60;});
  const zoomContext=await browser.newContext({viewport:{width:960,height:540},deviceScaleFactor:2,storageState:await context.storageState()});
  const zoomPage=await zoomContext.newPage();await zoomPage.goto('http://127.0.0.1:5113/ui-mode?simple=0');
  const zoom200=await zoomPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&devicePixelRatio===2);
  await page.goto('http://127.0.0.1:5113/ui-mode?simple=0');
  let ledgerMenuFits=true;
  for(const width of [960,1024]){
   await page.setViewportSize({width,height:900});
   await page.locator('.ledger-switch .hl-select-trigger').click();
   ledgerMenuFits=ledgerMenuFits&&await page.locator('.ledger-switch .hl-select-menu').evaluate(el=>{const r=el.getBoundingClientRect(),s=el.closest('.sidebar').getBoundingClientRect();return r.width>0&&r.left>=s.left&&r.right<=s.right;});
   await page.keyboard.press('Escape');
  }
  const authContext=await browser.newContext();const authPage=await authContext.newPage();
  const authChecks=[];
  const inspect=async(label,width)=>{authChecks.push({label,width,overflow:await authPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});};
  for(const width of [390,820,1280,1920,2560]){
   await authPage.setViewportSize({width,height:900});
   for(const route of ['/login','/register']){await authPage.goto('http://127.0.0.1:5113'+route);await inspect(route,width);}
   const locals={csrf:'qa-fixture',error:null,form:{},siteName:'家账簿',title:'初始化',flash:null,assetV:{css:'qa',js:'qa'}};
   const body=await ejs.renderFile(path.join(root,'src/views/setup.ejs'),locals);
   const html=await ejs.renderFile(path.join(root,'src/views/layout-blank.ejs'),{...locals,body});
   await authPage.setContent(html);await inspect('setup visual fixture',width);
  }
  await authPage.goto('http://127.0.0.1:5113/login');await authPage.locator('[name=username]').fill('qa_empty');await authPage.locator('[name=password]').fill('testpass123');await authPage.locator('button[type=submit]').click();await authPage.waitForURL('http://127.0.0.1:5113/');
  for(const width of [390,820,1280,1920,2560]){
   await authPage.setViewportSize({width,height:900});
   for(const route of ['/','/join/ui-qa-invite']){await authPage.goto('http://127.0.0.1:5113'+route);await inspect(route==='/'?'no-ledger':'join',width);}
  }
  await page.setViewportSize({width:1280,height:900});await page.goto('http://127.0.0.1:5113/categories');
  let editor=page.locator('.category-entry').first();await editor.locator('summary').click();await page.locator('.category-modal [name=name]').fill('浏览器恢复分类');
  await Promise.all([page.waitForNavigation(),page.locator('.category-modal .category-edit-form button').click()]);
  editor=page.locator('.category-entry').filter({has:page.locator('summary',{hasText:'浏览器恢复分类'})}).first();await editor.locator('summary').click();await page.locator('.category-modal .category-delete').click();
  await Promise.all([page.waitForNavigation(),page.locator('.modal [data-act=ok]').click()]);
  await page.goto('http://127.0.0.1:5113/categories?show=deleted');
  const deleted=page.locator('.category-deleted-row').filter({hasText:'浏览器恢复分类'});const categorySoftDeleted=await deleted.count()===1;
  await Promise.all([page.waitForNavigation(),deleted.locator('button').click()]);await page.goto('http://127.0.0.1:5113/categories');
  const categoryRestored=await page.locator('.category-entry > summary').filter({hasText:'浏览器恢复分类'}).count()===1;
  await page.locator('.category-create-disclosure > summary').click();await page.locator('.category-modal').waitFor();
  await page.locator('.category-modal .hl-select-trigger').first().click();await page.locator('.category-modal .hl-select-opt').filter({hasText:'收入'}).click();
  const categoryKindSync=await page.locator('#new-cat-parent').evaluate(el=>[...el.options].filter(o=>o.parentElement.label==='支出').every(o=>o.disabled));
  await page.locator('.category-modal .hl-select-trigger').first().click();await page.keyboard.press('Escape');
  const categoryDropdownEscape=await page.locator('.category-modal').count()===1;
  await page.keyboard.press('Escape');
  const categoryModalFocusReturned=await page.locator('.category-create-disclosure > summary').evaluate(el=>el===document.activeElement);
  await page.goto('http://127.0.0.1:5113/recurring');await page.locator('#rec-add').click();
  const fresh=page.locator('.rec-item').last();await fresh.locator('.hl-select-trigger').first().click();await fresh.locator('.hl-select-opt').filter({hasText:'收入'}).click();
  const recurringClonedSelect=await fresh.locator('[name=item_type]').inputValue()==='income';
  const noJsContext=await browser.newContext({javaScriptEnabled:false,storageState:await context.storageState(),viewport:{width:1280,height:900}});
  const noJsPage=await noJsContext.newPage();await noJsPage.goto('http://127.0.0.1:5113/categories?kind=income');await noJsPage.locator('.category-entry > summary').first().click();
  const categoryNoJs=await noJsPage.locator('.category-edit-form').first().isVisible();
  const naturalCards=results.filter(r=>r.cards).every(r=>r.cards.every(c=>c.slack<=80))&&results.every(r=>r.contentScrollers.length===0&&r.flatCategories!==false)&&variants.every(r=>r.contentScrollers.length===0);
  const boundedPages=results.filter(r=>r.width>=1920&&!['/','/more','/not-found'].includes(r.route)).every(r=>r.pageWidth<=1465);
  const variantLayouts=variants.every(v=>!v.overflow&&v.visible!==false&&v.cardsFit!==false&&(!v.pageWidth||v.pageWidth<=1281));
  const darkAuth=await browser.newContext({colorScheme:'dark',viewport:{width:390,height:844}});const darkLogin=await darkAuth.newPage();
  await darkLogin.goto('http://127.0.0.1:5113/login');
  const darkLoginTheme=await darkLogin.locator('html').getAttribute('data-theme')==='dark';
  await darkLogin.screenshot({path:root+'/.screenshots/audit-after/dark-login.png'});
  await page.goto('http://127.0.0.1:5113/categories');await page.locator('.category-create-disclosure > summary').click();
  const kindTrigger=page.locator('.category-modal .hl-select-trigger').first();await kindTrigger.click();await page.locator('.category-modal .modal-title').click();await kindTrigger.click();
  const selectReopensAfterOutside=await kindTrigger.getAttribute('aria-expanded')==='true';await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  const wideContentFills=results.filter(r=>r.route==='/'&&r.width>=1920).every(r=>Math.abs(r.contentWidth-(r.width-240))<=1)&&tabletDrawerLayout&&phoneDrawerLayout;
  const interaction={menuClosed,focusReturned,rowFocusReturned,trapped,drawerClosed,resizedDrawerReleased,reduced,minimal,coarseTablet,zoom200,wideContentFills,ledgerMenuFits,dashboardGaps,compactLedger,advancedCollapsed,inlineDetails,inspectorFocusReturned,inspectorResizeReleased,mobileDetails,mobileOrder,inspectorControlsReachable,glassMaterial,categorySoftDeleted,categoryRestored,compactPageSize,categoryKindSync,categoryModalFocusReturned,categoryDropdownEscape,recurringClonedSelect,categoryNoJs,naturalCards,boundedPages,variantLayouts,darkLoginTheme,selectReopensAfterOutside};
  const summary={pages:results.length,failures:results.filter(x=>x.overflow||x.status>=500),errors,interaction,authChecks,variants,results};
  if(summary.failures.length||errors.length||Object.values(interaction).some(v=>!v)||authChecks.some(x=>x.overflow))process.exitCode=1;

  fs.writeFileSync(root+'/.screenshots/qa.json',JSON.stringify(summary,null,2));
  console.log(JSON.stringify({...summary,results:undefined,authChecks:undefined,variants:undefined},null,2));
 }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
