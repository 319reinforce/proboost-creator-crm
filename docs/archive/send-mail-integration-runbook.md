# Send-Mail Integration Runbook

> Archived reference. This describes the original `/Users/depp/send-mail` integration runbook. The current send-mail source of truth is `docs/send-mail-sqlite-migration-plan.md`; current project status is in `docs/handoff.md`.

## 1. 本轮目标

这轮目标是把 `/Users/depp/send-mail` 里已经成熟的 ProBoost 批量发送能力接入 `proboost-creator-crm`，让 CRM 提供一个前端审核台：

1. 用户选择一个或多个本地 `.xlsx`。
2. 系统拆分成多个 batch。
3. 页面展示 manifest 和每个 batch 状态。
4. 用户选择 ProBoost 模板名。
5. 系统使用有头浏览器执行批量发送。
6. ProBoost 已发送页只用于现场复核，不把已发送数据长期落库。

用户明确的新边界：

- 发送过去的数据不需要存储。
- 每次只检查收件箱或当场页面状态。
- ProBoost 的已发送界面只是复核界面，不需要落库。
- 所有真实发送都必须是有头浏览器。
- 模板名要可自定义，至少支持 `0414新规模板` 和 `0421三图模板`。

## 2. 已完成的集成

当前 `proboost-creator-crm` 已经接入了：

- `/Users/depp/send-mail/split-creators.js`
- `/Users/depp/send-mail/proboost-auto.js`
- 本地审核台 `http://127.0.0.1:8787`
- 多文件 `.xlsx` 上传
- 自动拆分 batch
- manifest 展示
- 单批有头发送
- pending 批次连续有头发送
- 发送模板名输入框

相关文件：

- `src/web/server.js`
- `src/sendMailBridge/engine.js`
- `src/sendMailBridge/manifest.js`
- `src/sendMailBridge/paths.js`

## 3. 本轮真实运行经验

### 3.1 只发送一批的原因

最初审核台的连续发送逻辑是“每个 batch 单独 spawn 一次 `proboost-auto.js`”。

同时，发送时传了：

```env
KEEP_BROWSER_OPEN=1
```

结果：

1. batch 1 发送完成后，Edge 继续保持打开。
2. 该 Edge 占用 `/Users/depp/send-mail/.proboost-auth/default/edge-profile`。
3. batch 2 再启动新的 Edge 时，Playwright 报错：

```text
Failed to create a ProcessSingleton for your profile directory
SingletonLock: File exists
```

结论：

真实发送模式不能让每个 batch 都保持浏览器打开；如果要连续发送，应该使用 `send-mail/proboost-auto.js` 原本支持的单进程连续模式。

### 3.2 正确连续发送方式

`send-mail/proboost-auto.js` 本来支持：

```env
BATCH_LIST=2,3,4
MANIFEST_PATH=/path/to/manifest.json
```

在这个模式下：

1. 只启动一个有头 Edge。
2. batch 之间复用同一个 browser context。
3. 每批发送后自动回到邮件首页。
4. 再点击左侧 `达人推广`。
5. 再进入 `指定达人`。
6. 上传下一批。

这是后续审核台连续发送应该走的方式。

当前已把 `runPending()` 改成单进程 `BATCH_LIST` 模式。

### 3.3 发送成功检测偏保守

batch 2-6 的日志都显示已经完成：

```text
点击「立即发送」
已自动确认发送
```

但 manifest 状态仍为：

```text
failed: success-toast-not-found
```

原因是脚本没有捕捉到成功 toast 或发送记录。

这不一定代表没有发送，代表的是“自动复核未捕捉到成功信号”。

后续应该把状态拆开：

- `send-clicked`
- `send-confirmed`
- `sent-verified`
- `verify-missed`
- `failed`

现在直接把未捕获 toast 记为 `failed`，会误导运营判断。

### 3.4 可触达 0 位的处理

batch 7-10 的 `.xlsx` 里邮箱列为空。

ProBoost 上传后弹窗出现“可触达 0 位”或类似提示。

旧逻辑只等待页面出现 `选择` 按钮，因此会超时：

```text
page.waitForFunction: Timeout 30000ms exceeded
at waitForImportReady
```

用户明确要求：

如果弹窗里出现 `可触达为0位`，这一轮直接跳过。

已在 `/Users/depp/send-mail/proboost-auto.js` 中加入导入阶段判断：

- `可触达 0 位`
- `可触达达人 0 位`
- `剩余 0 位`
- `去重后剩余 0`
- `去重后 ... 0 位`

命中后：

```text
跳过本批次
reason = import-zero-reachable
selectedCount = 0
```

注意：这是修改了 `send-mail` 原项目脚本，不是只改 CRM wrapper。

## 4. 当前状态解释

这次运行后的 batch 状态大致是：

- batch 1：曾执行发送，但状态残留 `sending/failed` 类似，原因是 toast 复核没抓到。
- batch 2-6：都走到点击发送和确认发送，但状态为 `failed: success-toast-not-found`。
- batch 7-10：检测到 0 可触达，按规则跳过。

因此，manifest 里的 `failed: success-toast-not-found` 不能简单理解为“没发送”。

后续前端展示要区分：

- 点击发送失败
- 确认发送失败
- 成功复核失败
- 0 可触达跳过

## 5. 下一步开发计划

### Phase A: 不再直接改原始 send-mail

用户最新要求是：

> 不要修改原始代码，把运行经验同步落袋一个文档。

后续开发建议尽量不要继续改 `/Users/depp/send-mail/proboost-auto.js`。

更稳妥的路线：

1. 保留 `send-mail` 作为成熟执行引擎。
2. 在 `proboost-creator-crm` 里做 wrapper 和 patch layer。
3. 如果必须扩展行为，优先在 CRM 侧复制/封装一份 adapter，而不是直接改 send-mail 原文件。

### Phase B: 状态模型修正

当前 send-mail manifest 里的状态太粗：

- `pending`
- `preparing`
- `prepared`
- `sending`
- `sent`
- `failed`

建议在 CRM 侧补充解释层，不改变原 manifest 也可以：

```json
{
  "batchNumber": 5,
  "executionStage": "send-confirmed",
  "verificationStatus": "toast-not-found",
  "operatorStatus": "needs-spot-check",
  "selectedCount": 193
}
```

前端展示时：

- `send-confirmed + toast-not-found` 显示为“已点击确认，待抽查”
- `import-zero-reachable` 显示为“0 可触达，已跳过”
- `ProcessSingleton` 显示为“浏览器 profile 被占用”
- `waitForImportReady timeout` 显示为“导入后无可选达人”

### Phase C: 连续发送入口稳定化

审核台连续发送应该固定走：

```env
MANIFEST_PATH=/path/to/manifest.json
BATCH_LIST=...
TEMPLATE_NAME=...
KEEP_BROWSER_OPEN=0
```

不要逐批 spawn。

如果要支持“准备模式”，才使用：

```env
PREPARE_ONLY=1
KEEP_BROWSER_OPEN=1
```

### Phase D: 前端审核增强

建议前端补充：

1. 每个 batch 的真实执行阶段。
2. 可触达人数。
3. 选中人数。
4. 模板名。
5. 最近日志尾部。
6. 失败原因翻译。
7. “从第 N 批继续发送”按钮。
8. “只重跑 0 可触达以外的失败批次”按钮。

按钮建议：

- `发送 pending`
- `从此批继续`
- `重跑当前批`
- `标记已人工确认`
- `标记跳过`

### Phase E: 导入前预检

本轮发现 batch 7-10 邮箱列全空。

在上传拆分后，CRM 可以直接预检每个 batch：

```json
{
  "rowCount": 200,
  "handleCount": 200,
  "emailCount": 0,
  "likelyReachable": false
}
```

如果 `emailCount = 0`，前端提前标注：

```text
可能 0 可触达
```

这样不用等 ProBoost 上传后才知道。

但是否还能通过 handle 触达，需要根据 ProBoost 的实际规则确认。

### Phase F: 日志归档

现在日志在：

```text
reports/send-mail-runs/
```

建议每次上传任务建立自己的运行目录：

```text
reports/send-mail-runs/{campaign}/
  split.log
  batch-1.log
  batch-2.log
  run-summary.json
```

这样前端更容易读，人工也更容易追踪。

## 6. 后续执行建议

如果用户再给一批可发送的 `.xlsx`：

1. 打开审核台：

```text
http://127.0.0.1:8787
```

2. 上传 `.xlsx`。
3. 选择 batch size。
4. 输入模板名，例如：

```text
0414新规模板
```

或：

```text
0421三图模板
```

5. 点击 `连续有头发送 pending`。
6. 观察有头 Edge 是否正常从：

```text
达人推广 -> 指定达人 -> 上传 -> 选择达人 -> 去发邮件 -> 选择模板 -> 立即发送
```

循环到下一批。

如果出现 `可触达 0 位`：

- 该批跳过。
- 后续批次继续。

如果出现 `success-toast-not-found`：

- 不应马上判断为未发送。
- 应标记为“已确认发送但未复核到 toast”。

## 7. 需要回补的代码任务

后续可以排这些开发任务：

1. CRM 侧 batch 预检：读取 xlsx，统计邮箱列空值。
2. 前端展示 `emailCount` 和 `likelyReachable`。
3. 连续发送结果解析：把日志里的“已自动确认发送”解析为 `send-confirmed`。
4. 前端状态翻译：不要直接展示 send-mail 原始 `failed`。
5. 支持从指定 batch 继续：`BATCH_LIST=N,N+1,...`。
6. 支持手动标记 batch：confirmed / skipped / retry-needed。
7. 把 send-mail 的 zero-reachable patch 迁移进 CRM adapter，减少对原项目的修改。

## 8. 注意事项

- 不要并行启动多个使用同一个 `send-mail/.proboost-auth/default/edge-profile` 的 Edge。
- 如果出现 `ProcessSingleton`，先找占用进程：

```bash
ps -axo pid,ppid,command | rg '/Users/depp/send-mail/proboost-auto.js|send-mail/.proboost-auth/default/edge-profile'
```

- 如果要关闭残留自动化进程，只 kill `node /Users/depp/send-mail/proboost-auto.js` 的 PID。
- 不要 kill 用户正在使用的普通 Edge 主进程。
- 所有真实发送都要保持有头浏览器可见。
