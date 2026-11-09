'use strict';
const path=require('node:path');
const assert=require('node:assert/strict');
if(!process.env.DATA_DIR || path.basename(path.resolve(process.env.DATA_DIR))!=='category-legacy-restore')throw new Error('旧库迁移测试必须使用独立 category-legacy-restore 目录');
const db=require('../../src/db');
db.init();
const category=db.get('SELECT id FROM categories WHERE parent_id IS NULL ORDER BY id');
assert.ok(category);
db.run('UPDATE categories SET name=? WHERE id=?','旧库保留分类',category.id);
// Only this process opens this fixture. A real replacement/reopen must not run
// against a database concurrently held by the HTTP regression server.
db.db.exec('DROP TABLE category_copies; ALTER TABLE categories DROP COLUMN deleted_at;');
assert.ok(!db.tableColumns('categories').includes('deleted_at'));
assert.equal(db.get("SELECT name FROM sqlite_master WHERE name='category_copies'"),undefined);
db.reopenDatabase();
assert.ok(db.tableColumns('categories').includes('deleted_at'));
assert.ok(db.get("SELECT name FROM sqlite_master WHERE name='category_copies'"));
assert.equal(db.get('SELECT name FROM categories WHERE id=?',category.id).name,'旧库保留分类');
console.log('legacy-category-restore-ok');
