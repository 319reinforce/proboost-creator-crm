# ProBoost Creator CRM 完整开发方案

## 1. 项目定位

当前 `proboost-ready-reminder` 已经验证了一个关键闭环：

1. 导入已发送邀请码名单。
2. 导入已注册或已使用名单。
3. 找出未使用邀请码的达人。
4. 在 ProBoost 收件箱按 handle 搜索邮件。
5. 选择指定模板并真实发送提醒。
6. 在已发送中复核结果。
7. 生成可审计报告。

下一阶段建议把它升级成一个独立项目：`proboost-creator-crm`。

这个新项目的目标不是只替代一次脚本，而是成为一个长期运行的达人邮件运营系统。它需要持续登记达人回复、分析语义、管理邀请码和模板，并把自动发送控制在可复核、可追踪、可回滚的范围内。

## 2. 核心目标

### 2.1 业务目标

- 管理达人从收到邀请码到注册使用的完整链路。
- 自动识别哪些达人未使用邀请码，需要催促。
- 自动登记达人回复，并根据语义给出下一步动作建议。
- 支持将邀请码、handle、达人名等变量自动填充进模板。
- 对真实发信提供 dry-run、人工复核、发送上限、发送后验证。
- 输出每日运营报告，方便人工核对和转化复盘。

### 2.2 技术目标

- 把当前一次性脚本拆成可复用模块。
- 建立本地数据库作为事实来源。
- 将浏览器自动化、数据导入、语义分析、模板渲染、发送队列解耦。
- 提供一个轻量后台，用于查看、复核、手动发送和导出报告。
- 保留命令行能力，方便快速跑批。

## 3. 推荐技术栈

### 3.1 MVP 阶段

- Runtime: Node.js
- Browser automation: Playwright
- Database: SQLite
- ORM/query: better-sqlite3 或 Prisma
- Spreadsheet parsing: xlsx
- Web app: Next.js 或 Express + React
- LLM classification: OpenAI API 或可替换 provider
- Task runner: node-cron 或简单 CLI

### 3.2 后续增强

- Queue: BullMQ + Redis
- Database: PostgreSQL
- Auth: 账号密码或内部白名单
- Observability: structured logs + task run history
- Deployment: 本地 Mac mini / VPS / 内网机器

## 4. 项目结构

建议新项目结构：

```text
proboost-creator-crm/
  apps/
    web/
      src/
        app/
        components/
        routes/
    worker/
      src/
        jobs/
        cli/
  packages/
    db/
      migrations/
      src/
    importer/
      src/
    mail-automation/
      src/
    classifier/
      src/
    templates/
      src/
    reporting/
      src/
  data/
    imports/
    exports/
  reports/
  docs/
  package.json
```

如果先不做 monorepo，也可以在当前项目里按模块渐进：

```text
src/
  automation/
  importer/
  classifier/
  templates/
  db/
  reporting/
  cli/
docs/
```

## 5. 数据模型

### 5.1 creators

达人主表。

字段建议：

- `id`
- `handle`
- `display_name`
- `email_identity`
- `status`
- `source`
- `created_at`
- `updated_at`
- `last_seen_at`
- `notes`

推荐状态：

- `invited`
- `registered`
- `not_registered`
- `replied_ready`
- `replied_question`
- `replied_contact`
- `reminder_sent`
- `manual_review`
- `converted`
- `do_not_contact`

### 5.2 invite_codes

邀请码表。

字段建议：

- `id`
- `creator_id`
- `code`
- `campaign_id`
- `pushed_at`
- `registered_at`
- `status`
- `raw_source`

状态建议：

- `pushed`
- `used`
- `unused`
- `expired`
- `unknown`

### 5.3 mail_threads

邮件线程表。

字段建议：

- `id`
- `creator_id`
- `provider_thread_id`
- `mailbox`
- `subject`
- `sender`
- `recipient`
- `first_message_at`
- `last_message_at`
- `last_synced_at`
- `status`

### 5.4 mail_messages

邮件消息表。

字段建议：

- `id`
- `thread_id`
- `creator_id`
- `direction`
- `subject`
- `sender`
- `recipient`
- `body_text`
- `body_html`
- `sent_at`
- `received_at`
- `raw_snapshot_path`
- `created_at`

`direction`:

- `inbound`
- `outbound`

### 5.5 analysis_results

语义分析结果表。

字段建议：

- `id`
- `message_id`
- `creator_id`
- `intent`
- `confidence`
- `sentiment`
- `needs_invite_code`
- `has_contact`
- `contact_type`
- `contact_value`
- `recommended_action`
- `reason`
- `model`
- `prompt_version`
- `raw_json`
- `created_at`

### 5.6 templates

模板表。

字段建议：

- `id`
- `name`
- `purpose`
- `subject_template`
- `body_template`
- `version`
- `is_active`
- `created_at`
- `updated_at`

### 5.7 send_logs

真实发送记录表。

字段建议：

- `id`
- `creator_id`
- `thread_id`
- `template_id`
- `campaign_id`
- `subject_rendered`
- `body_rendered`
- `status`
- `dry_run`
- `sent_at`
- `verified_at`
- `error_message`
- `screenshot_path`
- `run_id`

状态建议：

- `drafted`
- `sent`
- `verified`
- `failed`
- `skipped`
- `manual_review`

### 5.8 manual_review_items

人工复核队列表。

字段建议：

- `id`
- `creator_id`
- `thread_id`
- `reason`
- `severity`
- `payload_json`
- `status`
- `assignee`
- `resolved_at`
- `created_at`

常见 reason：

- `not_found`
- `ambiguous_search_results`
- `low_confidence_analysis`
- `duplicate_thread`
- `send_verification_failed`
- `template_variable_missing`

## 6. 核心模块拆分

### 6.1 importer

职责：

- 读取 push 名单。
- 读取 ready 名单。
- 解析 handle 和邀请码。
- 合并重复记录。
- 写入 creators 和 invite_codes。
- 标记已注册和未注册状态。

接口示例：

```js
importPushList(filePath, campaignId)
importReadyList(filePath, campaignId)
computeUnusedInvites(campaignId)
```

验收标准：

- 能导入当前 `push/0428list` 和 `ready/0428ready`。
- 能正确识别重复 handle。
- 能输出未使用邀请码清单。
- 导入重复文件不会制造重复数据。

### 6.2 mail-automation

职责：

- 管理 ProBoost 登录状态。
- 进入收件箱、已发送、邮件详情和回复页面。
- 按 handle 搜索。
- 读取搜索结果。
- 打开指定邮件线程。
- 选择模板。
- 填充或覆盖模板变量。
- 点击发送。
- 处理确认弹窗。
- 在已发送中复核。

接口示例：

```js
searchInboxByHandle(handle)
openThread(searchResult)
replyWithTemplate(thread, renderedTemplate)
verifySent(handle, subjectKeyword)
```

验收标准：

- 支持 headed 模式，方便人工观察。
- 支持 dry-run。
- 多结果默认进入人工复核。
- `FORCE_AMBIGUOUS` 只允许在命令行显式开启。
- 发送后必须生成 `send_logs`。

### 6.3 classifier

职责：

- 对 inbound 邮件正文做语义分类。
- 抽取联系方式。
- 判断是否需要邀请码。
- 给出下一步动作建议。
- 对低置信度结果进入人工复核。

推荐输出：

```json
{
  "intent": "ready_to_use",
  "confidence": 0.92,
  "sentiment": "positive",
  "needs_invite_code": false,
  "has_contact": true,
  "contact_type": "whatsapp",
  "contact_value": "+1...",
  "recommended_action": "send_whatsapp_followup",
  "reason": "Creator replied ready and included contact information."
}
```

第一版 intent 枚举：

- `ready_to_use`
- `used_invite`
- `asks_for_code`
- `asks_for_help`
- `shares_contact`
- `not_interested`
- `price_or_payment_question`
- `confused`
- `bounce_or_auto_reply`
- `irrelevant`
- `unknown`

验收标准：

- 能对历史邮件样本批量分类。
- 每条分类结果保留原始 JSON。
- 置信度低于阈值进入人工复核。
- 不允许模型直接触发真实发送，只能产生建议。

### 6.4 templates

职责：

- 管理模板。
- 渲染变量。
- 检查缺失变量。
- 保存模板版本。
- 保存每次发送的最终正文快照。

变量建议：

- `${creator_name}`
- `${handle}`
- `${invite_code}`
- `${signup_link}`
- `${expires_in}`
- `${bonus_amount}`
- `${last_subject}`

接口示例：

```js
renderTemplate(templateName, variables)
validateTemplateVariables(template, variables)
createTemplateVersion(template)
```

验收标准：

- 可以把邀请码自动填进模板。
- 缺少变量时不能真实发送。
- 每次模板修改产生新版本。
- send log 保存最终渲染结果。

### 6.5 reporting

职责：

- 生成每日发送报告。
- 生成待人工复核清单。
- 生成未注册清单。
- 生成转化漏斗。
- 导出 CSV/JSON。

报告建议：

- 今日导入人数。
- 未使用邀请码人数。
- 今日发送提醒人数。
- 发送成功人数。
- 复核失败人数。
- 搜索不到人数。
- 多结果人数。
- 新回复人数。
- 语义分类分布。
- 转化人数。

## 7. 任务流设计

### 7.1 导入任务

输入：

- push 文件
- ready 文件
- campaign 名称

流程：

1. 解析 push 文件。
2. 解析 ready 文件。
3. upsert creator。
4. upsert invite code。
5. 标记 used / unused。
6. 生成导入报告。

命令示例：

```bash
npm run import -- --push data/imports/0428list --ready data/imports/0428ready --campaign 2026-04-28
```

### 7.2 收件箱同步任务

流程：

1. 打开 ProBoost 收件箱。
2. 按时间扫描新邮件。
3. 读取发件人、主题、时间、正文。
4. 根据 handle 关联 creator。
5. 新消息入库。
6. 调用 classifier。
7. 生成 recommended action。
8. 必要时进入人工复核。

命令示例：

```bash
npm run sync:inbox -- --since 2026-04-28
```

### 7.3 未注册提醒任务

流程：

1. 查询 unused invite creators。
2. 排除已发送过提醒且未到间隔的人。
3. 搜索收件箱线程。
4. 多结果或无结果进入人工复核。
5. 渲染模板。
6. dry-run 预览。
7. 真实发送。
8. 已发送复核。
9. 更新 send_logs 和 creator 状态。

命令示例：

```bash
npm run reminders -- --campaign 2026-04-28 --template "督促产品使用" --limit 20
```

### 7.4 人工复核任务

人工处理场景：

- 搜索不到。
- 搜索到多个精确结果。
- 模板变量缺失。
- 语义分类低置信度。
- 发送后复核失败。
- 达人回复内容复杂。

页面动作：

- 标记已处理。
- 绑定正确线程。
- 选择正确模板。
- 手动编辑正文。
- 确认发送。
- 标记不再联系。

## 8. Web 后台设计

### 8.1 首页 Dashboard

展示：

- 今日新回复。
- 今日待复核。
- 今日已发送。
- 未使用邀请码总数。
- 已注册人数。
- 转化率。
- 最近任务状态。

### 8.2 达人列表

筛选：

- campaign
- status
- has unused invite
- has reply
- needs review
- reminder sent
- registered

列：

- handle
- 邀请码
- 当前状态
- 最近来信
- 最近发送
- 推荐动作
- 置信度

### 8.3 达人详情

展示：

- 基础信息。
- 邀请码历史。
- 邮件线程。
- inbound/outbound 消息。
- 语义分析结果。
- 发送记录。
- 人工备注。

### 8.4 人工复核页

展示：

- 复核原因。
- 搜索结果候选。
- 邮件正文。
- 模型建议。
- 模板预览。
- 发送按钮。
- 跳过/不联系按钮。

### 8.5 模板管理页

能力：

- 创建模板。
- 修改模板。
- 查看变量。
- 预览渲染。
- 查看版本历史。
- 停用模板。

## 9. 安全发送策略

真实发信必须遵守：

- 默认 dry-run。
- 每次任务必须有 `limit`。
- 多结果默认不发。
- 搜索不到默认不发。
- 缺少邀请码默认不发。
- 模板变量未完全渲染默认不发。
- 同一 handle 一天内不能重复发送同类模板。
- 每封发送都保存最终正文。
- 每封发送后必须复核已发送。
- 失败进入人工复核。

建议配置：

```env
DRY_RUN=1
SEND_LIMIT=20
ALLOW_FORCE_AMBIGUOUS=0
MIN_CLASSIFICATION_CONFIDENCE=0.75
REMINDER_COOLDOWN_HOURS=48
KEEP_BROWSER_OPEN=0
```

## 10. 开发阶段规划

### Phase 0: 整理当前脚本

目标：把现有能力稳定下来，作为新项目的自动化参考实现。

任务：

- 给当前 `unused-invite-reminder.js` 补充参数文档。
- 固化报告格式。
- 整理 `TARGET_HANDLES`、`FORCE_AMBIGUOUS`、`DRY_RUN` 的使用说明。
- 增加运行命令 examples。
- 把已知异常场景写入文档。

验收：

- 新人能根据文档跑一次 dry-run。
- 新人能根据文档跑指定 handle。
- 新人能看懂报告文件。

### Phase 1: 数据库和导入

目标：建立事实来源。

任务：

- 初始化项目结构。
- 选择 SQLite 方案。
- 建立 migrations。
- 实现 creators、invite_codes、campaigns。
- 实现 push/ready 导入。
- 实现去重和状态计算。

验收：

- 可导入 0428 数据。
- 可查询未注册达人。
- 重复导入不会重复写入。
- 可导出未注册 CSV。

### Phase 2: 自动化模块封装

目标：把 Playwright 操作封装成稳定 API。

任务：

- 抽出登录状态管理。
- 抽出收件箱搜索。
- 抽出邮件详情读取。
- 抽出回复发送。
- 抽出已发送复核。
- 增加截图和错误快照。

验收：

- 可以通过 CLI 搜索一个 handle。
- 可以通过 CLI dry-run 一个 handle。
- 可以通过 CLI 真实发送一个 handle。
- 发送后生成 send_logs。

### Phase 3: 模板变量化

目标：让邀请码自动进入模板。

任务：

- 实现模板表。
- 实现模板渲染。
- 实现变量校验。
- 实现模板版本。
- 对接发送流程。

验收：

- 模板可包含 `${invite_code}`。
- 缺少邀请码时阻止发送。
- 每次发送保存最终正文。
- 可预览一批达人渲染后的邮件。

### Phase 4: 收件箱同步和回复登记

目标：不只发邮件，也登记达人回信。

任务：

- 扫描收件箱。
- 读取邮件详情。
- 根据 handle 关联达人。
- 写入 mail_threads 和 mail_messages。
- 识别新消息。
- 生成同步报告。

验收：

- 能同步当天收件箱。
- 同一邮件不会重复入库。
- 可查看达人最近回复。
- 搜索不到 handle 的消息进入人工复核。

### Phase 5: 语义分析

目标：自动分类达人回复。

任务：

- 设计 prompt。
- 实现结构化 JSON 输出。
- 实现置信度阈值。
- 抽取联系方式。
- 生成 recommended action。
- 低置信度进入人工复核。

验收：

- 能批量分析历史回复。
- 每条分析有 intent、confidence、reason。
- 人工可以看到模型建议。
- 模型不会直接触发真实发送。

### Phase 6: Web 后台 MVP

目标：让运营可以看、筛、复核、发送。

任务：

- Dashboard。
- 达人列表。
- 达人详情。
- 人工复核页。
- 发送预览页。
- 模板管理页基础版。

验收：

- 可以看到未注册达人。
- 可以看到达人回复。
- 可以查看模型分类。
- 可以人工确认发送。
- 可以查看发送结果。

### Phase 7: 运营策略自动化

目标：从工具变成半自动运营系统。

任务：

- 配置 reminder cooldown。
- 配置 campaign rules。
- 配置不同 intent 对应动作。
- 配置每日发送上限。
- 配置停止触达规则。
- 生成转化漏斗。

验收：

- 邀请 48 小时未使用可自动进入提醒队列。
- 回复 ready 可进入指定模板队列。
- 回复问题只生成草稿，不自动发送。
- 达人已注册后不再提醒。
- 可导出每日运营报告。

## 11. MVP 优先级

最小可落地版本建议只做：

1. SQLite 数据库。
2. push/ready 导入。
3. 未使用邀请码清单。
4. 模板变量渲染。
5. 指定 handle / 批量 handle 的 dry-run 和真实发送。
6. send_logs。
7. 人工复核 JSON/CSV 报告。

MVP 暂时不做：

- 完整 Web 后台。
- 自动定时任务。
- 复杂权限系统。
- 多邮箱账号。
- 完全自动语义回复。

这个 MVP 做完后，当前脚本就从一次性脚本升级为稳定批处理工具。

## 12. 第一版命令设计

建议保留 CLI，因为它适合运营临时跑批。

```bash
# 登录
npm run login

# 导入名单
npm run import -- --push data/imports/0428list --ready data/imports/0428ready --campaign 2026-04-28

# 查看未使用邀请码
npm run list:unused -- --campaign 2026-04-28

# 预览发送
npm run remind -- --campaign 2026-04-28 --template reminder-v1 --dry-run --limit 10

# 指定 handle 发送
npm run remind -- --handles melmel_6_,ms_alicia2live82 --template reminder-v1 --send

# 同步收件箱
npm run sync:inbox -- --since 2026-04-28

# 分析回复
npm run analyze:replies -- --since 2026-04-28

# 导出报告
npm run report -- --date 2026-04-28
```

## 13. 当前项目可复用资产

可以直接复用：

- `unused-invite-reminder.js` 里的 handle 搜索、模板选择、发送复核逻辑。
- `proboost-replied.js` 里的收件箱扫描和回复内容读取经验。
- `auth-config.js` 和 `save-proboost-auth.js` 的登录状态管理。
- `config.js` 的 ProBoost URL 和模板配置。
- `reports/` 里的报告结构作为第一版输出参考。
- `push/` 和 `ready/` 文件格式解析经验。

需要重构：

- 把浏览器点击细节从业务逻辑中拆出。
- 把文件报告升级为数据库。
- 把全局 env 参数整理成 CLI 参数和配置文件。
- 把模板选择和正文渲染拆开。
- 把“发送动作”和“发送决策”拆开。

## 14. 风险和处理方式

### 14.1 ProBoost 页面结构变化

风险：Ant Design class 或 DOM 结构变化会导致点击失败。

处理：

- 优先用文本、role、label 定位。
- 保留多 selector fallback。
- 失败时截图。
- 每个关键动作后做状态检查。

### 14.2 误发送

风险：多结果、变量错误、重复触达。

处理：

- 默认 dry-run。
- 多结果人工复核。
- 同 handle 同模板冷却时间。
- 每次发送前变量校验。
- 发送前保存预览。

### 14.3 语义误判

风险：LLM 分类错误导致错误动作。

处理：

- 第一版只给建议。
- 低置信度进入人工复核。
- 保留人工修正结果。
- 不让模型直接决定真实发送。

### 14.4 数据重复

风险：同一达人多邀请码、多邮件线程、多 handle 变体。

处理：

- handle 归一化。
- invite code 唯一约束。
- thread id 去重。
- 人工合并 creator。

## 15. 推荐里程碑

### Milestone 1: Stable CLI

交付：

- 数据库。
- 导入。
- 未注册计算。
- 模板渲染。
- 发送日志。
- 批量提醒 CLI。

### Milestone 2: Reply Intelligence

交付：

- 收件箱同步。
- 回复登记。
- 语义分类。
- 人工复核报告。

### Milestone 3: Operator Console

交付：

- Web Dashboard。
- 达人列表。
- 详情页。
- 复核页。
- 模板管理页。

### Milestone 4: Campaign Automation

交付：

- 运营规则。
- 自动队列。
- 冷却时间。
- 转化漏斗。
- 每日报告。

## 16. 下一步建议

建议下一步先做 `Milestone 1: Stable CLI`，不要立刻做 Web 后台。原因是当前最高价值仍然在稳定跑批和减少人工错误。

第一批开发任务可以这样排：

1. 创建新项目骨架或在当前项目下创建 `src/`。
2. 引入 SQLite。
3. 建表并实现 migration。
4. 把 push/ready 解析迁移到 importer。
5. 把未注册计算写入数据库。
6. 把模板渲染做成纯函数。
7. 把当前发送脚本改成读取数据库任务。
8. 输出 send_logs 和每日报告。

完成这一步后，再进入“回复登记 + 语义分析”。这样每层都有可用成果，不会陷入大而全的重写。
