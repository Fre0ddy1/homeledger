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
execFileSync(process.execPath,['test/fixtures/finance-preview.cjs'],{cwd:root,env:demoEnv,stdio:'ignore'});
const server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:root+'/.tmp/data-ui-browser',PORT:'5113',HOST:'127.0.0.1',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
const serverReady=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('QA服务器启动超时')),12000);server.stdout.on('data',buf=>{if(buf.toString().includes('家账簿 已启动')){clearTimeout(timer);resolve();}});server.once('exit',code=>{clearTimeout(timer);reject(new Error('QA服务器提前退出 '+code));});server.once('error',reject);});
const financeIds=JSON.parse(execFileSync(process.execPath,['-e',"const d=require('./src/db');console.log(JSON.stringify({categoryEdits:d.all(\"SELECT id,category_id FROM transactions WHERE merchant LIKE '分类保留-%'\"),loan:d.get('SELECT id FROM finance_contracts ORDER BY id').id,card:d.get('SELECT account_id FROM credit_profiles ORDER BY account_id').account_id,bill:d.get('SELECT id FROM credit_statements WHERE confirmed_at IS NOT NULL ORDER BY id').id,payment:d.get('SELECT id FROM finance_payments ORDER BY id').id,debt:d.get(\"SELECT id FROM debts WHERE managed=1 ORDER BY id\").id}));"],{cwd:root,env:demoEnv,encoding:'utf8',stdio:['ignore','pipe','ignore']}));
const routes=['/transactions/new?type=repayment','/?basis=consumption','/reports?basis=consumption','/finance','/finance/loans/'+financeIds.loan,'/finance/cards/'+financeIds.card,'/finance/statements/'+financeIds.bill,'/finance/payments/'+financeIds.payment,'/debts/'+financeIds.debt,'/','/transactions','/transactions/new','/calendar','/reports','/annual','/search','/accounts','/accounts/1','/budgets','/goals','/debts','/subscriptions','/recurring','/categories','/tags','/import','/export','/ledgers','/members','/notifications','/settings','/about','/ai','/attachments','/more','/not-found'];
(async()=>{
 let browser;
 try {
  await serverReady;
  for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:5113/healthz')).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({executablePath:process.env.UI_BROWSER_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context=await browser.newContext({viewport:{width:1920,height:1080}});
  const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5113/login');await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill('admin123456');await page.locator('button[type=submit]').click();await page.waitForURL('http://127.0.0.1:5113/');
  const financeJourneys=[];
  const nativeContext=await browser.newContext({storageState:await context.storageState(),javaScriptEnabled:false,viewport:{width:390,height:844}});
  const financePage=await nativeContext.newPage();
  for(const theme of ['light','dark'])for(const width of [390,1920]){
   await financePage.setViewportSize({width,height:844});await financePage.goto('http://127.0.0.1:5113/theme/'+theme);await financePage.goto('http://127.0.0.1:5113/finance');
   const create=financePage.locator('form[action="/finance/loans"]');const manualInitiallyHidden=!(await create.locator('.finance-manual-fields').isVisible());await create.locator('[name=method]').selectOption('manual');const manualAvailable=await create.locator('.finance-manual-fields').isVisible();await create.locator('[name=method]').selectOption('equal_payment');if(!manualInitiallyHidden||!manualAvailable)throw Error('特殊银行计划应仅在所选方式下显示');await create.locator('[name=name]').fill('浏览器车贷 '+theme+' '+width);await create.locator('[name=original_principal]').fill('1000');await create.locator('[name=remaining_principal]').fill('1000');await create.locator('[name=term_n]').fill('2');await create.locator('[name=annual_rate]').fill('0');await create.locator('[name=method]').selectOption('equal_principal');await create.locator('button[type=submit],button').last().click();await financePage.waitForURL(/\/finance\/loans\/\d+$/);const loanPath=new URL(financePage.url()).pathname;await financePage.goto('http://127.0.0.1:5113/transactions/new?type=repayment&target=loan:'+loanPath.split('/').at(-1));
   const pay=financePage.locator('form[action="'+loanPath+'/payments"]');await pay.locator('[name=account_id]').selectOption({index:1});await pay.getByText('调整实际金额、期次及银行费用',{exact:true}).click();await pay.locator('[name=principal]').fill('100');await financePage.locator('.entry-actionbar button[type=submit]').click();await financePage.waitForURL(/\/finance\/payments\/\d+$/);const paymentPath=new URL(financePage.url()).pathname;
   await financePage.locator('form[action="'+paymentPath+'/reverse"] button').click();await financePage.waitForURL('http://127.0.0.1:5113'+paymentPath);const reversed=await financePage.locator('.card-head .chip').first().textContent()==='已撤销';await financePage.locator('form[action="'+paymentPath+'/restore"] button').click();await financePage.waitForURL('http://127.0.0.1:5113'+paymentPath);const restored=await financePage.locator('.card-head .chip').first().textContent()==='已记录';
   await financePage.goto('http://127.0.0.1:5113'+loanPath);await financePage.getByText('调整后续还款计划',{exact:true}).click();const replan=financePage.locator('form[action="'+loanPath+'/plan/preview"]');await replan.locator('[name=term_n]').fill('3');await replan.getByRole('button',{name:'预览新计划'}).click();await financePage.getByRole('button',{name:'确认应用此计划'}).click();await financePage.waitForURL('http://127.0.0.1:5113'+loanPath);
   await financePage.screenshot({path:root+'/.screenshots/finance-'+theme+'-'+width+'-loan.png',fullPage:true,animations:'disabled'});
   const archived=financePage.locator('form[action="'+loanPath+'/delete"]');await financePage.getByText('合同信息与提醒',{exact:true}).click();await archived.locator('button').click();await financePage.waitForURL('http://127.0.0.1:5113/finance');await financePage.goto('http://127.0.0.1:5113'+loanPath);await financePage.getByRole('button',{name:'恢复合同'}).click();await financePage.waitForURL('http://127.0.0.1:5113'+loanPath);
   await financePage.goto('http://127.0.0.1:5113/finance/cards/'+financeIds.card);const cardPay=financePage.locator('form[action="/finance/cards/'+financeIds.card+'/payments"]');await cardPay.locator('[name=account_id]').selectOption({index:1});await cardPay.locator('[name=amount]').fill('1');await cardPay.getByRole('button',{name:'确认实际付款',exact:true}).click();await financePage.waitForURL(/\/finance\/payments\/\d+$/);const cardPayment=new URL(financePage.url()).pathname;const alloc=financePage.locator('form[action="'+cardPayment+'/allocate"]').first();await financePage.getByText('高级：手动指定账单',{exact:true}).click();const allocationVisible=await alloc.isVisible();await alloc.getByRole('button',{name:'保存分配'}).click();await financePage.waitForURL('http://127.0.0.1:5113'+cardPayment);
   await financePage.getByText('高级：手动指定账单',{exact:true}).click();await financePage.getByRole('button',{name:'恢复自动对应账单',exact:true}).click();await financePage.waitForURL('http://127.0.0.1:5113'+cardPayment);if(!(await financePage.getByText('自动对应账单',{exact:true}).isVisible()))throw Error('恢复自动对应失败');
   const fields=await financePage.locator('input:not([type=hidden])').count();financeJourneys.push({theme,width,reversed,restored,allocationVisible,fields,native:true,overflow:await financePage.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
   await financePage.goto('http://127.0.0.1:5113/finance/cards/'+financeIds.card);await financePage.screenshot({path:root+'/.screenshots/finance-'+theme+'-'+width+'-card.png',fullPage:true,animations:'disabled'});
  }
  await nativeContext.close();
  const results=[];fs.mkdirSync(root+'/.screenshots/audit-after',{recursive:true});
  for(const theme of ['light','dark']){
   await page.goto('http://127.0.0.1:5113/theme/'+theme);
   for(const width of [390,820,1280,1920,2560]){
    await page.setViewportSize({width,height:1080});
    for(const route of routes){
     const res=await page.goto('http://127.0.0.1:5113'+route);await page.waitForTimeout(40);
     const metrics=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,layoutViewport:document.body.getBoundingClientRect().width,contentWidth:document.querySelector('.content')?.getBoundingClientRect().width,offenders:[...document.querySelectorAll('main *, .content *')].filter(x=>{const r=x.getBoundingClientRect();return r.width&&r.right>innerWidth+2&&!x.closest('.scroll-x,.hl-select-menu,.hl-date-panel');}).slice(0,5).map(x=>x.tagName+'.'+x.className)}));
     if(route==='/'){
      // The content scrolls with the document; navigation and popup menus have
      // their own bounded interaction and are outside this page-body audit.
      const layout=await page.evaluate(()=>{const cols=[...document.querySelectorAll('.dashboard-column')];return {columns:cols.length,gaps:cols.flatMap(col=>[...col.children].slice(1).map((card,i)=>Math.round(card.getBoundingClientRect().top-col.children[i].getBoundingClientRect().bottom)))};});
      metrics.dashboardColumns=layout.columns;metrics.columnGaps=layout.gaps;
     }
     if(route==='/transactions')metrics.listWidth=await page.locator('.transactions-primary').evaluate(el=>el.getBoundingClientRect().width);
     metrics.controlFontMismatches=await page.evaluate(()=>{const font=getComputedStyle(document.body).fontFamily;return [...document.querySelectorAll('button,input,select,textarea')].filter(el=>el.getClientRects().length&&!el.closest('.mono')&&getComputedStyle(el).fontFamily!==font).map(el=>el.tagName+'.'+el.className);});
     metrics.contentScrollers=await page.evaluate(findContentScrollers);
     if(/^\/finance\/(loans|cards|statements|payments)\/\d+$/.test(route)||/^\/(debts|accounts)\/\d+$/.test(route)||route.startsWith('/transactions/new'))metrics.hasReturn=await page.locator('.detail-navigation a').count()===1;
     if(['/accounts','/debts','/finance'].includes(route)){
      metrics.actionAlignment=await page.locator('.debt-entry > .entry-actions,.account-entry > .entry-actions').evaluateAll(groups=>groups.every(g=>{const r=g.getBoundingClientRect();return [...g.querySelectorAll('.btn')].every(b=>{const q=b.getBoundingClientRect();return q.left>=r.left-1&&q.right<=r.right+1;});}));
      metrics.commonWidth=await page.locator('.page-body').evaluate(el=>Math.round(el.getBoundingClientRect().width));
     }
     if(route==='/finance')metrics.createAligned=await page.locator('.finance-create').evaluate(el=>{const r=el.getBoundingClientRect(),g=el.closest('.finance-register').getBoundingClientRect();return Math.abs(r.left-g.left)<1&&Math.abs(r.right-g.right)<1;});

     if(route==='/categories')metrics.flatCategories=await page.locator('.category-navigation').evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display==='grid'&&s.position==='static'&&s.maxHeight==='none'&&[...el.querySelectorAll('a')].every(a=>{const b=a.getBoundingClientRect();return b.top>=r.top&&b.bottom<=r.bottom+1;});});
     if(width>=1280){
      metrics.pageWidth=await page.locator('.page-body').evaluateAll(nodes=>nodes[0]?.getBoundingClientRect().width||0);
      metrics.cards=await page.locator('.card').evaluateAll(nodes=>nodes.filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();const children=[...el.children].filter(c=>c.getClientRects().length);const end=Math.max(r.top,...children.map(c=>c.getBoundingClientRect().bottom));return {title:el.querySelector('h2')?.textContent,width:Math.round(r.width),height:Math.round(r.height),slack:Math.round(r.bottom-end-parseFloat(getComputedStyle(el).paddingBottom))};}));
     }
     if(width===1920){
      await page.waitForTimeout(230);const slug=route==='/'?'home':route.replaceAll('/','-').slice(1).replace(/[^a-zA-Z0-9_-]/g,'-');
      await page.screenshot({path:root+`/.screenshots/audit-after/${theme}-${slug}.png`});
      await page.screenshot({path:root+`/.screenshots/audit-after/${theme}-${slug}-full.png`,fullPage:true,animations:'disabled'});
     }
     results.push({theme,width,route,status:res.status(),...metrics});
     if(route==='/'&&[390,1920,2560].includes(width)||route==='/transactions/new'&&width===1920) await page.waitForTimeout(260);
     if(route==='/'&&[390,1920,2560].includes(width)||route==='/transactions/new'&&width===1920) await page.screenshot({path:root+`/.screenshots/${theme}-${width}-${route==='/'?'dashboard':'form'}.png`,fullPage:true,animations:'disabled'});
     if(route==='/transactions'&&width===1920){await page.waitForTimeout(240);await page.screenshot({path:root+`/.screenshots/${theme}-transactions.png`,fullPage:true,animations:'disabled'});}
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
     const cardLimit=tab==='admin'?await page.locator('.page-body').evaluate(el=>el.getBoundingClientRect().width+1):tab==='ai'||tab==='site'?841:tab==='api'?1081:961;
     variants.push({theme,state:'settings-'+tab,width,visible,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),cardsFit:cards.every(w=>w<=cardLimit),contentScrollers:await page.evaluate(findContentScrollers)});
     if(width===1920)await page.screenshot({path:root+`/.screenshots/audit-after/${theme}-settings-${tab}.png`,fullPage:true,animations:'disabled'});
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
  const mobileOrder=await page.locator('.dashboard-column').evaluate(el=>{const heads=[...el.children].slice(0,3).map(c=>c.querySelector('h2')?.textContent);return /趋势$/.test(heads[0])&&heads.slice(1).join(',')==='今日速览,最近记录';});
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
  await page.screenshot({path:root+'/.screenshots/minimal-390.png',fullPage:true,animations:'disabled'});
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
  let editor=page.locator('.category-entry').first();await editor.locator(':scope > summary').click();await page.locator('.category-modal [name=name]').fill('浏览器恢复分类');
  await Promise.all([page.waitForNavigation(),page.locator('.category-modal .category-edit-form button[type=submit]').click()]);
  editor=page.locator('.category-entry').filter({has:page.locator('summary',{hasText:'浏览器恢复分类'})}).first();await editor.locator(':scope > summary').click();await page.locator('.category-modal .category-delete').click();
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
  const categoryParentChecks=await require('./ui-category-parent-checks.cjs')(browser,context,'http://127.0.0.1:5113');
  const categoryParentChanged=categoryParentChecks.every(check=>check.changed&&check.returned&&!check.overflow);
  const categoryIconChecks=await require('./ui-category-icon-checks.cjs')(browser,context,'http://127.0.0.1:5113');
  const categoryIcons=categoryIconChecks.every(check=>check.pass);
  const categorySortChecks=await require('./ui-category-sort-checks.cjs')(browser,context,'http://127.0.0.1:5113');
  const categorySorting=categorySortChecks.every(check=>check.pass);
  const transactionTimeChecks=await require('./ui-transaction-time-checks.cjs')(browser,context,'http://127.0.0.1:5113');
  const transactionTimes=transactionTimeChecks.every(check=>check.pass);
  const borrowingTimeChecks=await require('./ui-borrowing-time-checks.cjs')(browser,context,'http://127.0.0.1:5113');
  const borrowingTimes=borrowingTimeChecks.every(check=>check.pass);
  const preservedCategories=[];
  for(const checkPage of [noJsPage,page])for(const row of financeIds.categoryEdits){
    await checkPage.goto('http://127.0.0.1:5113/transactions/'+row.id+'/edit');
    let preserved=await checkPage.locator('#txn-form').evaluate((el,id)=>new FormData(el).get('category_id')===String(id),row.category_id);
    if(checkPage===page){const type=await page.locator('#f-type').inputValue();await page.locator('[data-type='+type+']').first().click();preserved=preserved&&await page.locator('#txn-form').evaluate((el,id)=>new FormData(el).get('category_id')===String(id),row.category_id);}
    preservedCategories.push(preserved);
  }
  const categoryEditPreserved=preservedCategories.length===6&&preservedCategories.every(Boolean);
  const returnNavigation=results.every(r=>r.hasReturn!==false);
  const financeLayout=results.filter(r=>r.commonWidth).every(r=>r.actionAlignment!==false&&r.createAligned!==false)&&[390,820,1280,1920,2560].every(w=>{const rows=results.filter(r=>r.commonWidth&&r.width===w);return rows.every(r=>Math.abs(r.commonWidth-rows[0].commonWidth)<=1);});
  const naturalCards=results.filter(r=>r.cards).every(r=>r.cards.every(c=>c.slack<=80))&&results.every(r=>r.contentScrollers.length===0&&r.flatCategories!==false)&&variants.every(r=>r.contentScrollers.length===0);
  const boundedPages=results.filter(r=>r.width>=1920&&['/about','/tags','/notifications'].includes(r.route.split('?')[0])).every(r=>r.pageWidth<=1041);
  const variantLayouts=variants.every(v=>!v.overflow&&v.visible!==false&&v.cardsFit!==false);
  const reportChecks=[];
  for(const theme of ['light','dark'])for(const width of [390,820,1280,1920,2560]){
    await page.setViewportSize({width,height:1080});await page.goto('http://127.0.0.1:5113/theme/'+theme);
    const snapshots=[];
    for(const basis of ['cashflow','consumption']){
      await page.goto('http://127.0.0.1:5113/reports?basis='+basis+'&preset=custom&from=2020-02-02&to=2020-02-20&kind=income');
      snapshots.push(await page.locator('.report-toolbar').evaluate(el=>({controls:[...el.querySelectorAll('a,input,button')].map(c=>{const s=getComputedStyle(c);return [c.tagName,c.type,s.fontFamily,s.fontSize,s.padding,s.borderRadius,s.minHeight];}),head:Math.round(el.querySelector('.report-toolbar-head').getBoundingClientRect().height)})));
      const target=await page.locator('.report-toolbar [aria-label="统计口径"] a').filter({hasText:basis==='cashflow'?'消费收支':'资金流'}).getAttribute('href');
      reportChecks.push({theme,width,basis,preserves:target.includes('from=2020-02-02')&&target.includes('to=2020-02-20')&&target.includes('kind=income')});
      if([390,1920].includes(width))await page.screenshot({path:root+'/.screenshots/unified-'+theme+'-'+width+'-'+basis+'.png',fullPage:true,animations:'disabled'});
    }
    reportChecks.push({theme,width,same:JSON.stringify(snapshots[0])===JSON.stringify(snapshots[1])});
  }
  const reportToolbarConsistent=reportChecks.every(x=>x.same!==false&&x.preserves!==false);
  await page.setViewportSize({width:390,height:844});
  await page.locator('.report-range-form .hl-date-trigger').first().click();
  const reportCalendarGrid=await page.locator('.report-range-form .hl-date-menu button.hl-date-cell').first().evaluate(el=>getComputedStyle(el).gridColumnStart==='auto'&&el.getBoundingClientRect().width<el.parentElement.getBoundingClientRect().width/5);
  await page.keyboard.press('Escape');
  const entryChecks=[];
  for(const theme of ['light','dark'])for(const width of [390,820,1280,1920,2560]){
    await page.setViewportSize({width,height:1080});await page.goto('http://127.0.0.1:5113/theme/'+theme);await page.goto('http://127.0.0.1:5113/transactions/new');
    await page.locator('#f-amount').fill('123.45');
    const bounds=()=>page.locator('.entry-navigation').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top+scrollY,width:r.width};});
    await page.locator('#txn-form [name=txn_date]').evaluate(el=>{el.value='2020-03-15';el.dispatchEvent(new Event('change',{bubbles:true}));});
    const before=await bounds();await page.locator('[data-entry-type=repayment]').click();const after=await bounds();
    const direct=await page.locator('[data-repayment-target]:not(.hidden) .finance-form').isVisible();
    const retained=await page.locator('[data-repayment-target]:not(.hidden) [name=amount]').inputValue()==='123.45';
    const paymentForm=page.locator('[data-repayment-target]:not(.hidden) .finance-form');
    const dateLabel=await paymentForm.locator('[name=date]').evaluate(el=>el.parentElement.querySelector('.hl-date-label')?.textContent===el.value);
    await paymentForm.locator('[name=amount]').fill('500');
    await paymentForm.locator('[name=date]').evaluate(el=>{el.value='2020-04-16';el.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.locator('[data-entry-type=expense]').click();await page.locator('[data-entry-type=repayment]').click();await page.locator('[data-entry-type=repayment]').click();
    const draftRetained=Number(await paymentForm.locator('[name=amount]').inputValue())===500&&await paymentForm.locator('[name=date]').inputValue()==='2020-04-16';
    if(!dateLabel||!draftRetained)throw Error('还款草稿或日期显示被覆盖');
    if([390,1920].includes(width))await page.screenshot({path:root+'/.screenshots/simple-'+theme+'-'+width+'-repayment.png',fullPage:true,animations:'disabled'});
    await page.locator('[data-entry-type=transfer]').click();const transfer=await bounds();
    await page.locator('[data-entry-type=expense]').click();
    entryChecks.push({theme,width,direct,retained,stable:[after,transfer].every(r=>Math.abs(r.left-before.left)<1&&Math.abs(r.width-before.width)<1&&Math.abs(r.top-before.top)<1),amount:await page.locator('#f-amount').inputValue()==='123.45'});
    await page.goto('http://127.0.0.1:5113/');await page.waitForTimeout(300);
    const actions=await page.locator('.dashboard-grid .card-head a').evaluateAll(links=>links.every(a=>a.classList.contains('btn')&&!a.classList.contains('btn-ghost')&&!a.textContent.includes('→')));
    if(!actions)throw Error('同类模块入口仍不一致');
    if([390,1920].includes(width))await page.screenshot({path:root+'/.screenshots/simple-'+theme+'-'+width+'-dashboard.png',fullPage:true,animations:'disabled'});
    await page.goto('http://127.0.0.1:5113/accounts');
    if([390,1920].includes(width))await page.screenshot({path:root+'/.screenshots/simple-'+theme+'-'+width+'-accounts.png',fullPage:true,animations:'disabled'});
  }
  await page.goto('http://127.0.0.1:5113/transactions/new');await page.locator('#f-amount').fill('123.45');
  await page.locator('#f-currency').selectOption('USD',{force:true});await page.locator('[data-entry-type=repayment]').click();
  const foreignAmountNotCopied=await page.locator('[data-repayment-target]:not(.hidden) [name=amount]').inputValue()!=='123.45';
  const entryStable=entryChecks.every(row=>row.direct&&row.retained&&row.stable&&row.amount);
  const controlFontsConsistent=results.every(r=>r.controlFontMismatches.length===0);
  await page.goto('http://127.0.0.1:5113/transactions/new');
  const creditOption=await page.locator('#transaction-account-options').evaluate(el=>[...el.content.querySelectorAll('option')].find(o=>o.dataset.types?.split(',').includes('expense')&&!o.dataset.types.split(',').includes('transfer'))?.value);
  if(!creditOption)throw Error('缺少信用卡测试账户');
  async function chooseEnhanced(select,value) {
    const index=await select.evaluate((el,id)=>[...el.options].findIndex(o=>o.value===id),value);
    const wrapper=select.locator('..');
    await wrapper.locator('.hl-select-trigger').click();
    await wrapper.locator('.hl-select-opt').nth(index).click();
  }
  await chooseEnhanced(page.locator('#f-account'),creditOption);await page.locator('.entry-navigation [data-entry-type=transfer]').click();
  const transferFiltered=await page.locator('#f-account').evaluate((el,id)=>el.value===''&&![...el.options].some(o=>o.value===id),creditOption);
  await page.locator('.entry-navigation [data-entry-type=expense]').click();
  const expenseCardRestored=await page.locator('#f-account').evaluate((el,id)=>el.value===''&&[...el.options].some(o=>o.value===id),creditOption);
  await page.goto('http://127.0.0.1:5113/recurring');await chooseEnhanced(page.locator('#rec-items [name=item_account_id]').first(),creditOption);await chooseEnhanced(page.locator('#rec-items [name=item_type]').first(),'transfer');
  const recurringAccountFiltered=await page.locator('#rec-items [name=item_account_id]').first().evaluate((el,id)=>el.value===''&&![...el.options].some(o=>o.value===id),creditOption);
  const darkAuth=await browser.newContext({colorScheme:'dark',viewport:{width:390,height:844}});const darkLogin=await darkAuth.newPage();
  await darkLogin.goto('http://127.0.0.1:5113/login');
  const darkLoginTheme=await darkLogin.locator('html').getAttribute('data-theme')==='dark';
  await darkLogin.screenshot({path:root+'/.screenshots/audit-after/dark-login.png'});
  await page.goto('http://127.0.0.1:5113/categories');await page.locator('.category-create-disclosure > summary').click();
  const kindTrigger=page.locator('.category-modal .hl-select-trigger').first();await kindTrigger.click();await page.locator('.category-modal .modal-title').click();await kindTrigger.click();
  const selectReopensAfterOutside=await kindTrigger.getAttribute('aria-expanded')==='true';await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  const wideContentFills=results.filter(r=>r.route==='/'&&r.width>=1920).every(r=>Math.abs(r.contentWidth-(r.layoutViewport-240))<=1)&&tabletDrawerLayout&&phoneDrawerLayout;
  const adaptiveChecks=[];for(const theme of ['light','dark']){await page.goto('http://127.0.0.1:5113/theme/'+theme);adaptiveChecks.push(...(await require('./ui-workspace-checks.cjs')(page,'http://127.0.0.1:5113')).map(check=>({...check,theme})));}
  const adaptiveWorkspace=adaptiveChecks.every(check=>check.pass);
  const accountGroupChecks=await require('./ui-account-group-checks.cjs')(page,'http://127.0.0.1:5113');
  const accountGroups=accountGroupChecks.every(check=>check.pass);
  const advanceChecks=await require('./ui-advance-checks.cjs')(browser,context,'http://127.0.0.1:5113');
  const interaction={borrowingTimes,transactionTimes,categorySorting,categoryIcons,categoryParentChanged,categoryEditPreserved,adaptiveWorkspace,foreignAmountNotCopied,entryStable,reportCalendarGrid,reportToolbarConsistent,controlFontsConsistent,transferFiltered,expenseCardRestored,recurringAccountFiltered,returnNavigation,financeLayout,menuClosed,focusReturned,rowFocusReturned,trapped,drawerClosed,resizedDrawerReleased,reduced,minimal,coarseTablet,zoom200,wideContentFills,ledgerMenuFits,dashboardGaps,compactLedger,advancedCollapsed,inlineDetails,inspectorFocusReturned,inspectorResizeReleased,mobileDetails,mobileOrder,inspectorControlsReachable,glassMaterial,categorySoftDeleted,categoryRestored,compactPageSize,categoryKindSync,categoryModalFocusReturned,categoryDropdownEscape,recurringClonedSelect,categoryNoJs,naturalCards,boundedPages,variantLayouts,darkLoginTheme,selectReopensAfterOutside};
  interaction.accountGroups=accountGroups;
  interaction.advances=advanceChecks.every(check=>check.pass);
  const summary={advanceChecks,accountGroupChecks,borrowingTimeChecks,transactionTimeChecks,categorySortChecks,categoryIconChecks,categoryParentChecks,adaptiveChecks,financeJourneys,pages:results.length,failures:results.filter(x=>x.overflow||x.status>=500),errors,interaction,authChecks,variants,results};
  if(financeJourneys.some(j=>!j.reversed||!j.restored||!j.allocationVisible||j.overflow)||summary.failures.length||errors.length||Object.values(interaction).some(v=>!v)||authChecks.some(x=>x.overflow))process.exitCode=1;

  fs.writeFileSync(root+'/.screenshots/qa.json',JSON.stringify(summary,null,2));
  console.log(JSON.stringify({...summary,results:undefined,authChecks:undefined,variants:undefined},null,2));
 }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
