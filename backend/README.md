# Guidy backend

FastAPI 后端将在 M0 下一轮初始化。本目录目前没有可运行 API。

要求 Python 3.12+；默认 Python 3.11.0 不用于后端开发。后续先实现 `/health`、统一错误和 request_id，再接 Supabase Auth 与 profiles/goals 迁移。

LLM、搜索、数据库密码与 Supabase service_role 仅限服务端环境变量，禁止提交真实 `.env`。
