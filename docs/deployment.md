# 单机部署：本地打包，上传服务器运行

适用环境：一台阿里云轻量应用服务器或ECS，建议从2核4GB起步，公网IP访问。默认服务器为Ubuntu 24.04；服务器只安装Docker、Compose、Python 3和基础系统工具，不安装Node.js，不拉Git仓库，不编译应用。

## 1. 两边分别做什么

| 位置         | 操作                                               |
| ------------ | -------------------------------------------------- |
| 本地开发电脑 | 修改和验证代码、构建Linux镜像、生成部署包、上传    |
| 阿里云服务器 | 解压部署包、加载镜像、初始化或迁移数据库、启动容器 |

服务器常驻4个容器：Nginx、Web、Worker、PostgreSQL。只有Nginx映射入口端口，Web3100和数据库5432不对公网开放。数据库使用独立数据卷，更新应用不删除数据。

部署包分为两种：默认更新包只含Web、Worker镜像；`--full`完整包另外包含PostgreSQL、Nginx镜像，用于首次安装或新机恢复。两者都包含Compose、Nginx配置、初始化/部署/备份/恢复脚本和本文档。它不包含本地真实 `.env`、数据库或备份；Web和Worker所需的代码及依赖已经在镜像内。服务器在部署时不需要连接GitHub、npm或镜像仓库，业务运行仍需访问配置的信源、模型接口及SMTP。

## 2. 首次部署

### 2.1 本地：确认服务器架构

在服务器执行一次：

```bash
uname -m
```

| 输出                          | 本地打包参数                  |
| ----------------------------- | ----------------------------- |
| `x86_64`，通常的Intel/AMD ECS | 默认 `--platform linux/amd64` |
| `aarch64`，ARM ECS            | `--platform linux/arm64`      |

本地安装Docker Desktop或Docker Engine＋Buildx，及Python 3.9以上。Docker需支持 `docker image save --platform`，建议使用Docker 29以上。可以在Mac上构建，但必须按服务器架构选择平台，不能直接复制Mac的 `node_modules` 或 `.next`。

### 2.2 本地：生成完整部署包

在项目根目录，完成验证后执行（不需要先推送到远端仓库）：

```bash
npm run package:full
```

ARM服务器改为：

```bash
npm run package:full -- --platform linux/arm64
```

脚本会构建Web和Worker，准备PostgreSQL与Nginx镜像，生成版本号、平台标识及文件校验清单。末尾打印部署包的完整路径，例如：

```text
.data/releases/fin-ai-brief-full-amd64-24e50-20261112-001530.tar.gz
```

本地构建需要访问镜像仓库和npm源。首次较慢，后续复用Docker缓存；打包文件较大，先确认本地及服务器磁盘空间。

打包前请先手动提交代码，并填写准确的提交说明。脚本不执行暂存、提交或推送；检测到未提交修改（包括未跟踪的新文件）时停止打包，确保版本哈希对应实际发布代码。

包名格式为 `fin-ai-brief-包类型-架构-Git短哈希-北京时间.tar.gz`，时间使用东八区、精确到秒；短哈希默认5位，Git遇到前缀冲突时自动加长。完整提交哈希保存在 `release/manifest.json` 的 `git_commit` 字段中。构建期间请勿修改代码或切换提交，检测到变化会停止打包。

### 2.3 服务器：安装运行环境，只做一次

下面安装命令针对Ubuntu 24.04。其他系统使用[Docker官方安装说明](https://docs.docker.com/engine/install/)。已有Docker时跳过安装，检查版本即可。

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl python3 util-linux
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF_DOCKER
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF_DOCKER

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo timedatectl set-timezone Asia/Shanghai
sudo usermod -aG docker "$USER"
```

退出SSH、重新登录，再执行：

```bash
docker version
docker compose version
sudo mkdir -p /opt/fin-ai-brief
sudo chown "$USER":"$(id -gn)" /opt/fin-ai-brief
```

服务器Compose需要v2.20以上。Docker安装来源见[官方Ubuntu安装文档](https://docs.docker.com/engine/install/ubuntu/)。后续应用更新不重复安装环境。

阿里云安全组仅向办公公网IP或可信网段开放SSH及页面入口端口，默认页面端口80。Nginx另有来源限制。HTTP不加密登录和配置内容，建议使用可信网络或文末的SSH隧道；直接公网长期使用时，另配适用于IP的HTTPS。

### 2.4 本地：上传部署包

将文件名替换为本次打包实际输出的路径：

```bash
scp .data/releases/fin-ai-brief-full-amd64-本次版本.tar.gz 用户名@服务器公网IP:/tmp/
```

### 2.5 服务器：解压、初始化并启动

```bash
tar -xzf /tmp/fin-ai-brief-full-amd64-本次版本.tar.gz -C /opt/fin-ai-brief
cd /opt/fin-ai-brief
./scripts/deploy.sh init 80 198.51.100.8/32
# 在 deploy/.env 中填写 SITE_URL，例如 http://203.0.113.20
./scripts/deploy.sh deploy
./scripts/deploy.sh status
```

初始化命令填写容器入口端口和**办公网络的出口公网IP**。若使用8080端口，初始化时填 `8080`，安全组同步开放8080。将 `SITE_URL` 填为读者实际访问的地址，可以是反向代理提供的HTTPS域名。

`init`生成权限为600的 `deploy/.env`，自动生成密码和签名密钥；已有配置时拒绝覆盖。查看管理员初始密码：

```bash
grep '^ADMIN_PASSWORD=' deploy/.env
```

`deploy`依次执行：

1. 校验部署包完整性及服务器架构，加载包内镜像，不在服务器构建。
2. 首次启动PostgreSQL并创建应用账号；后续保留现有数据库容器和数据卷，不顺带升级数据库镜像。
3. 停止旧Web和Worker，Nginx继续运行；应用切换期间可能短暂返回502。
4. 备份数据库、生产配置及当前版本。
5. 用临时迁移容器执行数据库迁移。
6. 启动Web、Worker并等待健康，再检查Nginx配置、重新加载，最后记录成功版本。Nginx仅在Compose检测到镜像或容器配置变化时重建。

正常结果是4个常驻服务全部 `running/healthy`。浏览器访问初始化配置的地址，登录入口为 `/login`。

### 2.6 首次业务配置

从空库启动不会带上本地信源、订阅和历史刊期。

1. 在「系统设置」填写模型接口、密钥及模型名，测试并保存。
2. 在「订阅与推送 → 推送配置」填写SMTP与发件人，测试并保存，暂不开启推送总开关。
3. 在「信源管理」参考[项目内信源清单](sources.md)添加需要的来源，验证样本，再启用。部署包中的 `docs/sources.md`仅作入口参考，不自动导入业务数据。
4. 检查栏目、评分门槛、起刊日期和每日截稿时间。
5. 开启模型调用、自动采集，检查任务结果，再手动生成一期验证。
6. 确认内容、订阅名单及SMTP后，开启页面推送总开关。

SMTP优先使用465和SSL/TLS。邮件确认、退订及刊期阅读链接使用 `SITE_URL`，打开链接的收件人也必须在安全组与Nginx允许的来源范围内。

## 3. 后续迭代更新

### 本地电脑

修改并验证代码，然后生成默认更新包、上传。此模式只构建和打包Web、Worker，不检查、下载或打包PostgreSQL与Nginx镜像：

```bash
npm run package
scp .data/releases/fin-ai-brief-update-amd64-新版本.tar.gz 用户名@服务器公网IP:/tmp/
```

### 服务器

覆盖解压到原目录，再部署：

```bash
tar -xzf /tmp/fin-ai-brief-update-amd64-新版本.tar.gz -C /opt/fin-ai-brief
cd /opt/fin-ai-brief
./scripts/deploy.sh deploy
./scripts/deploy.sh status
```

更新包沿用 `deploy/.state/postgres-image` 和 `deploy/.state/nginx-image` 中记录的服务器镜像，兼容之前的完整包部署。缺少基础镜像或部署状态时会在停止应用前报错；请恢复原镜像/状态或在新机使用 `--full` 完整包。旧的、不带包类型的完整包仍可加载。

不用拉代码、安装npm依赖、重新初始化或重新填写模型和邮件配置。包中不含真实 `deploy/.env`、`.state`和备份目录，覆盖解压会保留它们，包括手动补充的 `JIANYU_RSA_PRIVATE_KEY`、`JIANYU_COOKIE`、管理员密码和签名密钥。首次迁移需单独填写这些环境配置，本地真实 `.env` 不会自动上传。不要先删除 `/opt/fin-ai-brief`，也不要同时进行两次解压部署。

加载镜像期间旧服务继续运行；停应用、备份、迁移和重启期间短暂停机。失败时不会自动混用旧代码和新数据库，检查日志后修复重试，或按下一节恢复。

```bash
./scripts/deploy.sh logs web
./scripts/deploy.sh logs worker
```

每条日志命令用 `Ctrl+C`退出。检查登录、最新刊期与任务列表。数据库镜像升级属于独立维护，不包含在日常应用更新中。

## 4. 备份、恢复与回退

### 4.1 备份

```bash
cd /opt/fin-ai-brief
./scripts/deploy.sh backup
```

每次生成同名的 `.dump`数据库备份、`.env`生产配置和 `.version`应用版本。目录权限受限，备份包含模型及SMTP凭据，不上传Git。

通过 `crontab -e` 添加每日备份：

```cron
15 2 * * * cd /opt/fin-ai-brief && /bin/bash scripts/deploy.sh backup >> /opt/fin-ai-brief/deploy/backups/backup.log 2>&1
```

按服务器时区运行，首次安装步骤已设为北京时间。部署、备份和恢复通过文件锁避免并发。脚本不自动删除备份，定期复制到本地或OSS，再按需清理旧文件。

本地电脑下载备份：

```bash
scp -r 用户名@服务器公网IP:/opt/fin-ai-brief/deploy/backups ./fin-ai-brief-backups
```

同时保存每次发布的部署包。恢复时需要对应的应用镜像，不要立即执行 `docker image prune -a`。

### 4.2 原服务器恢复数据库和应用

读取发布前备份中的版本：

```bash
cat deploy/backups/备份名.version
./scripts/deploy.sh restore deploy/backups/备份名.dump 对应版本 --confirm
```

恢复会撤销备份之后的新数据。脚本先检查备份和镜像，再次备份当前库，停止应用，重建业务库并恢复，然后启动指定应用版本。

恢复后，自动采集、模型调用、每日出刊和推送开关默认关闭。先核对旧队列和已发送邮件，再按需开启，避免重放产生重复投递。账号、数据卷和当前 `deploy/.env`保留；旧签名密钥等配置如需恢复，从同名 `.env`备份核对，不盲目覆盖当前数据库账号密码。

若旧镜像已清理，先在服务器把保留的旧部署包解压到临时目录，只加载镜像，不覆盖当前部署文件：

```bash
mkdir -p /tmp/fin-ai-old-release
tar -xzf /保存路径/旧版本部署包.tar.gz -C /tmp/fin-ai-old-release
./scripts/deploy.sh load /tmp/fin-ai-old-release
./scripts/deploy.sh restore deploy/backups/备份名.dump 对应版本 --confirm
```

### 4.3 新机器灾难恢复

1. 安装运行环境，解压备份对应版本的**完整包**到 `/opt/fin-ai-brief`；更新包不含基础镜像，不能单独用于新机恢复。完整包在本地用 `npm run package:full` 生成，应保留与备份对应的版本。
2. 把备份的 `.env`复制到 `deploy/.env`，设为600权限，核对新服务器的IP和访问来源；不要重新生成 `APP_SECRET`。
3. 载入镜像并恢复：

```bash
cd /opt/fin-ai-brief
chmod 600 deploy/.env
./scripts/deploy.sh load
./scripts/deploy.sh restore /绝对路径/备份.dump 对应版本 --confirm
```

无须重新拉取源码或在服务器编译。

## 5. 生产配置和排查

| 配置                                   | 含义                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| `SITE_URL`                             | 实际访问地址，用于邮件链接及管理员登录 Cookie 的 HTTPS 设置 |
| `ACCESS_CIDR`                          | 办公公网IP或可信网段；单IP用 `/32`，不接受全网开放          |
| `BIND_ADDRESS`                         | 默认 `0.0.0.0`；仅SSH隧道访问可设为 `127.0.0.1`             |
| `HTTP_PORT`                            | Nginx 映射到服务器的端口，默认80                            |
| `POSTGRES_PASSWORD`、`APP_DB_PASSWORD` | 初始化生成的数据库密码，单改文件不会更改已有数据库角色密码  |
| `ADMIN_PASSWORD`                       | 管理员密码                                                  |
| `APP_SECRET`                           | 退订签名密钥，保持稳定                                      |

修改配置后重新执行 `deploy`，现有模型与SMTP配置保存在数据库中。剑鱼私钥如需设置，填写去掉PEM头尾及换行的单行Base64正文。

Worker健康检查验证心跳和数据库连接；Web验证 `/api/health`。健康检查不能替代“今天是否成功出刊”的检查，Docker也不会仅因 `unhealthy`自动重启仍存活的进程。

| 现象             | 检查                                                     |
| ---------------- | -------------------------------------------------------- |
| 部署包平台不符   | 按服务器 `uname -m`重新选择 `--platform`打包             |
| 包校验失败       | 重新上传并解压完整包，不手动修改包内脚本或配置模板       |
| 页面403          | 办公出口IP是否匹配安全组与 `ACCESS_CIDR`                 |
| 页面超时         | 入口端口、安全组、服务器防火墙及容器状态                 |
| 页面正常但不出刊 | Worker、采集和模型开关、信源启停、额度、任务错误         |
| 邮件失败         | 页面测试SMTP、端口、加密方式及授权码                     |
| 迁移失败         | 查看日志，修复后重试或恢复发布前备份，不手动混启不同版本 |

仅SSH隧道访问时，配置 `BIND_ADDRESS=127.0.0.1`、`HTTP_PORT=8080`、`SITE_URL=http://127.0.0.1:8080`，部署后在自己电脑执行：

```bash
ssh -N -L 8080:127.0.0.1:8080 用户名@服务器公网IP
```

浏览器打开 `http://127.0.0.1:8080`。该地址仅适用于建立了隧道的本机，不适合作为其他订阅者的邮件阅读地址。

正常暂停使用 `./scripts/deploy.sh stop`。不要执行 `docker compose down -v` 或删除数据卷。
