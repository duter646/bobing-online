# 后端开发说明

## 当前纵切片

已实现：匿名游客会话，创建/加入/查询房间，房主开局，自定义六档奖品名称和数量，Socket.IO 房间订阅与服务端权威投掷，力度驱动的“跳猴”概率，规则判定、附加奖项、奖品扣减、最高状元更新，投掷与房主命令幂等，以及 SQLite 事务与快照恢复。

身份支持两种并行方式：游客只填写名字；注册使用邮箱、密码和默认名字，登录使用邮箱和密码。密码以随机盐 scrypt 哈希保存。登录用户的默认名字由接口返回供客户端自动填充，认证不是进入游戏的前置条件。

个人统计仅向已登录用户开放，支持奖项次数与频率、各档奖品数量、参与/完成对局数和累计完成对局时长，并按账户跨登录会话汇总。游客仍可查看房间本局战报，但不能访问个人累计统计接口。

完整对局已支持：所有奖品耗尽后完成当前轮，再完成额外一整轮并自动结束；最终状元的临时奖品记录在结束时转为正式记录。房主可以暂停、继续、跳过当前玩家、转让房主或人工结束。

实时恢复已支持：成员首次订阅时标记在线，最后一个标签页断开并超过 10 秒宽限期后标记离线；同一成员打开多个标签页不会互相误判。轮到离线玩家时服务端自动越过连续离线席位，全员离线则等待重连。服务重启会将残留在线状态归零。重连携带 `lastSequence` 后最多补发 200 条连续事件，历史不完整或缺口过大时自动返回完整快照。

成员可以主动离开；房主离开时自动移交给最早加入的有效成员，进行中只剩一人时自动暂停。固定表情事件已经支持。新标签页接管写权限后，旧标签页保留实时观看能力但不能再发送状态变更命令。

战报支持成员查看汇总、投掷记录游标分页、不可预测的只读公开令牌、房主 CSV 导出和房主删除。未开始房间保留 24 小时，已结束战报保留 7 天，服务端每小时执行一次清理。会话、创建/加入房间、投掷和表情均有内存限流，请求体限制为 32 KB。

业务后端已经闭环。正式公网部署仍需在运行环境配置 HTTPS 反向代理、受限 CORS 域名、进程守护、备份、监控和告警。

## 运行

要求 Node.js 24+ 和 pnpm。

```bash
pnpm install
pnpm build
pnpm dev:server
```

默认监听 `http://127.0.0.1:3000`，数据库为 `data/bobing.sqlite`。可通过 `PORT` 和 `BOBING_DB_PATH` 覆盖。

## HTTP 接口

除创建会话和健康检查外，请求需携带 `Authorization: Bearer <token>`。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `POST` | `/api/sessions` | 创建游客会话，参数 `displayName` |
| `POST` | `/api/auth/register` | 注册，参数 `email`、`password`、`displayName` |
| `POST` | `/api/auth/login` | 登录，参数 `email`、`password` |
| `POST` | `/api/auth/logout` | 吊销当前会话 |
| `GET` | `/api/auth/me` | 获取登录状态和默认名字 |
| `POST` | `/api/session/name` | 修改当前会话的本局名字 |
| `GET` | `/api/me/stats` | 获取个人累计统计 |
| `POST` | `/api/rooms` | 创建房间，可传 `maxPlayers` |
| `POST` | `/api/rooms/join` | 按 `code` 加入房间 |
| `GET` | `/api/rooms/:id` | 获取房间快照 |
| `POST` | `/api/rooms/:id/start` | 房主开始，可传 `expectedRoomVersion` |
| `GET` | `/api/rooms/:id/rolls` | 投掷记录分页，参数 `after`、`limit` |
| `GET` | `/api/rooms/:id/report` | 成员查看战报汇总 |
| `GET` | `/api/rooms/:id/report.csv` | 房主导出 CSV |
| `DELETE` | `/api/rooms/:id` | 房主删除已结束战报 |
| `GET` | `/api/reports/:id?token=...` | 公开只读战报 |

Socket.IO 连接握手通过 `auth.token` 携带令牌。当前支持 `room:subscribe`、`room:update-settings`、`room:leave`、`game:roll`、`room:pause`、`room:resume`、`room:skip-turn`、`room:transfer-host`、`reaction:send` 和 `game:finish`。消息结构和错误码见 [实时通信协议](./REALTIME_PROTOCOL.md)。

## 验证

```bash
pnpm typecheck
pnpm test
```

测试覆盖规则黄金用例、全部 `6^6` 种骰面、跳猴概率、业务状态机、SQLite 持久化以及真实 HTTP/Socket.IO 流程。
