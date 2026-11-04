# 路由目录约定

新增或修改本目录接口前，阅读并遵循 [后端接口与路由规范](../../../../docs/architecture/api-conventions.md)。

- `/api` 全局前缀只在 `backend/app/main.py` 的 include_router 中添加；本目录只声明资源前缀，例如 `/documents`、`/health`。
- 文件顺序：中文模块说明、分组导入、router、依赖构造与类型别名、接口函数。
- 每个接口必须在装饰器中显式声明 `operation_id`，值为对应函数名的 lowerCamelCase，例如 `get_document_chunk_stats` 对应 `getDocumentChunkStats`，并确保全局唯一。
- 接口装饰器采用多行格式；显式声明响应模型或响应类、中文 summary 和完整类型。固定路径放在可能匹配它的动态路径之前。
- 复用 DbSession 和 Service 依赖；业务路由不直接写 SQL、提交事务或操作存储 SDK。Repository 不负责 commit。
- 分页使用 offset=0、limit=20，offset>=0、1<=limit<=100，返回真实 total；错误沿用全局 `{code, message, details}`。
- 常规重构保留现有公共路径及 operationId；用户明确要求调整 operationId 时同步规范、接口文档和客户端兼容说明。新增或更改接口必须同步 `docs/api/` 契约及 `docs/status/` 状态，并执行相应验证。
