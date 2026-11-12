# 产品目录与商机产品明细（产品与报价 第 1 步）— 三轮测试记录

日期：2026-11-12　环境：同 [leads.md](leads.md)　参考：Zoho CRM Products / Deal 关联产品
迁移：`20261112112843_products`（products、deal_line_items 表；组织内 SKU 唯一；复合外键保证明细、商机、产品同组织；单价非负、SKU 非空、数量 > 0、折扣 0–100、小计非负的 CHECK；产品被使用时 RESTRICT）

## 功能
- 左侧导航新增“产品”：产品目录列表（启用 / 已停用 / 全部筛选，按 SKU、名称、分类搜索，显示使用次数）。
- 管理员与销售经理（新权限 `product.manage`）可新增、编辑、停用/启用、删除产品；SKU 保存时自动转大写，组织内唯一（不区分大小写）；被商机使用的产品不能删除，只能停用。销售代表与只读用户只能查看。
- 商机详情新增“产品明细”页签：选择与商机币种相同的启用产品，填写数量、单价（默认产品价，可改）、折扣 %；小计 = 数量 × 单价 × (100 − 折扣) / 100，四舍五入到分；明细保存产品名称与 SKU 快照，之后修改产品不影响已有明细。
- 商机金额 = 明细合计，增删改明细后自动更新并写审计（deal.update，来源 deal.items）；有明细时商机金额与币种锁定（界面禁用，接口 409）；明细清空后恢复手工填写。
- 明细权限与商机编辑权限一致（销售代表只能改自己的商机，只读只看）；商机删除时明细级联删除。
- 审计：product.create / update / delete，deal.add_item / update_item / remove_item；产品描述脱敏。
- 演示数据：24 个虚构产品（12 个 USD 的 `DT-` 系列及对应 CNY 版本），27 个商机共 55 条明细，商机金额与明细合计一致。

## 第一轮：功能测试
命令：`npx vitest run tests/products/products.r1-functional.test.ts --reporter=verbose`
结果：**10/10 通过**。原始输出：[results/products-r1-functional.txt](results/products-r1-functional.txt)
覆盖：SKU 规范化与默认值；搜索与筛选；修改/停用/删除及审计；小计精确小数计算（含四舍五入）；按产品价添加明细；合计随增删改更新；自定义单价不受后续产品改价影响；明细审计动作；删除商机级联删除明细；演示数据一致性。

## 第二轮：集成测试
命令：`npx vitest run tests/products/products.r2-integration.test.ts --reporter=verbose`
结果：**28/28 通过（首次即通过）**。原始输出：[results/products-r2-integration.txt](results/products-r2-integration.txt)
覆盖：只有管理员/经理能维护产品，各角色可查看；明细遵循商机编辑权限（他人商机 404、只读 403）；金额/币种锁定与金额不变保存放行、清空后解锁；币种不一致与停用产品拒绝添加；停用不影响已有明细；使用中的产品 409 且数据库 RESTRICT 兜底；SKU 唯一与跨组织可重复；批量改阶段不影响计算金额；跨组织产品/明细隔离；9 类非法明细与 7 类非法产品（含客户端提交 organizationId）；100% 折扣与小数数量；数据库 CHECK；未登录 401。

## 第三轮：回归测试
命令：`scripts/regression.sh products`（后台运行，逐阶段汇报）
结果：**PASS**——lint 12s、typecheck 13s、Vitest **473/473**（90s）、静态导出 57s、生产构建 58s、E2E **20/20**（206s）。原始输出：[results/products-r3-regression.txt](results/products-r3-regression.txt)

### 失败与修复
| 现象 | 原因 | 修复 |
|---|---|---|
| 开发阶段单独运行 E2E：明细行数量断言“3.00 件”失败 | 测试脚本预期错误：数量为 Decimal，显示“3 件”是正确格式 | 修正断言为“3 件”，重跑通过 |
