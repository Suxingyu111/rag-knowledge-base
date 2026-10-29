# 健康检查接口

> 更新时间：2026-10-28
> 实现文件：`backend/app/api/routes/health.py`

## 概览

| 接口 | 方法 | operation_id | 检查对象 | 权限 |
| --- | --- | --- | --- | --- |
| `/api/health` | GET | `health_check` | 后端服务自身（进程存活） | 无需登录 |
| `/api/health/database` | GET | `health_check_database` | PostgreSQL 连通性 | 无需登录 |
| `/api/health/cos` | GET | `health_check_cos` | 腾讯云 COS 连通性 | 无需登录 |

- 所有路径已由 `APIRouter(prefix="/api")` 统一加上 `/api` 前缀；在 `app/main.py` 中直接 `app.include_router(health.router)` 即可，**不要再次叠加 `/api` 前缀**。
- 三个接口均声明了 `operation_id`，前端类型生成工具（如 `@hey-api/openapi-ts`、`openapi-typescript`）会据此生成函数名：
  - `health_check` → `healthCheck`
  - `health_check_database` → `healthCheckDatabase`
  - `health_check_cos` → `healthCheckCos`
- 三个接口均不接收请求参数或请求体，也不要求登录态、CSRF Token。
- 暂未接入限流；如对公网暴露，建议在网关层限制访问来源或频率。

## 1. 后端服务健康检查

### 请求

```http
GET /api/health
```

无请求参数。

### 成功响应（200）

```json
{
  "status": "ok",
  "service": "rag-knowledge-base",
  "message": "服务运行正常",
  "timestamp": "2026-10-28T15:21:13.899562Z"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `"ok"` | 固定为 `ok`，表示进程可正常处理请求 |
| `service` | `string` | 服务名称，取自 `APP_NAME` 配置 |
| `message` | `string` | 健康状态说明 |
| `timestamp` | `string` | 检查时间，UTC ISO 8601 |

该接口不访问数据库或 COS，适合作为存活探针（liveness probe）。只要进程能处理请求就返回 200。

## 2. 数据库连通性检查

### 请求

```http
GET /api/health/database
```

无请求参数。

### 成功响应（200）

```json
{
  "status": "ok",
  "component": "database",
  "message": "数据库连接正常",
  "latency_ms": 42.78,
  "timestamp": "2026-10-28T15:21:13.942698Z"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `"ok"` | 固定为 `ok`，表示数据库可用 |
| `component` | `"database"` | 被检查的组件名称 |
| `message` | `string` | 健康状态说明 |
| `latency_ms` | `number` | 本次检查耗时（毫秒，保留两位小数） |
| `timestamp` | `string` | 检查时间，UTC ISO 8601 |

### 失败响应（503）

对数据库执行 `SELECT 1` 失败（连接串错误、网络不通、实例不可用、鉴权失败等）时返回：

```json
{
  "code": "health_check_database_failed",
  "message": "数据库健康检查失败",
  "details": {
    "component": "database",
    "latency_ms": 12.34
  }
}
```

- 完整的底层异常与堆栈只写入服务端日志，不会返回连接串、SQL、账号等内部信息。
- 错误响应结构与其他业务接口一致，均为 `{code, message, details}`。

## 3. COS 连通性检查

### 请求

```http
GET /api/health/cos
```

无请求参数。

### 成功响应（200）

```json
{
  "status": "ok",
  "component": "cos",
  "message": "COS 连接正常",
  "latency_ms": 162.49,
  "timestamp": "2026-10-28T15:21:14.105644Z"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `"ok"` | 固定为 `ok`，表示 COS 可用 |
| `component` | `"cos"` | 被检查的组件名称 |
| `message` | `string` | 健康状态说明 |
| `latency_ms` | `number` | 本次检查耗时（毫秒，保留两位小数） |
| `timestamp` | `string` | 检查时间，UTC ISO 8601 |

实现上调用 COS `ListObjects`（`max_keys=1`），用于同时验证：

- `COS_SECRET_ID` / `COS_SECRET_KEY` / `COS_BUCKET` 是否已配置；
- 鉴权是否有效；
- 网络与存储桶是否可访问。

### 失败响应（503）

未配置 COS，或 COS 调用失败时返回：

```json
{
  "code": "health_check_cos_failed",
  "message": "COS 健康检查失败",
  "details": {
    "component": "cos",
    "latency_ms": 12.34,
    "reason": "configuration_error"
  }
}
```

`details.reason` 为底层异常的 `code`（如 `configuration_error`、`cos_error`），便于排查；不会返回密钥、签名 URL 等敏感信息。

## 前端 TypeScript 类型建议

```ts
export type HealthStatus = "ok";

export interface HealthCheckResponse {
  status: HealthStatus;
  service: string;
  /** 健康状态说明 */
  message: string;
  /** 检查时间（UTC，ISO 8601） */
  timestamp: string;
}

export type HealthComponent = "database" | "cos";

export interface ComponentHealthResponse {
  status: HealthStatus;
  component: HealthComponent;
  /** 健康状态说明 */
  message: string;
  /** 本次检查耗时（毫秒） */
  latency_ms: number;
  /** 检查时间（UTC，ISO 8601） */
  timestamp: string;
}

export interface ErrorResponse {
  code: string;
  message: string;
  details: unknown | null;
}
```

## 特殊行为说明

- **软删除 / 数据隔离 / 会员额度**：健康检查不涉及用户数据，不受软删除、租户隔离或会员额度影响。
- **登录态与 CSRF**：三个接口均为公开探针，不校验登录态与 CSRF。
- **数据库会话**：`/api/health/database` 通过 `app.api.deps.DbSession` 复用项目统一的 `AsyncSession` 依赖，请求结束后自动关闭会话。
- **COS 客户端**：`/api/health/cos` 通过 `get_cos_client()` 复用模块级单例连接池；阻塞的同步 SDK 调用由 `COSClient` 内部通过 `asyncio.to_thread` 执行，不会阻塞事件循环。
- **状态码约定**：探针成功返回 200；依赖不可用返回 503。若接入 Kubernetes，存活探针建议使用 `/api/health`，就绪探针建议使用 `/api/health/database` 与 `/api/health/cos`。
