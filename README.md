# 数智参阅

每日 AI 资讯简报，覆盖政策监管、技术模型、同业场景、资本项目、风险安全及工具开源，重点关注金融与 AMC。

[架构](docs/architecture.md) · [信源入口](docs/sources.md) · [术语](GLOSSARY.md)

## 本地运行

需要 Node.js 24.11 以上及 PostgreSQL。数据库账号需要建表和创建 pg-boss schema 的权限。

```bash
mise install
npm ci
cp .env.example .env
npm run dev
```

已有 `.env` 时保留原配置。`dev` 自动迁移数据库并启动 Web 与 Worker，网页端口为 3100。

| 配置             | 用途                                                 |
| ---------------- | ---------------------------------------------------- |
| `DATABASE_URL`   | PostgreSQL 连接                                      |
| `ADMIN_PASSWORD` | 管理员密码，至少 12 位                               |
| `APP_SECRET`     | 退订签名密钥，至少 32 位，部署后保持稳定             |
| `SITE_URL`       | 读者可访问的站点地址，本地为 `http://localhost:3100` |

模型接口、密钥、模型名称、调用开关及每日额度在管理端「系统设置」配置。旧环境中的模型配置仅在首次迁移时导入。

邮件服务器、端口、加密方式、账号、密码及发件人在「订阅与推送 → 推送配置」维护，保存后立即生效。推送总开关保留在页面顶部，统一控制订阅确认信、自动和手动推送。旧邮件环境配置首次迁移时导入，之后以页面配置为准。

## 常用命令

| 命令                     | 用途                                         |
| ------------------------ | -------------------------------------------- |
| `npm run dev`            | 开发：Web 与 Worker                          |
| `npm run dev:web`        | 单独启动开发 Web，自动迁移数据库             |
| `npm run dev:worker`     | 单独启动开发 Worker，监听代码变化            |
| `npm run build`          | 生产构建                                     |
| `npm start`              | 生产 Web，自动迁移数据库                     |
| `npm run worker`         | 生产 Worker                                  |
| `npm run db:migrate`     | 手动迁移数据库                               |
| `npm run mail:verify`    | 检查 SMTP 连接与认证，不发送邮件             |
| `npm run sources:verify` | 批量验证暂停且待验证的信源，结果写回信源记录 |
| `npm run check`          | 类型检查、业务测试、生产构建                 |
| `npm run test:browser`   | 浏览器测试                                   |
| `npm run format`         | 格式化代码及文档                             |
| `npm run format:check`   | 检查格式                                     |

生产环境分别运行 Web 和 Worker。升级时先停止 Worker，完成数据库迁移后再启动，避免旧 Worker 使用新结构。

## 管理入口

| 路径                           | 内容                               |
| ------------------------------ | ---------------------------------- |
| `/admin`                       | 出刊、采集、积压与模型用量总览     |
| `/admin/publications`          | 生成、审核、修订与发布             |
| `/admin/backfill`              | 手动补刊                           |
| `/admin/articles`              | 任务、原始资料、重试与批量重新处理 |
| `/admin/sources`               | 信源配置、验证、启停和手工导入     |
| `/admin/sources/monitor`       | 采集运行与内容贡献                 |
| `/admin/editorial/columns`     | 栏目、排期、篇幅与要览             |
| `/admin/editorial/ratings`     | 评分指标与候选门槛                 |
| `/admin/editorial/content`     | 收录、写作与复核要求               |
| `/admin/subscriptions`         | 订阅名单和手动推送                 |
| `/admin/subscriptions/history` | 邮件投递记录                       |
| `/admin/settings`              | 模型连接、调用额度与数据保留       |

读者入口为 `/`、`/archive`、`/subscribe`。历史管理入口继续跳转到当前页面。

## 出刊与订阅

- 默认每天北京时间 08:00 截稿，覆盖前一日 08:00（含）至当日 08:00（不含），生成完成后发布。
- 固定栏目按评分、条数上限和字数预算取材，材料不足允许短刊。要览按条数和总预算控制，不限制单条字数。
- 轮动栏目独立配置排期，取材天数为间隔周数乘 7，共用起刊日期作为排期基准。
- 关闭自动发布时保存待审稿。修订保留原期号和发布时间，不自动重发；补刊始终待审，审核后也不自动投递。
- 用户订阅通过确认邮件生效，链接有效期 24 小时；管理员添加的订阅直接生效。
- 真实发信需要有效 SMTP 配置并开启页面推送开关。提交结果不确定的邮件不自动重发。

## 验证

将独立测试数据库的连接写入 `.data/test.env`，数据库名称必须以 `_test` 结尾。

```bash
npm run check
npm run test:browser
```

浏览器测试使用 3101 端口和独立构建目录，默认关闭模型与邮件，不启动 Worker。业务测试与浏览器测试共用测试数据库，依次运行。
