'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const kinds = { webhook: '通用 Webhook', serverchan: 'Server 酱', bark: 'Bark' };
const defaults = { title: '{{title}}', content: '{{content}}' };
const blockedHeaders = /^(host|connection|proxy-.*|content-length|transfer-encoding|upgrade|expect|te|trailer|keep-alive|cookie)$/i;
const variable = /\{\{\s*(title|content|event_type|amount|date|url)\s*\}\}/g;

function storageKey(create) {
  const env = process.env.HOMELEDGER_PUSH_KEY;
  if (env) {
    if (!/^[a-f\d]{64}$/i.test(env)) throw Error('HOMELEDGER_PUSH_KEY 必须为 64 位十六进制密钥');
    return Buffer.from(env, 'hex');
  }
  const file = path.join(require('../db').DATA_DIR, '.notification-key');
  if (create) {
    try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw Error('无法保存推送加密密钥'); }
  }
  let key;
  try { key = fs.readFileSync(file); }
  catch { throw Error('缺少推送加密密钥，请恢复 .notification-key 或原部署密钥'); }
  if (key.length !== 32) throw Error('推送加密密钥无效');
  return key;
}

function encrypt(config) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', storageKey(true), iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(config)), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

function decrypt(encrypted) {
  const raw = Buffer.from(encrypted, 'base64');
  const key = storageKey(false);
  try {
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    cipher.setAuthTag(raw.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(raw.subarray(12, -16)), cipher.final()]).toString());
  } catch {
    throw Error('无法解密推送渠道，请核对部署密钥');
  }
}

function endpoint(input) {
  let url;
  try { url = new URL(input); }
  catch { throw Error('请填写有效的 HTTP 或 HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw Error('推送地址只支持 HTTP/HTTPS，请将凭据放在专用输入项');
  return url;
}

const render = (value, values) => String(value ?? '').replace(variable, (_, name) => values[name] ?? '');
function renderJson(value, values) {
  if (Array.isArray(value)) return value.map(item => renderJson(item, values));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderJson(item, values)]));
  return typeof value === 'string' ? render(value, values) : value;
}

function append(base, fragment) {
  const url = endpoint(base);
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + fragment;
  return url;
}

function form(value) {
  return new URLSearchParams(Object.entries(value || {}).map(([key, data]) => [key, String(data ?? '')])).toString();
}

function serverChanKeyInUrl(input) {
  return input && !input.includes('{key}')
    ? /\/([a-z\d_-]{1,200})\.send$/i.exec(endpoint(input).pathname)?.[1] || null : null;
}

function serverChanUrl(config) {
  if (serverChanKeyInUrl(config.url)) return endpoint(config.url);
  if (!/^[a-z\d_-]{1,200}$/i.test(config.key || '')) throw Error('请填写 SendKey 或包含 SendKey 的完整 .send 地址');
  const modern = /^sctp(\d+)t/i.exec(config.key);
  const base = config.url || (modern ? `https://${modern[1]}.push.ft07.com/send` : 'https://sctapi.ftqq.com');
  if (base.includes('{key}')) return endpoint(base.replaceAll('{key}', encodeURIComponent(config.key)));
  return append(base, `${config.key}.send`);
}

const adapters = {
  webhook(config, values) {
    const url = endpoint(config.url);
    const headers = {};
    for (const [name, value] of Object.entries(config.headers || {})) {
      try {
        if (blockedHeaders.test(name)) throw Error();
        http.validateHeaderName(name);
        const rendered = render(value, values);
        http.validateHeaderValue(name, rendered);
        headers[name.toLowerCase()] = rendered;
      } catch { throw Error('Webhook 请求头格式不正确或使用了保留字段'); }
    }
    const query = renderJson(config.query ?? (config.method === 'GET' ? defaults : {}), values);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value ?? ''));
    if (config.method === 'GET') return { url, method: 'GET', headers };
    const fields = renderJson(config.body ?? defaults, values);
    headers['content-type'] = config.bodyFormat === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
    const body = config.bodyFormat === 'form' ? form(fields) : JSON.stringify(fields);
    return { url, method: 'POST', headers, body };
  },
  serverchan(config, values) {
    const url = serverChanUrl(config);
    const options = renderJson(config.options || {}, values);
    const body = form({ ...options, title: values.title.replace(/[\r\n]+/g, ' ').slice(0, 128), desp: values.content });
    return { url, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body };
  },
  bark(config, values) {
    if (!(config.key || '').trim()) throw Error('请填写 Bark 设备 Key');
    const base = endpoint(config.url || 'https://api.day.app');
    const url = base.pathname.endsWith('/push') ? base : append(base, 'push');
    const options = renderJson(config.options || {}, values);
    const body = JSON.stringify({ ...options, device_key: config.key, title: values.title, body: values.content });
    return { url, method: 'POST', headers: { 'content-type': 'application/json' }, body };
  },
};

function buildRequest(type, config, vars) {
  if (!Object.hasOwn(adapters, type)) throw Error('推送渠道类型无效');
  const values = { title: '', content: '', ...vars };
  const title = render(config.titleTemplate || '{{title}}', values).slice(0, 256);
  const content = render(config.contentTemplate || '{{content}}', values).slice(0, 4096);
  return adapters[type](config, { ...values, title, content });
}

const privateV4 = new net.BlockList();
for (const [subnet, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]])
  privateV4.addSubnet(subnet, bits, 'ipv4');
const restrictedV4 = new net.BlockList();
for (const [subnet, bits] of [
  ['0.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) restrictedV4.addSubnet(subnet, bits, 'ipv4');
const publicV6 = new net.BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
const restrictedV6 = new net.BlockList();
for (const [subnet, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]])
  restrictedV6.addSubnet(subnet, bits, 'ipv6');
const privateV6 = new net.BlockList();
privateV6.addSubnet('fc00::', 7, 'ipv6');
const proxyDns = new net.BlockList();
proxyDns.addSubnet('198.18.0.0', 15, 'ipv4');
proxyDns.addSubnet('2001:2::', 48, 'ipv6');

function allowedAddress(address, lan) {
  const family = net.isIP(address);
  if (family === 4) return !restrictedV4.check(address, 'ipv4') && (lan || !privateV4.check(address, 'ipv4'));
  if (family === 6) return (publicV6.check(address, 'ipv6') && !restrictedV6.check(address, 'ipv6'))
    || (lan && privateV6.check(address, 'ipv6'));
  return false;
}

function isProxyDns(address) {
  const family = net.isIP(address);
  return !!family && proxyDns.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function officialEndpoint(type, url) {
  if (url.protocol !== 'https:' || url.port) return false;
  if (type === 'bark') return url.hostname === 'api.day.app';
  return type === 'serverchan' &&
    (url.hostname === 'sctapi.ftqq.com' || /^\d+\.push\.ft07\.com$/.test(url.hostname));
}

function allowedDestination(type, url, address, lan = false) {
  return allowedAddress(address, lan) || (officialEndpoint(type, url) && isProxyDns(address));
}

function failure(message, retry = false, unknown = false) {
  return { status: unknown ? 'unknown' : 'failed', message, retry };
}

async function send(type, config, values, timeoutMs, currentValues = () => values) {
  const planned = buildRequest(type, config, values);
  const targetUrl = planned.url;
  const host = targetUrl.hostname.replace(/^\[|\]$/g, '');
  const lan = String(process.env.HOMELEDGER_PUSH_LAN_TARGETS || '').split(',').map(x => x.trim()).includes(targetUrl.origin);
  const deadline = AbortSignal.timeout(timeoutMs);
  let abortLookup;
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((resolve, reject) => {
        abortLookup = () => reject(Error('DNS 超时'));
        deadline.addEventListener('abort', abortLookup, { once: true });
      }),
    ]);
  } catch {
    return failure(deadline.aborted ? 'DNS 查询超时' : '域名无法解析', true);
  } finally {
    if (abortLookup) deadline.removeEventListener('abort', abortLookup);
  }
  if (addresses.some(item => isProxyDns(item.address)) && !officialEndpoint(type, targetUrl))
    return failure('自定义推送地址被代理 DNS 解析为虚拟 IP，请让该域名返回真实 IP');
  if (!addresses.length || addresses.some(item => !allowedDestination(type, targetUrl, item.address, lan)))
    return failure('目标地址不允许访问，请检查局域网白名单');
  const pinned = addresses.find(item => item.family === 4 && isProxyDns(item.address)) || addresses[0];
  const latest = currentValues();
  if (!latest) return { status: 'skipped', message: '渠道、权限或提醒已变更' };
  const request = latest === values ? planned : buildRequest(type, config, latest);
  const url = request.url;
  if (url.origin !== targetUrl.origin) return failure('推送目标在构建请求时发生变更');
  return new Promise(resolve => {
    let sent = false;
    let completed = false;
    const done = (result) => { if (!completed) { completed = true; resolve(result); } };
    const transport = url.protocol === 'https:' ? https : http;
    const headers = { ...request.headers };
    if (request.body !== undefined) headers['content-length'] = Buffer.byteLength(request.body);
    const req = transport.request(url, {
      method: request.method, headers, agent: false, autoSelectFamily: false, signal: deadline, rejectUnauthorized: true,
      lookup: (hostname, options, callback) => callback(null, pinned.address, pinned.family),
    }, res => {
      const status = res.statusCode;
      if (status < 200 || status >= 300) {
        const delay = res.headers['retry-after'];
        const retryAfter = /^\d+$/.test(delay || '') ? Number(delay) * 1000 : Date.parse(delay) - Date.now();
        done({ ...failure(status >= 300 && status < 400 ? '服务返回重定向' : `服务返回 HTTP ${status}`,
          status === 408 || status === 429 || status >= 500), retryAfter: Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 0 });
        res.destroy();
        return;
      }
      if (type === 'webhook') {
        done({ status: 'sent' });
        res.destroy();
        return;
      }
      const chunks = [];
      let length = 0;
      res.on('data', part => {
        length += part.length;
        if (length > 16384) { done(failure('服务响应过长，无法确认结果', false, true)); res.destroy(); }
        else chunks.push(part);
      });
      res.on('error', () => done(failure('服务响应中断，送达结果未知', false, true)));
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          const ok = result?.code === (type === 'bark' ? 200 : 0);
          done(ok ? { status: 'sent' } : failure('服务拒绝消息，请检查设备 Key、服务地址或发送额度'));
        } catch { done(failure('服务响应无法识别，送达结果未知', false, true)); }
      });
    });
    req.on('finish', () => { sent = true; });
    req.on('error', error => {
      const refused = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code);
      const unknown = sent && !refused;
      done(failure(unknown ? '服务未响应，送达结果未知' : deadline.aborted ? '连接超时' : '无法连接目标服务，请检查地址、证书与网络',
        refused || (!sent && deadline.aborted), unknown));
    });
    req.end(request.body);
  });
}

module.exports = { kinds, encrypt, decrypt, buildRequest, send, allowedAddress, allowedDestination, serverChanKeyInUrl };
