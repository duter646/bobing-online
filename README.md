# 博饼在线（Bobing Online）

面向亲友和公司聚会的多人实时博饼网页游戏。项目先交付移动端 H5，验证玩法和联机体验后，再适配微信小程序。

## 当前状态

项目已完成可联调的 MVP 纵切片：Vue 3 H5 前端、实时房间服务、共享协议与博饼规则均已接通。

已经确认：

- 产品方向：私人房间内的实时多人聚会游戏。
- 发布顺序：先 H5 网页，后微信小程序。
- 首版存储：进行中的房间状态保存在服务器内存，关键操作和最终结果写入 SQLite。
- 首版不包含付费、公开匹配、现金兑换和复杂运营后台。

## MVP 能力

- 2～12 人通过房间码或分享链接加入房间。
- 游客昵称进入，不强制注册。
- 房主选择规则、配置奖品并开始游戏。
- 服务端生成六枚骰子的结果并完成奖项判定。
- 玩家按座位顺序轮流投掷，所有成员实时看到结果。
- 展示剩余奖品、投掷记录和当前状元。
- 支持断线重连、状态恢复、房主暂停和移交。
- 对局结束后生成结果榜单和分享战报。

## 文档导航

- [产品需求](docs/PRD.md)
- [博饼规则](docs/GAME_RULES.md)
- [系统架构](docs/ARCHITECTURE.md)
- [实时通信协议](docs/REALTIME_PROTOCOL.md)
- [SQLite 数据模型](docs/DATA_MODEL.md)
- [开发路线图](docs/ROADMAP.md)
- [调研结论](docs/RESEARCH.md)
- [素材与许可证策略](docs/ASSET_POLICY.md)
- [决策与待确认事项](docs/DECISIONS.md)
- [后端开发说明](docs/BACKEND.md)
- [后端测试与验收报告](docs/TEST_REPORT.md)

## 快速开始

```bash
pnpm install
pnpm build
pnpm dev:server
```

## 技术栈

当前实现：

- Web：Vue 3、TypeScript、Vite。
- 骰子表现：Three.js + cannon-es 轻量 3D 物理；玩家控制位置、方向和力道，过大力度会由服务端提高“跳猴”概率，其他骰面结果仍由服务端决定。
- Server：Node.js、TypeScript、Socket.IO。
- 数据：SQLite（WAL 模式）。
- 测试：Vitest；规则引擎穷举全部 46,656 种骰子组合。
- 工程：pnpm workspace 单仓库，Web、Server、规则包和协议包分离。

## 目录

```text
bobing-online/
├─ apps/
│  ├─ web/                 # H5 客户端
│  └─ server/              # HTTP 与实时房间服务
├─ packages/
│  ├─ domain/              # 无框架依赖的规则与房间状态机
│  └─ protocol/            # 客户端与服务端共享的事件类型
├─ docs/
├─ package.json
└─ pnpm-workspace.yaml
```

微信小程序阶段复用 `domain`、`protocol` 和服务端，不强求 H5 UI 原样跨端运行。
