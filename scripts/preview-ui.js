'use strict';
// A disposable local demo: never opens the user's data/homeledger.db.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.env.DATA_DIR = path.join(root, '.tmp', 'data-ui-preview');
process.env.PORT = process.env.PREVIEW_PORT || '5112';
process.env.HOST = '127.0.0.1';
process.env.NODE_ENV = 'development';
for (const script of ['scripts/seed-demo.js', 'test/fixtures/ui-preview.cjs']) {
  execFileSync(process.execPath, [path.join(root, script)], { cwd: root, env: process.env, stdio: 'inherit' });
}
console.log(`\nUI 演示预览：http://localhost:${process.env.PORT}（admin / admin123456）`);
console.log('此实例使用独立演示数据；常规本地开发请运行 npm run dev。\n');
require('../server');
