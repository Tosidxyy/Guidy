# Guidy backend

M0 后端基础已可运行：FastAPI `/health`、统一错误、请求 ID 和白名单结构化日志。尚未接入 Supabase Auth、数据库或真实业务 API。

## Windows 安装和启动

要求 Python 3.12+ 与 uv；本轮实际验证 Python 3.12.14、uv 0.11.32。系统默认 Python 3.11.0 不用于后端。

```powershell
cd backend
uv sync --locked --python 3.12
uv run --frozen uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --no-access-log
```

`uv sync` 创建本目录 `.venv`，使用已提交的 `uv.lock`；如果本机没有 Python 3.12，uv 可按自身设置获取兼容解释器。已有项目环境可直接使用 `.venv/Scripts/python.exe`。

本机探活：[http://127.0.0.1:8000/health](http://127.0.0.1:8000/health)。本地开发文档：[http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)。staging/production 自动关闭 `/docs` 与 `/openapi.json`，所有环境 `debug=False`。

iPhone 联调时使用同一局域网的 Windows IP，并将 host 改为 `0.0.0.0`；手机上的 `localhost` 不是 Windows。只在受控局域网联调，真实手机连通性本轮未验证。

## API 合同

`GET /health` 无需登录，只表示 API 进程存活，不验证数据库、Auth 或模型可用性。未来业务接口统一放在 `/api/v1`。

```json
{
  "data": {"status": "ok", "service": "guidy-api", "version": "0.1.0"},
  "error": null,
  "request_id": "f3d9f28d-3d5f-47e9-9ad6-24601aa54930"
}
```

失败响应：`data=null`、`error={code,message,details}`、`request_id`。404/405/422/500 保持对应 HTTP 状态；422 details 只包含位置与错误类型，不包含 input、ctx 或任意异常消息。401 保留 Bearer 协议头，405 保留 Allow。

JSON envelope 中的 request_id 与 `X-Request-ID` 响应头一致。客户端提供合法 UUID 时规范化复用，否则替换为服务端随机 UUID；不回显任意追踪文本。OpenAPI/文档是框架资源，不套业务 JSON envelope，但仍带响应追踪头。

## 日志与配置

- 请求日志只记录固定 event、level、request_id、method、路由模板、状态码与耗时；404 使用 `unmatched`，不记录 URL 参数、正文、Token 或个人信息。
- 关闭 Uvicorn 原始 access log，并对 Uvicorn error log 使用白名单 formatter，避免异常原文/堆栈进入普通日志。服务端错误只输出通用信息；后续按需增加脱敏诊断字段。
- `.env.example` 目前只有 `GUIDY_ENVIRONMENT=local`；环境值限 local/test/staging/production，无效值阻止启动。
- 此轮 SQLAlchemy/Alembic 是已安装锁定的工具依赖，尚无数据库连接、迁移 env 或已执行的 SQL；后续先为 profiles/goals 建立开发/测试隔离和迁移。

## 快速检查

```powershell
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen pytest
```

本轮 22 个测试覆盖成功探活、404/405/422/500、非法 JSON、请求 ID 合法/非法与并发隔离、错误/日志私密字段保护、OpenAPI 合同、生产关闭调试/文档、配置验证。测试辅助路由仅在测试 fixture 注册，不存在于运行应用中。

另通过临时 Uvicorn 的真实 loopback HTTP 与 stdout/stderr 日志检查；测试后自动停止服务。Codex Windows 沙箱可能阻断 asyncio socketpair，这种情况下需要在支持本机进程通信的环境运行，不能将卡住的测试记为通过。

LLM、搜索、数据库密码与 Supabase service_role 仅限服务端环境变量，禁止提交真实 `.env`。
