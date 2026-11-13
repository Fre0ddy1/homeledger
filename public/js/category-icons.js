/* Category icon search extends the existing value/preview controls. */
(function(){
  'use strict';
  function init(){
    document.querySelectorAll('.category-icon-picker').forEach(picker=>{
      const search=picker.querySelector('[data-icon-search]');
      const select=picker.querySelector('[data-icon-group-filter]');
      if(!search||!select||picker.dataset.iconSearchReady)return;
      picker.dataset.iconSearchReady='true';
      const common=picker.querySelector('[data-icon-common-grid]');
      const sections=Array.from(picker.querySelectorAll('[data-icon-group]'));
      const status=picker.querySelector('[data-icon-status]');
      const empty=picker.querySelector('[data-icon-empty]');
      function filter(){
        const words=search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        common.hidden=words.length>0;
        let matches=0;
        sections.forEach(section=>{
          const groupMatches=words.length>0||!select.value||section.dataset.iconGroup===select.value;
          let count=0;
          section.querySelectorAll('[data-icon-choice]').forEach(button=>{
            const text=button.dataset.iconSearchText.toLocaleLowerCase();
            const show=groupMatches&&(words.length?words.every(word=>text.includes(word)):button.dataset.iconCommon!=='true');
            button.hidden=!show;
            if(show)count++;
          });
          section.hidden=count===0;
          matches+=count;
        });
        status.textContent=words.length?'找到 '+matches+' 个图标':(select.selectedOptions[0]?.textContent||'全部场景')+' · '+matches+' 个';
        empty.hidden=matches>0;
      }
      search.addEventListener('input',filter);
      search.addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});
      select.addEventListener('change',filter);
      picker.closest('form').addEventListener('reset',()=>queueMicrotask(()=>{
        select._hlRefresh?.();
        filter();
      }));
      filter();
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();
})();
