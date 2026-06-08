# 日记本数据迁移工具

**版本**: 1.2.0  
**用途**: 给 `sillytavernDIARY` 做一次性数据迁移。

## 支持的迁移

1. `settings -> 独立文件存储`
   - 把 `extension_settings.sillytavernDIARY` 里的普通日记、交换日记、回收站合并写入 `user/files` 下的三份 JSON 文件。
   - 文件名：`diary-data.json`、`diary-exchange-data.json`、`diary-recycle-bin.json`。
   - 如果目标文件已经存在，会先读取文件里的新数据，再把 settings 里的旧数据补进去。
   - 能识别出来的重复普通日记、回收站条目、交换日记系列会跳过，避免同一份数据重复出现。
   - 三份文件全部写入成功后，会删除 settings 里的普通日记、交换日记、回收站旧数据。
   - 只删除数据仓库，不删除主题、预设、自动日记等其它设置。

2. `世界书 -> settings`
   - 保留旧迁移能力：从世界书“日记本”和“回收站”读取旧数据，合并到 `extension_settings.sillytavernDIARY`。

## 使用方式

1. 安装并启用本工具。
2. 打开 SillyTavern 扩展设置。
3. 在“日记本数据迁移工具”里选择迁移模式。
4. 查看检查结果。
5. 点击“执行迁移”。

迁移不会删除原始世界书数据，也不会清空独立文件中已经存在的新日记。`settings -> 独立文件存储` 成功后，会清理 settings 里的旧数据仓库。确认新日记本插件数据正常后，可以卸载本工具。

## 建议

迁移前先备份 SillyTavern 的 settings 文件。  
如果只是使用 v7.1.0 日记本插件，本体自带 settings 回退；但只要 `user/files` 里的独立文件已经存在，本体就会优先读取独立文件。为了避免旧 settings 数据被独立文件“遮住”，从旧版本升级后建议运行本工具的 `settings -> 独立文件存储`。
