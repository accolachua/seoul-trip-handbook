# 首尔 5 日旅行手册

2026-10-30 至 2026-11-03 的共享旅行网页。

## 当前架构

- `public/index.html`：CloudBase 静态网站托管，负责旅行手册界面
- `functions/travelApi`：CloudBase HTTP 云函数，负责密码验证、共享数据与汇率
- CloudBase PostgreSQL：持久化待办、购物、账本及已收款记录
- GitHub：源码版本管理

公开页面不写入订单号、证件号、房间号、手机号、邮箱或编辑密码。

## 本地预览

直接打开 `public/index.html`。本地文件模式只用于查看页面，在线共享功能需通过已部署的 API 使用。

## 部署说明

1. 在 CloudBase PostgreSQL 创建 `public.travel_data` 表，字段为 `kind text`、`item_id text`、`data jsonb`、`updated_at timestamptz`，主键为 `(kind, item_id)`。
2. 创建仅供服务端使用的 CloudBase API Key，并在云函数环境变量中设置：
   - `CLOUDBASE_API_KEY`
   - `EDIT_PASSWORD`
3. 参考 `cloudbaserc.example.json` 部署 `travelApi` HTTP 云函数，并把 HTTP 网关路由设为 `/api`。
4. 将 `public/` 部署到 CloudBase 静态网站托管。

密钥和密码不得提交到仓库。
