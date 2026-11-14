<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# fin-ai-brief

面向金融资讯采集、AI 筛选与归组、日报生成、发布和邮件推送的 Next.js 应用。使用 npm、Node.js 24.11+、Next.js 16 和 PostgreSQL。

## 项目结构

- `src/app`：页面、接口和服务端操作。
- `src/components`：阅读、管理、编辑和订阅界面。
- `src/server`：数据库、模型、任务、内容、发布和邮件业务。
- `src/worker.ts`：后台 Worker 与定时任务入口。
- `database/migrations`：按文件名顺序执行的 SQL 迁移。
- `scripts`：开发、迁移、验证、打包和部署脚本。
- `tests`：业务测试、浏览器测试和部署脚本测试。

Web 与 Worker 共用业务模块和 PostgreSQL；任务队列使用 pg-boss。业务边界和运行规则先查阅 `docs/architecture.md`、`docs/model-runtime.md` 与 `docs/deployment.md`。

## 开发与验证

- 安装依赖后，用 `npm run dev` 启动 Web 和 Worker；也可分别运行 `npm run dev:web`、`npm run dev:worker`。
- 业务测试使用 `.data/test.env` 中的独立测试库，数据库名必须以 `_test` 结尾。浏览器测试使用 3101 端口，并与业务测试共用该测试库，应依次运行。
- 修改后按范围运行 `npm test`、`npm run test:browser` 或 `npm run test:deploy`。完整校验使用 `npm run check`，它依次执行类型检查、业务测试、部署脚本测试和生产构建。
- 提交前运行 `npm run format:check` 和 `git diff --check`。只修复本次变更引起的失败。
- UI 修改要实际检查相关页面与交互；数据、队列、模型或发布逻辑修改要补充有行为价值的回归测试。

## 数据与配置

- 已应用的迁移不得修改或删除；数据库结构变化新增 `database/migrations` 文件，并按现有编号继续。
- 模型、SMTP 等运行配置保存在数据库中。密钥、管理员密码和签名密钥不得写入客户端或提交到仓库。
- 模型列表第一项为主力，其余启用模型按顺序备用。保留失败隔离、恢复探测、重试计数和“无模型时不回退环境变量”的现有行为；规则以 `docs/model-runtime.md` 为准。
- 涉及写入、发布、任务重试、去重或并发配置时，沿用现有事务、锁和幂等约束，不要绕过业务层直接改表。

## 发布

- 生产环境采用“本地构建并打包，上传服务器运行”的方式，服务器不拉源码、不安装 npm 依赖、不执行应用构建。
- 默认使用 `npm run package` 生成 Web/Worker 更新包；首次安装或新机恢复使用 `npm run package:full`。
- 打包前提交代码，确保工作区干净。不要手工覆盖 `deploy/.env`、`.state` 或数据库；更新步骤以 `docs/deployment.md` 为准。
- 只有用户明确要求时才提交、推送、打包或部署。
