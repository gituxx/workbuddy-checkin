# WorkBuddy Check-in

基于 Cloudflare Workers + D1 的个人 WorkBuddy 多账号签到面板。账号通过官方登录页授权，凭据在写入 D1 前使用 AES-GCM 加密；支持手动签到、全部账号签到和每天定时签到。

> 这是非官方个人工具，与腾讯、WorkBuddy、CodeBuddy 均无隶属关系。请只连接自己有权管理的账号，并遵守相关服务条款。签到接口、登录协议和免费额度可能变化。

## 功能

- 最多连接 10 个账号，可单独签到、全部签到或移除账号。
- 每天 UTC 00:00 自动运行，即北京时间 08:00。
- 所有账号凭据使用 AES-GCM 加密后存入 Cloudflare D1。
- 显示最近运行结果、时间和积分余额；管理 API 要求管理口令。
- 部署在自己的 Cloudflare 账号和自定义域名上，不依赖常驻服务器。

## 架构

```text
浏览器管理面板 ──管理口令──> Cloudflare Worker ──> WorkBuddy 服务
                                     │
                                     └── 加密账号凭据 / 签到状态 ──> D1

Cloudflare Cron（每天 00:00 UTC） ──> Worker 批量签到
```

## 免费额度

本项目只使用 Workers、Cron Triggers 和 D1，不需要购买服务器。按 Cloudflare 当前公开的 Free 额度，Workers 为每天 100,000 次请求；D1 为每天 500 万行读取、10 万行写入，数据库总存储上限 5 GB（单库上限 500 MB）。个人低频使用通常远低于这些限额，但这不是免费或可用性保证；超限后操作可能失败，额度也可能调整。上线前请查看 [Workers 定价与额度](https://developers.cloudflare.com/workers/platform/pricing/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) 和 [D1 定价与额度](https://developers.cloudflare.com/d1/platform/pricing/) 的最新说明。

## 部署

### 准备

- 一个 Cloudflare 账号，并能使用 Workers 和 D1。
- Node.js 22 或更新版本、npm。
- Wrangler 由锁文件固定版本，不需要全局安装。

### 1. 获取代码并安装依赖

```sh
git clone https://github.com/gituxx/workbuddy-checkin.git
cd workbuddy-checkin
npm ci
```

### 2. 创建 D1 并配置 Wrangler

```sh
npx wrangler d1 create workbuddy-checkin
```

复制模板为本地配置：

```sh
cp wrangler.example.jsonc wrangler.jsonc
```

Windows PowerShell 可运行：

```powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

将创建 D1 时返回的数据库 ID 填入 `wrangler.jsonc` 的 `database_id`。该文件已被 Git 忽略，不要提交它。

### 3. 设置管理口令和加密密钥

分别生成两个不同的随机值。下面的命令每运行一次会生成一个 Base64 随机值：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

先运行一次作为管理口令，再运行一次作为数据加密密钥。将生成值分别交给 Wrangler：

```sh
npx wrangler secret put APP_PASSWORD
npx wrangler secret put DATA_ENCRYPTION_KEY
```

按提示粘贴对应值。两个值都只应保存在密码管理器和 Cloudflare Worker Secrets 中，不要写进源码、`wrangler.jsonc`、`.dev.vars` 的 Git 提交或 issue。

**请妥善备份 `DATA_ENCRYPTION_KEY`。** 更换或丢失它会使已有账号凭据无法解密；当前版本没有在线重加密密钥的功能。管理口令可以单独更换，数据加密密钥不要直接轮换。

### 4. 初始化数据库并部署

```sh
npm run db:migrate
npm run deploy
```

Wrangler 会显示 `workers.dev` 地址。首次打开页面后输入 `APP_PASSWORD`，选择“添加账号”，在 WorkBuddy 官方登录页完成授权。也可以之后按单个账号或全部账号立即签到。

### 5. 绑定自己的自定义域名（可选）

域名需要已添加到**同一个 Cloudflare 账号**。编辑本地 `wrangler.jsonc`，增加 `routes`：

```jsonc
"routes": [
  { "pattern": "checkin.example.com", "custom_domain": true }
],
```

把 `checkin.example.com` 换成自己的主机名，然后重新部署：

```sh
npm run deploy
```

Cloudflare 会为自定义域名配置 DNS 和证书。也可以继续使用 Wrangler 显示的 `workers.dev` 地址。自定义域名不会自动增加访问控制，管理 API 仍依赖强随机 `APP_PASSWORD`；不要把口令交给他人。

## 本地开发

本地配置和密钥不会从 Cloudflare 自动下载。创建被忽略的 `.dev.vars`，填入和测试环境对应的两个值，然后运行：

```dotenv
APP_PASSWORD="本地开发用的管理口令"
DATA_ENCRYPTION_KEY="本地开发用的 Base64 密钥"
```

启动开发服务器：

```sh
npm run dev
```

本地 D1 使用 Wrangler 模拟数据，与线上 D1 相互独立。不要用真实账号做不必要的本地测试。

## 安全和运行说明

- Worker 的 API 均要求 `Authorization: Bearer <APP_PASSWORD>`；浏览器不会把管理口令保存到 `localStorage`。请使用 HTTPS，并避免在不可信设备上操作。
- OAuth 登录会话约 5 分钟过期；完成授权后账号凭据才会加密写入 D1。D1 中的最近运行状态和余额不是账号凭据，但仍应视为个人数据。
- 最多支持 10 个账号；全部签到时最多并发处理 4 个。登录失效时需在面板中重新连接该账号。
- 每日 Cron 按 UTC 运行；Workers 定时任务可能有调度延迟，不保证精确到秒。
- 删除账号会删除本项目 D1 中对应的凭据和状态，不会注销或删除 WorkBuddy 账号。
- GitHub 仓库是公开的。提交前检查不要包含 `wrangler.jsonc`、`.dev.vars`、`.wrangler/`、`node_modules/`、真实数据库 ID 或任何口令/令牌。

## 目录

```text
src/index.js             Worker API、授权、加密和定时签到
public/                  管理面板
migrations/              D1 数据库迁移
wrangler.example.jsonc   不含账号信息的配置模板
```

## 许可

本仓库的源代码和文档按 [MIT License](LICENSE) 发布。`public/workbuddy.png` 及 WorkBuddy、CodeBuddy 相关标识仅用于识别兼容服务，其权利归各自权利人所有，不包含在本仓库的 MIT 授权中。
