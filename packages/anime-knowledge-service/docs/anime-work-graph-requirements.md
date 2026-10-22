# 动画作品图谱与 Event 关联：需求及实施规格

状态：**提案，供审核；不是当前已实现的 API／数据库契约**。对应产品故事见 [anime-work-graph-user-stories.md](anime-work-graph-user-stories.md)。本文描述目标行为，不授权执行迁移、重建索引或修改生产数据。

## 1. 目标与边界

### 目标

1. 将 Bangumi Archive 的多个动画 subject 组织成一个 KitaCon 展示用 Anime Work，TV 各季、剧场版和 OVA 合成一张作品卡。
2. 保留每个 subject 的精确身份、类型和原始关系，以支持首映、特定季／电影、声优角色等细节。
3. 将活动网站的证据与 KB 的人物、公司、角色、作品关系组合为**可解释的候选关联**，而不是凭履历创造活动事实。
4. 在现有 KitaCon 数据库中持久化经过确认、可编辑的作品资料与发布关系；KB Service 仍是独立的、无 KitaCon 数据库凭据的本地服务。

### 非目标

- 不把全部 Bangumi Archive 导入 Neon，也不引入新的数据库产品或图数据库。
- 不让 KB Service 直接写 KitaCon DB、发布 Event、决定图片使用权或推断嘉宾到场。
- 不把 `encodedId` 当主键；继续使用 `bangumi:<entityType>:<rawId>`，网站作品使用独立 UUID。
- 不用 LLM 猜测缺失的季、声优角色、职位、日期或活动参与事实。
- 不在第一版创建完整的跨媒体 IP／Franchise 分类系统；漫画、游戏、音乐可以是关系，不是 Anime Work 成员。

## 2. 当前基线与缺口

| 组件 | 现状 | 目标差异 |
| --- | --- | --- |
| `packages/anime-knowledge-service/src/kb/store.ts` | 索引 subject 名称、部分别名；加载 subject↔subject、subject↔person；其余可选 JSONL 仅复制 | 保留 `subject.platform`、`person.type`，加载角色及反向索引，解释关系／职位 |
| `packages/anime-knowledge-service/src/pipelines/event.ts` | 从活动字段检索 subject，LLM 输出语义 patch | 对精确作品／人物／公司／角色进行候选消歧，并返回显式证据路径；KB 不把职业关系升级为活动事实 |
| `packages/contracts/src/resolution-agent.ts` | `relatedSubjects` 以 Bangumi 精确条目为 target | 兼容保留精确 target，新增 work 级关联表示 |
| `core.entity` 等现有 Neon 表 | 有实体、外部引用、实体关系、人工 override、媒体 assignment、serving projection | 增加 Anime Work 专用成员／来源约束；不重绑既有 external reference |
| `event.related_subject` | 主键为 `(event_id, canonical_key)`，一季一条 | 无损保留；新增到 work 的映射和去重后的展示投影 |

当前 `bangumi-2026-10-06-aliasfix1` 快照确有 `subject-characters.jsonl`，但查询 store 未加载它；本地快照没有 `person-characters` 文件。因此「声优配某角色」第一版必须以新导入文件为条件，不能从已有边强推。

## 3. 术语和身份

| 概念 | 身份 | 含义 |
| --- | --- | --- |
| Bangumi Subject | `bangumi:subject:<rawId>` | 一季、一部电影、一个 OVA 等精确条目；Archive 的 `type=2` 才可能成为 Anime Work 成员 |
| Anime Work | KitaCon UUID，`core.entity.entity_type='ANIME_WORK'` | 网站上展示的一部动画；稳定于 Archive 导入版本之外 |
| Member | `(workId, subjectCanonicalKey)` | 精确条目属于某个展示作品，同时保留 TV／MOVIE／OVA／OTHER 类别和分组理由 |
| Event mention | 活动文档 ID、原文、页面位置、精确 target | 活动来源说了什么，与 KB 关系分开记录 |
| KB path | 版本＋边序列＋角色／职位 | 解释为什么某人或公司与某动画有关系；**不是**活动参与证据 |

一个 Bangumi subject 同一时刻最多属于一个已确认 Anime Work。一个 Anime Work 可有多个 subject。Bangumi person 的 `type=1/2/3` 分别代表个人、公司、组合；不要新增与 Bangumi 身份冲突的公司 ID 命名空间。Archive 的 `series` 字段不能用作动画聚合的充分条件。

## 4. 功能要求

### KB-01：版本化导入与图谱索引

- 继续使用 `imports/<version>/* + READY → immutable snapshot → active.json`，失败不能替换当前版本。
- `subject.jsonlines` 仍必需；现有 `subject-relations`、`subject-persons`、`subject-characters` 保持可选且统计缺失。新增可选 `person-characters`；支持 Archive 实际的连字符复数文件名与既有别名。
- 规范化保存 subject `id,type,name,name_cn,aliases,platform,date,summary,tags` 的可用子集；person `id,type,name,aliases,career`；character `id,role,name,aliases`。不要求把全部原始 infobox 长文本载入内存。
- 解析 `subject_relations.yml`、`subject_staffs.yml`、`subject_platforms.yml` 的**版本化映射**；未知编码保留原值并标记 `UNKNOWN`，不可默默赋义。
- 构建 subject↔subject、subject↔person、subject↔character、person↔character（文件存在时）的双向 ID 索引。查询不得为每个候选再线性遍历全部 69 万 subject。
- 索引 manifest 包括源文件计数、映射版本、schemaVersion、建造时间和缺失能力清单。旧 schemaVersion 快照必须继续可读或明确拒绝并指导重建；不可误按新格式解释旧数据。

### KB-02：谨慎生成作品分组建议

- 仅 `subject.type=2` 可成为 Anime Work 的动画成员。保留 `platform` 以区分 TV、剧场版、OVA、WEB、OTHER。
- 关系为续集／前传、总集篇／全集、番外或不同演绎时，可以提出同作品候选；仍需名称、版本类型与关系方向的冲突检查。无明确边但名称类似的记录仅可进入待审候选。
- 仅凭同名、共同声优／公司／角色、改编、同世界观、联动、独立衍生关系，**不得自动合并**。跨媒体原作不能作为动画成员。
- 一个候选组返回成员、精确 Bangumi IDs、关系路径、各项分数、冲突和 `reviewRequired`。分组建议不直接创建 KitaCon work ID。
- 不把整个关联图做无条件 connected-components：弱边可使不相关系列传递合并。限制路径长度与 fan-out，并使每条合并理由可解释。

### KB-03：人物、公司、角色检索

- 按名称／别名搜索人物、公司、组合、角色，允许按 `person.type` 过滤；精确 ID 查询及双向 `person→subjects`、`character→subjects`、`subject→people/characters`。
- 公司—作品返回精确职位代码、已解码标签及 subject，不混淆动画制作、出品、发行等职位。
- `person-characters` 存在时才返回「人物为具体作品角色配音」的确定路径；文件不存在时响应必须说明 `capabilityUnavailable`，不可用 `subject-persons` 替代声优—角色证明。
- 列表默认分页／上限；常用名称检索与反查使用索引，禁止向 LLM 倾倒整个关系邻域。

### KB-04：面向活动的关联建议

- 输入由 Resolution Agent 提供：活动候选、结构化 sessions／guests／exhibitors、命中的 `sourceDocumentIds` 与原文摘录；KB 本身不爬网站。
- 先用确定性检索识别明确作品／版本、人物、公司、角色；有歧义时返回多个候选或 `UNRESOLVED`，LLM 只能在提供的 ID 集合中消歧，不能创造新 ID／活动事实。
- 每个建议分别带：精确命中 target、可选 work 候选、来源文档、KB 路径、KB 版本、推断方法、置信度、状态 `DIRECT_EVIDENCE | REVIEW_REQUIRED | CONTEXT_ONLY`。
- `DIRECT_EVIDENCE` 仍是「可提交审核的活动来源支持」而非自动发布指令。单独的公司／声优出场，最多产生 `CONTEXT_ONLY` 的作品履历，**不能**批量生成 `DIRECT_EVIDENCE`。
- 只有活动资料明确提及作品，或明确角色／版本并能通过无歧义 KB 路径追溯时，才可建议公开的活动—作品关系；后一种情况必须人工确认。
- 同一活动的多个具体 subject 聚合为同一 work 时，UI 只展示一张卡，同时保留全部 matched subjects 和来源文档。电影首映等版本专属描述必须留在该 session，不上升为整部动画通用事实。

### KB-05：KitaCon 作品资料及字段策略

- 最小公开资料：稳定 work ID、标题、别名、简介、首个发行年份、成员版本、适用的标签、封面和相关活动；后续可增加制作公司／职位、主要角色、声优及官方链接。
- 每个字段保存 `value, origin, sourceRef, knowledgeVersion, updatedAt, editorialMode` 中适用的信息；外部资料与人工编辑不能混成无来源 JSON。
- 字段优先级：`PINNED` 人工值 > 已审核来源 > 当前 KB 建议；缺失字段保持空，不由 LLM 补写。KB 版本变化产生差异建议，不覆盖 PINNED。
- media 使用现有 `media.asset`／`media.assignment`；仅权利状态允许公开展示的图片可进公开作品卡。Bangumi 图片 URL 不能因为可访问就默认有再发布权。
- 首播年不等于每个版本年份；成员详情保留各自日期。分组标题可人工选择，不能只凭最早 subject ID。

### KB-06：审核、修订与审计

- 编辑界面能搜索 Anime Work 和精确 subject、审查组成员、接受／移除／拆分／合并建议、手工建立活动关联或拒绝误关联。
- 发布前显示活动文档摘录、KB 路径、版本与可能的歧义；拒绝关系也需记录，以免下次重新推荐。
- 分组和字段决策写入现有 Neon，并使用现有权限体系与审计日志；KB Service 不能直接操作这些表。
- 新快照激活后生成增量差异：新增／消失 subject、关系变化、建议分组变化、字段变化。已发布 work ID、人工锁定字段和人工拒绝记录保持稳定。

## 5. 建议 API 契约（目标版，不是已上线接口）

现有 `/v1/search/subjects`、`/v1/search/people`、`/v1/subjects/:id`、`/v1/people/:id` 和 `/v1/resolve/event` 保持兼容。新查询沿用现有 Bearer token、输入上限、`knowledgeVersion` 和只读边界。

### `POST /v1/graph/search`

输入：`{ "queries": ["动画工坊"], "kinds": ["PERSON","COMPANY","CHARACTER","ANIME_SUBJECT"], "limit": 10 }`。输出：`{ "knowledgeVersion": "...", "matches": [{ "reference": {"canonicalKey":"bangumi:person:..."}, "kind":"COMPANY", "name":"...", "score":0.98 }] }`。kind 从已导入类型得出，不能由字符串名称猜测。

### `GET /v1/graph/subjects/:rawId`

输出精确 subject、平台／日期、经编码映射解释的邻接关系，以及有上限的人员／角色列表。参数支持 `include` 与 `limit`，默认不展开多跳整图。

### `GET /v1/graph/people/:rawId/subjects` 与 `GET /v1/graph/characters/:rawId/subjects`

输出分页的反向边及职位／角色类型、`knowledgeVersion`；人物查询可按 `position` 过滤。缺失导入文件时返回明确的 capability 状态，不返回貌似完整的空列表。

### `POST /v1/resolve/anime-work`

输入：`{ "subjectKeys": ["bangumi:subject:<id>"], "maxDepth": 2 }`。输出：`{ "knowledgeVersion":"...", "proposals":[{"provisionalKey":"...", "members":[{"subjectKey":"...", "format":"TV|MOVIE|OVA|WEB|OTHER", "reasonPath":[]}], "conflicts":[], "reviewRequired":true}] }`。`provisionalKey` 只在该 KB 版本内用于候选去重，**不是**网站稳定 ID。

### `POST /v1/resolve/event-associations`

输入：有界的 event mention 列表，每项包含 `sourceDocumentId`、原文、来自 session／guest／exhibitor 的 `externalKey`；输出有界建议列表：`matchedSubjectKeys`、`personKeys`、`companyKeys`、`characterKeys`、`kbPaths`、`evidenceDocumentIds`、`classification`、`warnings`、`knowledgeVersion`。此接口只建议，不保存或发布。与既有 `/v1/resolve/event` 的整包 enrichment 可在实现时复用同一内部逻辑，避免双重模型调用。

### KitaCon 内部接口

在现有 Console 权限下提供作品分组审核、作品资料编辑、活动关系审核 API；不通过 Knowledge Service 对外提供写接口。读侧以既有 `serving.entity_document`／Event 投影为准。具体路由命名与现有 API 风格保持一致，实施前定版 OpenAPI/Zod 契约。

## 6. 建议持久化与兼容迁移

1. 复用 `core.entity` 创建 `ANIME_WORK` 实体；`core.entity_text` 存多语言名称／别名，`admin.manual_override` 和 `admin.audit_log` 存人工决策，`media.assignment` 连接合规作品图片。
2. 新增专用 `core.anime_work_member`（最终表名以迁移为准）：`work_entity_id`、`subject_canonical_key`、`subject_raw_id`、`format`、`membership_status`、`decision_origin`、`knowledge_version`、`reason_path jsonb`、`reviewed_by/at`、时间戳。活动成员唯一约束在已确认记录上，确保一个精确 subject 不同时属于两个已确认作品。
3. 新增作品资料存储：常用可检索字段为列或 `core.entity`／`core.entity_text`；扩展展示字段可用版本化 JSONB，但必须有字段级来源与 override 记录。必要时新建小型 `core.anime_work_profile`，不要将整份 Archive subject 放进一个无来源 blob。
4. 保留 `core.external_reference` 现有记录及其唯一约束，不强行把已链接到独立 entity 的 Bangumi ID 重绑到 work；成员表建立映射。
5. 保留 `event.related_subject` 的原始精确关联，新增 work 级关联（可用 `event.event_entity` 的明确 relation type 加证据明细表）。read projection 按 work 去重，老数据仍可通过精确 subject 查到。
6. 迁移分为 additive schema → 只读 backfill／差异预览 → 审核映射 → 双读验证 → 展示切换；不删除旧列、不重写历史 Event。回滚先切回旧投影而不是执行破坏性 SQL。

## 7. 端到端流程与判定规则

```text
Archive JSONL + READY
  → KB 快照：标准化字段、解码关系、构建双向索引
  → KB 生成 Anime Work 分组候选
  → KitaCon 编辑确认 → 现有 Neon 保存稳定 work ID／字段／成员

Crawler 文档（活动证据）
  → Resolution Agent 抽取结构化 mention
  → KB 识别精确 subject/person/company/character，并解释图路径
  → KitaCon Candidate 审核活动关联
  → Event 投影按 work ID 展示一张卡，细节保留精确版本和证据
```

证据分级：

| 级别 | 典型输入 | 默认处理 |
| --- | --- | --- |
| `DIRECT_EVIDENCE` | 活动官方 session 明确提到动画／电影标题 | 生成可审核关联；精确 subject 追踪 |
| `REVIEW_REQUIRED` | 活动提到独特角色，KB 可唯一追溯到动画；或标题存在歧义 | 编辑确认前不公开 |
| `CONTEXT_ONLY` | 声优／公司参加活动，但动画只出现在其 Bangumi 履历里 | 仅内部探索，不生成公开关联 |
| `UNRESOLVED` | 同名／缺失 KB 文件／未知关系代码／无活动文档 | 显示原因，不臆造结果 |

人工已确认关系可以公开；纯 KB 职业图不能单独提高为活动事实。LLM 只负责有界候选之间的语义消歧与说明文字，不负责创建主键、发明关系边、扩大证据范围或代替审核。

## 8. 非功能要求

- 尽量使用现有 Node.js/TypeScript 包、Zod 契约、版本化 JSONL 快照和现有 Neon；不要求新语言／图数据库。
- Knowledge Service 默认 loopback，外部绑定继续要求 token；不获得 Neon、R2 或 KitaCon 管理凭据。
- 结果有界、分页、可重复；同一快照和相同输入得到稳定候选排序。每次响应显式带 `knowledgeVersion` 和所依赖的能力／文件状态。
- 索引和反查必须适配现有约 69 万 subject、221 万 subject-person 边和 45 万 subject-character 边，并与本地 Ollama 一起在 M4/24GB 运行；实现阶段记录冷导入耗时、常驻内存、查询 p95 和超时，不允许请求时逐候选扫描全库。
- 不能将数据库写入或重新导入作为 `GET` 副作用。快照失败、模型不可用或 KB 不可用时，保留既有公开作品页和已发布关系，不自动清空。
- 字段与关系必须可追溯、可审核、可撤销；按现有 Console 权限控制写操作。多来源冲突产生待审差异而非静默覆盖。

## 9. 测试与完成标准

1. 合成 fixture 的第一季、第二季、剧场版、OVA → 一个 work、四个精确成员；活动提及剧场版时列表一张卡，详情仍显示剧场版。
2. 漫画原作、仅同世界观、联动、同名无关、独立衍生 → 不自动并入动画 work；冲突可供审核。
3. 公司或声优参加活动但活动来源未点名作品 → 不公开任何「其全部作品」；明确作品 session → 可追溯关系建议。
4. 具有 `person-characters` 时输出声优—角色—具体 subject 路径；没有该文件时报告能力缺失，绝不伪造配音关系。
5. Archive 新版增加／删改关系 → 审核差异可见，已发布 work ID 与 PINNED 字段不变；失败导入不替换 active snapshot。
6. 旧 `event.related_subject` 和手工 Event Bundle 不丢失；增量回填、双读与回滚测试通过。
7. 对同一输入重复查询结果稳定，API 验证非法 IDs、超大查询、过深图遍历和未授权访问。
8. 在真实本地快照＋Ollama 并存条件下完成导入、名称搜索、反查与活动关联的性能测试，结果记录在运行文档。

## 10. 建议交付顺序

1. **M1：只读图谱**——补字段、角色／人物反向索引、编码映射、查询 API、测试；不改 Event 页面。
2. **M2：作品聚合**——分组建议、审核 UI、`ANIME_WORK`/member 持久化、作品字段和 serving projection；旧链接兼容。
3. **M3：活动关联**——Resolution Agent 候选消歧、证据分级、Candidate 审核、Event 去重展示、迁移回填。
4. **M4：质量与运维**——真实样本误关联测试、版本差异审查、性能／内存指标、回滚演练。

## 11. 实施前仍需定版的选择

- 「独立衍生作」是否永远单独成卡？本提案默认单独，编辑可合组。
- 无 Bangumi ID 的新作是否在 M2 允许手动建卡？建议允许，以免 Archive 更新滞后；不是 M1 阻塞项。
- 哪些已审核活动关联可在以后自动发布？本提案第一版一律经 Candidate／编辑审核，后续按误关联率再调整。
