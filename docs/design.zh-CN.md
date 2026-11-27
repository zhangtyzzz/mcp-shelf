# MCP Shelf · 设计说明

## 为什么只给 Agent 三种操作

把几十个 MCP Server 展平，仍会把所有工具的 Schema 塞进 Agent；它只是少了连接数。这里把**发现、读取详情、执行**分开，像 Skill 一样按需展开：模型开始只拿三个元工具，需要时才拿某个工具的完整 Schema。代价通常是多一两次工具往返，且词法搜索不能保证召回。

```text
Codex / Claude Code / Google Antigravity
               │ 各注册 1 个 Server
               ▼
      stdio Bridge 或 Streamable HTTP
               │
      MCP Shelf（本机环回地址）
         ├── list_mcps    连接与名称预览
         ├── search_tool  搜索候选 / 按 ID 开 Schema
         └── call_tool    白名单 → 参数校验 → 调用
               │
        本地 stdio / 远程 Streamable HTTP
```

管理台和 Agent 使用同一目录、路由和权限。元工具名称保持稳定；允许控制描述。上游工具用“连接 ID/原始名称”隔离同名冲突。编辑上游工具描述可补充中文关键词，改描述不改变 Schema 或权限。

## 合同与约束

- `list_mcps({server_id?,offset?,limit?})` 按连接分页，每个连接展示最多 12 个已开放的工具 ID。三个元工具的描述及 MCP `initialize.instructions` 会自动附带精简服务摘要（`- <id> (<N> tools): <description>`），让模型开局即可感知已挂载服务。没有授权的连接不会被 Agent 侧请求提前启动；管理台可手动刷新。
- `search_tool({query?,server_id?,tool_id?,include_schema?,offset?,limit?})` 按 ID、名称、连接名及描述匹配（支持 CJK 二元切词兜底）；默认直接随命中结果返回完整输入/输出 Schema 及通用调用提示 `how_to_call`（传 `include_schema: false` 可仅返回轻量摘要），省掉额外一次取 Schema 往返。
- `call_tool({tool_id,arguments?})` 只允许已启用、已授权的 ID，通过本机 JSON Schema 校验后调用一次。上游文本与结构化内容按协议传递。输入 HTTP 请求限制 1 MiB，上游回包在接收后限制 512 KB，不自动重试；超时不证明写操作未执行。
- 连接发现 12 秒、调用 30 秒；目录为 60 秒内存缓存，页面可显式刷新。初始实现不转发目录变化通知；客户端若缓存元工具描述，需重新连接。
- 默认只绑定 IPv4 loopback。单机信任模型、共享白名单；不能当公网认证层。工具权限不接受来自 Agent 或上游文案的改写。编辑上游进程、URL 或凭据变量名后清除旧授权。

## 界面

采用目录、设置分区以及渐进展开：连接状态和动作一眼可见，较长的 Schema 仅在具体工具下展开。参考 [Docker Dynamic MCP](https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/) 的按需发现思路，这里不让模型安装、启用或配置上游。

## 后续优先级

先用三家客户端验证真实对话和权限确认，再做连接模板、配置备份、分组和本机调用记录。要跨机器或多用户，先做独立 token 和每个客户端的规则；要防同名工具升级后行为漂移，先做 Schema/版本变更后重新确认。暂不支持 OAuth 中继、旧式独立 SSE、上游 prompt/resource 管理，也暂不加入语义搜索。
