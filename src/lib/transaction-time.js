"use strict";

function normalizeDate(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const s=String(value).trim(),m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw Error('交易日期须为YYYY-MM-DD');
  const y=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  const d=new Date(0);d.setUTCHours(0,0,0,0);d.setUTCFullYear(y,month-1,day);
  if (y<1 || d.getUTCFullYear()!==y || d.getUTCMonth()!==month-1 || d.getUTCDate()!==day) throw Error('交易日期无效');
  return s;
}
function normalizeTime(value, fallback=null) {
  if (value===undefined) return fallback;
  if (value===null || value==='') return null;
  const m=/^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (!m || Number(m[1])>23 || Number(m[2])>59 || Number(m[3]||0)>59) throw Error('交易时刻须为有效的HH:mm或HH:mm:ss');
  return m[1]+':'+m[2]+':'+(m[3]||'00');
}
function formatTime(value) { return value ? (value.endsWith(':00')?value.slice(0,5):value) : ''; }
function clockNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  if (value.includes('十')) {const [a,b]=value.split('十');return (a?digits[a]:1)*10+(b?digits[b]:0);}
  return digits[value];
}
function extractTimes(text) {
  const s=String(text||'');
  const pattern=/(凌晨|早上|上午|中午|下午|傍晚|晚上|晚间)?\s*(?:(\d{1,2})[：:](\d{2})(?:[：:](\d{2}))?|([零〇一二两三四五六七八九十\d]{1,3})[点时](?:([零〇一二两三四五六七八九十\d]{1,3})分?|(半))?(?:([零〇一二两三四五六七八九十\d]{1,3})秒)?)/g;
  const times=[];
  for (const m of s.matchAll(pattern)) {
    const rawBefore=s.slice(0,m.index),before=rawBefore.trimEnd(),after=s.slice(m.index+m[0].length).replace(/^(?:钟|整)/,'');
    // Keep the surrounding text: cutting out a token would lose the 元/点券/模糊时刻 boundary.
    if (!m[1] && !/^\s/.test(m[0]) && /[0-9零〇一二两三四五六七八九十]$/.test(rawBefore)) continue;
    if (/(?:大约|大概|差不多|将近|约)$/.test(before)) continue;
    if (/^(?:[0-9零〇一二两三四五六七八九十]|元|块|券|心|赞|播|球|评|子|多|左右|上下|前|后|许|刻)/.test(after)) continue;
    let hour=m[2]!==undefined?Number(m[2]):clockNumber(m[5]);
    const minute=m[3]!==undefined?Number(m[3]):(m[7]?30:(m[6]?clockNumber(m[6]):0));
    const second=m[4]!==undefined?Number(m[4]):(m[8]?clockNumber(m[8]):0);
    if (['晚上','晚间'].includes(m[1]) && hour===12) continue; // Ambiguous date boundary: do not guess noon or next day.
    if (['下午','傍晚','晚上','晚间'].includes(m[1]) && hour<12) hour+=12;
    if (m[1]==='中午' && hour>=1 && hour<11) hour+=12;
    if (m[1]==='凌晨' && hour===12) hour=0;
    const ampm=after.match(/^\s*(am|pm)\b/i);
    if(ampm&&hour>=1&&hour<=12)hour=hour%12+(ampm[1].toLowerCase()==='pm'?12:0);
    try {const value=normalizeTime(String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0')+':'+String(second).padStart(2,'0'));if(!times.includes(value))times.push(value);}catch { /* Invalid source clock is not a fact. */ }
  }
  return times;
}
function extractTime(text) { return extractTimes(text)[0]||null; }
module.exports={normalizeDate,normalizeTime,formatTime,extractTime,extractTimes};
