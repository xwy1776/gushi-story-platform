# 知识图谱JSON数据迁移PostgreSQL方案文档
## 一、迁移目标
当前知识图谱数据以JSON文件存放在`data/`目录。本次迁移将图谱实体、关系存入PostgreSQL数据库，实现：
1. 不再依赖本地JSON文件加载图谱；
2. 支持数据库查询图谱实体与关系；
3. 保留原有JSON读取逻辑，可切换两种数据源。

## 二、数据库表设计（Prisma Schema）
### 表1：Graph（图谱总表）
存储每一套独立图谱（例如：桃园结义图谱、赤壁之战图谱）
|字段|类型|说明|
|---|---|---|
|id|Int|主键自增|
|name|String|图谱名称|
|description|String?|图谱描述，可选|
|createdAt|DateTime|创建时间|

### 表2：GraphEntity（图谱实体表）
|字段|类型|说明|
|---|---|---|
|id|Int|主键自增|
|graphId|Int|外键，关联Graph表|
|name|String|实体名称，如刘备|
|type|String|实体类型：人物/地点/物品|
|properties|Jsonb|实体额外属性，JSON格式存储|

### 表3：GraphRelation（实体关系表）
|字段|类型|说明|
|---|---|---|
|id|Int|主键自增|
|graphId|Int|外键，关联Graph表|
|sourceEntityId|Int|源实体ID|
|targetEntityId|Int|目标实体ID|
|relationName|String|关系名称，例如：结拜|
|properties|Jsonb|关系额外属性，JSON格式存储|

## 三、迁移流程
1. 修改 `prisma/schema.prisma`，添加上面三张数据表模型。
2. 执行 `npx prisma migrate dev` 创建数据库表。
3. 编写迁移脚本：读取`data/`下的图谱JSON文件，解析实体、关系，批量插入PG数据库。
4. 修改 `knowledge-graph.ts`，新增从PostgreSQL加载图谱的函数，保留原有`loadFromJsonFile`。
5. 新增环境变量开关 `ENABLE_GRAPH_FROM_DB`，切换数据源：
    - true：从PostgreSQL读取图谱
    - false：沿用旧逻辑，读取本地JSON文件
6. 测试：分别验证JSON读取、数据库读取两种模式，保证BFS查询功能一致。

## 四、兼容性说明
- 保持原有接口逻辑不变，上层业务代码（续写route.ts）无需大幅改动。
- 新旧两套存储方案并行，方便对比测试。

## 五、迁移风险
1. JSON字段格式不匹配，导致插入数据库失败。
2. 大量实体关系插入时性能问题。
3. 数据库读取图谱的查询速度比本地JSON慢。

## 六、测试验证
1. 数据库中成功导入所有测试图谱数据。
2. BFS多跳查询，JSON模式和数据库模式返回结果一致。
3. `npx tsc` 无类型报错。