# 分类迁移测试在 Linux 上丢失表结构

GHCR测试在分类套件报SQL logic error，Windows的Node24、22.22.2和与CI相同的22.23.4均通过。增加失败完整输出后，Linux Node22/24均确认前58项通过，最后`reopenDatabase()`在`ensureColumn()`报`no such table: categories`。

## 根因

测试与8099服务器同时连接一个WAL数据库。旧测试删除分类映射表/字段，再重开数据库模拟旧备份迁移；重开函数只关闭测试连接，却无条件删除`-wal/-shm`。Linux允许删除其他进程仍打开的文件，Windows通常因文件锁而删除失败，因此本地通过掩盖问题。尚未checkpoint的表结构仍在WAL，Linux重开时看不到categories。

[SQLite官方说明](https://sqlite.org/wal.html#the_wal_file)：WAL是持久状态的一部分，最后连接关闭时才正常checkpoint和清理；不能分离仍含已提交事务的WAL与主文件。

## 修复与范围

- 旧库检查移入`test/fixtures/category-legacy-restore.cjs`，独占新目录/子进程；先确认旧结构缺少表/字段，再真实重开，验证补齐及旧分类名称保留。分类套件仍59项，业务覆盖不删减。
- `run-all.js`失败时输出完整日志和退出码；新增仅PR或手动执行的Linux Node22/24检查，没有镜像发布步骤。
- Windows Node22.23.4全量21套1092断言通过；Linux Node22/24均21套1092断言和静态自检通过：[CI记录](https://github.com/Fre0ddy1/homeledger/actions/runs/42653277654)。

本次修复测试隔离，没有修改生产备份核心。既有`reopenDatabase()`活跃WAL清理边界、重开后`module.exports.db`仍导出旧对象及admin提前解构连接问题，已登记BOARD；后续统一生命周期并覆盖连续恢复、导出、退出、额外连接及失败回滚后，再调整生产恢复。

隔离数据目录不等于独占数据库；重开/替换/WAL清理必须确认所有连接的所有权。
