# 后端核心基础设施状态

> 更新时间：2026-10-28

## 已完成

### 1. 全局配置 `backend/app/core/config.py`

- 自定义 `Settings`（基于 pydantic-settings），通过绝对路径读取项目根目录 `.env`，因此无论从项目根目录还是 `backend/` 启动都能读到同一份配置。
- 配置优先级：进程环境变量 > `.env` > 类默认值。
- 设置 `extra="ignore"`：`.env` 中未声明的变量（例如 Compose、前端工具使用的变量）会被忽略，不会导致启动失败。
- 已声明字段：`APP_NAME`、`LOG_LEVEL`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`、`POSTGRES_PORT`、`DATABASE_URL`，以及 `COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_REGION`、`COS_BUCKET`。
- 未显式配置 `DATABASE_URL` 时，由 `POSTGRES_*` 自动拼接 `postgresql+asyncpg` 异步连接串。
- `cos_configured` 属性用于判断 COS 最小配置（SecretId / SecretKey / Bucket）是否齐备。
- 使用方：`backend/app/core/logging.py`、`backend/app/db/session.py`、`backend/alembic/env.py`。

### 2. 自定义异常 `backend/app/core/exceptions.py`

- `AppException` 基类统一携带 `code` / `http_status` / `message` / `details`，并提供 `to_dict()` 生成统一错误响应体。
- `http_status` 使用标准库 `http.HTTPStatus` 枚举，而不是裸数字。
- 内置常见异常子类：`BadRequestError`(400)、`UnauthorizedError`(401)、`PermissionDeniedError`(403)、`NotFoundError`(404)、`ConflictError`(409)、`UnprocessableEntityError`(422)、`TooManyRequestsError`(429)、`ConfigurationError`(503)。
- 业务代码通过 `raise NotFoundError("文档不存在")` 等方式抛出，由全局异常处理器统一转换。

### 3. 全局异常处理 `backend/app/api/error_handlers.py`

- `register_exception_handlers(app)` 一次性注册四类处理器，后续在 `app/main.py` 创建应用后调用即可。
- 所有错误响应统一为 `{"code": str, "message": str, "details": Any | null}`：
  - `AppException` 及其子类：使用异常自带的 `code` / `message` / `details` / `http_status`。
  - `RequestValidationError`：返回 422，`details` 为逐字段校验明细。
  - `StarletteHTTPException`（含 FastAPI `HTTPException`）：状态码映射为同一套 `code` 语义，保留原始响应头（如 `WWW-Authenticate`）；路由默认英文短语（如 `Not Found`）会替换为中文默认文案。
  - 未预期 `Exception`：固定返回 500 `{"code": "internal_error", "message": "服务内部错误", "details": null}`，完整堆栈仅通过 `logger.exception` 写入服务端日志，不会出现在响应体中。
- 日志策略：4xx 业务异常记 `info`，5xx 与未捕获异常记 `exception`（含堆栈），HTTP 4xx 记 `debug`，避免正常 404 淹没日志。

### 4. 健康检查接口 `backend/app/api/routes/health.py`

- `router = APIRouter(prefix="/api", tags=["health"])`，三个 GET 接口均无需登录：
  - `GET /api/health`：`operation_id=health_check`，只返回服务名、状态与 UTC 时间戳，不访问外部依赖。
  - `GET /api/health/database`：`operation_id=health_check_database`，通过 `DbSession` 依赖执行 `SELECT 1`，返回 `component` / `latency_ms` / `timestamp`。
  - `GET /api/health/cos`：`operation_id=health_check_cos`，通过 `get_cos_client()` 调用 `list_objects(max_keys=1)`，校验配置、鉴权、网络与存储桶。
- 成功响应模型：`HealthCheckResponse`（服务自身）、`ComponentHealthResponse`（数据库 / COS 共用，`component` 为 `"database" | "cos"`）。
- 失败统一抛出 `HealthCheckFailedError`（继承 `AppException`，503），错误响应沿用 `{code, message, details}`；数据库与 COS 的 `code` 分别为 `health_check_database_failed` / `health_check_cos_failed`。
- 异常详情只写服务端日志；响应中仅暴露组件名、耗时，COS 额外暴露底层 `code`（如 `configuration_error`、`cos_error`），不泄露密钥、连接串、SQL 等内部信息。
- 接口文档：`docs/api/health.md`。
- 挂载方式：`app.include_router(health.router)`，不要再次叠加 `/api` 前缀。

### 5. 腾讯云 COS 客户端 `backend/app/storage/cos_client.py`

- 基于 `cos-python-sdk-v5` 的 `CosS3Client` 封装。SDK 仅提供同步接口，本模块通过 `asyncio.to_thread` 把阻塞调用移入线程池，对外提供全异步 API，可直接在 FastAPI 异步路由中 `await`。
- 模块级单例 `cos_client`，并提供 FastAPI 依赖入口 `get_cos_client()`；底层客户端懒加载（首次访问 `sync_client` 时创建），使用 `threading.Lock` 防止并发重复初始化。
- 上传能力：
  - `upload_bytes(key, data, content_type=..., metadata=...)`：支持 `bytes` / `bytearray` / `memoryview` / 可读文件对象，单次建议不超过 5GB。
  - `upload_file(key, local_path, ..., part_size=10, max_thread=5)`：上传本地文件，超过分块阈值时由 SDK 自动分块并发上传，未指定 `content_type` 时按扩展名推断。
- 下载能力：`download_bytes(key)`、`download_file(key, local_path)`（自动创建父目录）。
- 查询能力：
  - `object_exists(key)`：仅将 404 视为不存在，鉴权失败、网络错误等继续抛出。
  - `head_object(key)`：返回 `COSObjectInfo`（`key` / `size` / `etag` / `content_type` / `last_modified` / `metadata`），自定义 `x-cos-meta-*` 会去掉前缀后放入 `metadata`。
  - `list_objects(prefix=..., max_keys=..., marker=...)`：返回 `COSObjectPage`（`items` / `is_truncated` / `next_marker`），支持 marker 翻页。
  - `get_presigned_url(key, expires_in=3600, method="GET", params=..., headers=...)`：生成带签名临时 URL，支持 GET / PUT 等方法和附加签名参数。
- 删除能力：`delete_object(key)`、`delete_objects(keys)`；批量删除自动按 COS 限制拆分为每批最多 1000 个。
- 错误处理：`CosServiceError` / `CosClientError` 统一转换为项目异常：
  - `COSError`（502）：服务端或客户端请求失败，`details` 保留 `key` / `cos_code` / `status_code` / `request_id` / `resource`。
  - `COSObjectNotFoundError`（404，继承 `NotFoundError`）：对象不存在。
  - 配置缺失时抛出 `ConfigurationError`（503），`details.missing` 列出缺失的环境变量；该检查为惰性执行，不阻断应用启动。
- Key 规范化：所有涉及对象路径的方法统一去除首尾空白和开头的 `/`，空 key 抛 `BadRequestError`。

### 6. 应用入口 `backend/app/main.py`

- 模块级 `app = create_app()` 是 `uvicorn app.main:app` 的挂载点；`create_app()` 独立导出，便于测试时重复构建应用。
- 组装顺序（与模块内注释一致）：
  1. 导入阶段立即调用 `configure_logging()`，保证启动日志与请求日志格式统一。
  2. `lifespan`：启动时打印应用名与版本；`COS_*` 未配置时输出 warning（不阻止启动）；关闭时 `await engine.dispose()` 释放数据库连接池。
  3. `FastAPI(title=APP_NAME, version="0.1.0", docs_url="/api/docs", redoc_url="/api/redoc", openapi_url="/api/openapi.json")`。
  4. `CORSMiddleware`：`allow_origins=settings.cors_origin_list`（由 `CORS_ORIGINS` 逗号分隔），`allow_credentials=True`，方法与请求头放开。
  5. `register_exception_handlers(app)`：在挂载路由前注册，确保路由内异常也被统一转换。
  6. `app.include_router(health.router)`：路由自带 `/api` 前缀，未重复叠加。
- 启动依赖策略：启动阶段不强制校验数据库 / COS，依赖不可用时应用仍可启动，由 `/api/health/*` 探针返回 503 暴露问题。
- 新增业务路由时，在 `create_app()` 中追加 `include_router` 即可，无需改动其它基础设施。

### 7. 密钥与版本控制 `.gitignore`

- 项目根目录新增 `.gitignore`，此前仓库没有任何忽略规则，`.env` 处于未被忽略状态，存在误提交真实凭据的风险。
- 忽略规则分组：
  - 环境与密钥：`.env`、`.env.*`，并用 `!.env.example` 反向放行模板文件；同时忽略 `*.pem`、`*.key`。
  - Python：`__pycache__/`、`*.py[cod]`、`build/`、`dist/`、`*.egg-info/`、`.venv/`、`venv/`。
  - 测试与静态检查缓存：`.pytest_cache/`、`.coverage*`、`htmlcov/`、`.mypy_cache/`、`.ruff_cache/`、`.tox/`。
  - 前端预留：`node_modules/`、`.pnpm-store/`、`dist-ssr/`、`.vite/`、`.eslintcache` 及包管理器调试日志。
  - 编辑器与系统：`.DS_Store`、`Thumbs.db`、`.idea/`（`.vscode/*` 整体忽略，仅放行 `.vscode/extensions.json`）。
  - 运行时产物与本地数据：`logs/`、`*.log`、`tmp/`、`uploads/`、`storage/`、`pgdata/`。
- 特别说明：`backend/.python-version` **不忽略**，因为它由 `uv` 用于锁定解释器版本，属于应纳入版本管理的项目文件。
- `.env.example` 纳入版本管理，作为团队共享的配置模板；真实密钥只存在于本地 `.env`。

## 验证方式与结果

- 使用 `backend/.venv/bin/python` 导入 `app.core.config` 与 `app.core.exceptions` 成功。
- 确认 `.env` 绝对路径存在并被读取；临时 `.env` 中的多余变量被忽略；`DATABASE_URL` 自动拼接结果正确。
- 断言全部异常子类的 `http_status` 均为 `HTTPStatus` 枚举、数值正确，且 `to_dict()` 键结构通过。
- 通过真实 ASGI 调用链验证全局异常处理：
  - 业务异常 `NotFoundError("文档不存在")` → 404 `{"code":"not_found","message":"文档不存在","details":null}`。
  - `HTTPException(403, "没有权限")` → 403，`code=permission_denied`，`message` 保留原始中文文案。
  - 路径参数类型错误 → 422，`details` 包含字段 `loc` / `msg` / `type`。
  - 未匹配路由 → 404 `{"code":"not_found","message":"资源不存在","details":null}`。
  - 未捕获 `ValueError` → 500 `{"code":"internal_error","message":"服务内部错误","details":null}`，异常对象与堆栈仅出现在服务端日志中。
- `app.exception_handlers` 确认已注册 `AppException`、`StarletteHTTPException`、`RequestValidationError`、`Exception`。
- 健康检查接口：
  - 用临时 `FastAPI()` 挂载 `health.router` 并生成 OpenAPI，确认存在 `/api/health`、`/api/health/database`、`/api/health/cos` 三个 GET 路径，`operationId` 分别为 `health_check`、`health_check_database`、`health_check_cos`。
  - 真实依赖验证：`health_check` 返回 `status=ok`；`health_check_database` 通过 `SELECT 1`（本地 PostgreSQL 返回正常，耗时约 42.78ms）；`health_check_cos` 调用 `list_objects(max_keys=1)` 成功（耗时约 162.49ms）。
  - 失败路径模拟：数据库会话抛异常 → 503 `health_check_database_failed`；COS 抛 `ConfigurationError` → 503 `health_check_cos_failed`，`details.reason=configuration_error`。
- COS 客户端使用假同步客户端完成异步链路冒烟测试，覆盖：
  - `upload_bytes` 的 key 规范化、Body 透传、`ContentType` / `Metadata` 透传。
  - `download_bytes` 读取流式响应。
  - `head_object` 的大小、ETag 去引号、Content-Type、Last-Modified 与 `x-cos-meta-*` 解析。
  - `object_exists` 的存在与 404 两条分支。
  - `list_objects` 的条目解析与截断标记。
  - `get_presigned_url` 的 `Method` 大写化与 `Expired` 透传。
  - `delete_objects` 传入 1500 个 key 时自动拆为 1000 + 500 两批。
  - COS 错误码 / RequestId 到 `COSObjectNotFoundError.details` 的映射，以及空配置抛出 `ConfigurationError`。
- 使用 `.env` 中的真实配置实例化 `COSClient` 并生成预签名 URL（纯本地签名，不发起网络请求），确认 `is_configured=True` 且 URL 结构正确（未输出完整签名值）。
- `backend/.venv/bin/python -m compileall app/storage/cos_client.py` 通过。
- 核心模块与健康检查此前已通过 Pylance 诊断；本次 COS 客户端编辑器诊断服务会话过期未重跑，改用 `compileall`、假客户端异步冒烟测试与真实 COS `ListObjects` 连通性检查验证。
- 应用入口 `app/main.py` 验证：
  - 进程内导入 `app.main:app` 成功；确认 `docs_url=/api/docs`、`redoc_url=/api/redoc`、`openapi_url=/api/openapi.json`，`CORSMiddleware` 已注册，四类全局异常处理器均已挂载。
  - `app.openapi()` 输出路径为 `/api/health`、`/api/health/cos`、`/api/health/database`，`operationId` 与健康检查文档一致。
  - 以 `uvicorn app.main:app --port 8011` 真实启动后验证：
    - `GET /api/health` → 200，`{"status":"ok","service":"rag-knowledge-base",...}`。
    - 带 `Origin: http://localhost:5173` 请求时返回 `access-control-allow-origin` 响应头。
    - `GET /api/docs` → 200（Swagger UI 可访问）；`GET /api/openapi.json` 返回 title / version / paths 正确。
    - `GET /api/not-exist` → 404 `{"code":"not_found","message":"资源不存在","details":null}`，证明全局异常处理在真实服务中生效。
    - `GET /api/health/database` → 200（本地 PostgreSQL `SELECT 1`，约 27.85ms）。
    - 关闭进程时输出「应用关闭，数据库连接池已释放」，确认 `lifespan` 清理逻辑执行。
- `.gitignore` 规则验证（`git check-ignore -v`）：
  - `.env` → IGNORED，`.env.example` → 可跟踪（反向规则 `!.env.example` 生效）。
  - `backend/.venv` 及其内部文件（如 `backend/.venv/bin/python`）→ IGNORED。
  - `backend/.python-version`、`backend/pyproject.toml`、`backend/uv.lock`、`docker-compose.yml` → 可跟踪。
  - `git status --untracked-files=normal` 中 `.env` 已不再出现，确认不会被误加入暂存区。
- 配置加载实测（`.env` 存在真实 COS 凭据）：`settings` 正确读到 `app_name` / `postgres_user` / `postgres_db`；`DATABASE_URL` 中的 `${POSTGRES_USER}` 等占位符由 python-dotenv 自动插值展开为 `postgresql+asyncpg://rag:rag@localhost:5432/rag_kb`；`cos_configured=True`；`cors_origin_list=['http://localhost:5173']`。

## 待办 / 已知限制

- `.env` 中的腾讯云 COS 密钥曾以明文形式存在于本地文件；由于此前没有 `.gitignore`，若该仓库曾被分享、拷贝或推送，建议在腾讯云控制台轮换 `COS_SECRET_ID` / `COS_SECRET_KEY`。
- 后续新增 `Settings` 字段时，需同步更新 `.env.example`，否则新成员克隆仓库后该字段只能使用类默认值。
- 后续业务异常应继承 `AppException`，避免直接抛出裸 `Exception`。
- 参数校验失败的 `details` 会包含 `input` 原值（与 FastAPI 默认行为一致）；如涉及密码等敏感字段，后续可在 handler 中按字段名过滤。
- `app/db/session.py` 中 `create_async_engine(..., echo=True)` 为固定开启：真实运行时 SQLAlchemy 会额外注册自己的 handler，导致每条 SQL 日志被输出两次。后续建议把 `echo` 改为 `settings.log_level == "DEBUG"` 或新增独立的 `DB_ECHO` 配置。
- OpenAPI 文档地址已从 FastAPI 默认的 `/docs`、`/openapi.json` 调整为 `/api/docs`、`/api/redoc`、`/api/openapi.json`；前端类型生成工具和 Nginx 反向代理需使用新地址。
- 健康检查接口文档已写入 `docs/api/health.md`；后续新增接口需同步补充对应文档。
- COS 的 `upload_bytes` / `download_bytes` 面向中小文件；超大文件请使用 `upload_file` / `download_file`，避免一次性占用大量内存。
- COS 客户端暂未实现跨桶复制、CDN 域名、STS 临时密钥自动刷新与下载断点续传。
- COS 连接池与超时（默认 60s、10 个连接）目前为 `COSClient` 构造参数默认值，后续可按环境迁移到 `Settings`。
