/** JSON 值的联合类型：可安全通过 IPC 与 JSON.stringify 传输的数据。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 指向记录内部某个值的路径，例如 ['messages', 2, 'content']。 */
export type Path = (string | number)[]

export interface DataRecord {
  /** 稳定记录 id，等于原始行下标（字符串形式）。新增记录的 id 与合并后位置一致。 */
  id: string
  /** 原始行下标，0 起。新增记录的 index 与合并后位置一致。 */
  index: number
  /** 归一化后的记录对象，保留字段原始顺序。 */
  data: Record<string, Json>
  /** 记录来源：源文件导入 vs 用户新增。渲染时用来显示「新建」徽章与禁用「还原」按钮。 */
  origin?: 'source' | 'new'
}

export type SourceFormat = 'jsonl' | 'json' | 'csv' | 'tsv' | 'yaml' | 'parquet' | 'txt'

export interface SourceMeta {
  path: string
  name: string
  ext: string
  size: number
  mtimeMs: number
  /** 首末各 256KB 内容 + 体积的 sha256，用于检测源文件是否被改动。 */
  fingerprint: string
  format: SourceFormat
}

/** 增量编辑补丁：recordId -> (pathKey -> 新值)。只保存被改动过的字段。 */
export type PatchMap = Record<string, Record<string, Json>>

/**
 * 列表筛选页签。
 * 'pending' 是「改了但还没定」，也就是老版本里的『已修改』——
 * 加了「已确认」之后这个名字会误导，所以改成『待确认』。
 */
export type FilterMode = 'all' | 'pending' | 'confirmed' | 'unmodified' | 'deleted'

export interface ViewState {
  selectedIndex: number
  scrollTop: number
  filter: FilterMode
  query: string
  /** 导出面板里被勾选的记录（scope = selected 时使用）。 */
  selectedIds: string[]
  /** 列表是否处于多选模式（供批量确认勾选）。退出后视图恢复原样。 */
  multiSelect?: boolean
}

export interface ExportColumn {
  id: string
  /** 输出列名。 */
  label: string
  /** 取值路径；null 表示空列（导出为 null / 空字符串）。 */
  path: Path | null
  enabled: boolean
}

export type ExportFormat = 'jsonl' | 'json' | 'csv' | 'parquet'

/** 'confirmed' = 已确认且未删除；确认后又被改动而退回待确认的不算。 */
export type ExportScope = 'all' | 'modified' | 'confirmed' | 'filtered' | 'selected'

export interface ExportConfig {
  format: ExportFormat
  columns: ExportColumn[]
  scope: ExportScope
  /** JSON 数组格式的缩进；0 / 2 / 4，null 表示紧凑输出（仅 jsonl / json）。 */
  indent: number | null
  delimiter: string
  /** 嵌套结构在 CSV / Parquet 中序列化为字符串时的缩进，null 表示紧凑。 */
  flattenIndent: number | null
  includeIndex: boolean
}

export interface SessionState {
  id: string
  source: SourceMeta
  edits: PatchMap
  deleted: number[]
  view: ViewState
  exportConfig: ExportConfig | null
  lastExportPath: string | null
  recordCount: number
  createdAt: number
  updatedAt: number
  appVersion: string
  /** 用户新增的记录。源文件里没有，按 pos 合并到源记录的序列里。 */
  added?: AddedRecord[]
  /** 已确认下标集合，与 edits 正交。空数组 / undefined = 无已确认。 */
  confirmed?: number[]
}

/** 用户新增的一条记录：pos 是它在合并序列里的最终位置。 */
export interface AddedRecord {
  pos: number
  data: Record<string, Json>
}

/**
 * 内置的新建记录模板。自定义模板存在 Settings 里，两份在界面上合并展示。
 *
 * 按「数据格式流派」分组：同一件事（比如多轮对话）在不同训练框架里字段名和键名都不同，
 * 分组能让用户按「我要训什么」而不是按「字段叫什么」去挑。
 *
 * ⚠️ id 是稳定标识（用户的自定义模板可能引用它），改名可以，改 id 不行。
 */
export const BUILTIN_TEMPLATES: RecordTemplate[] = [
  { id: 'blank', name: '空白', group: '通用', builtin: true, fields: [] },
  { id: 'text', name: '纯文本', group: '通用', builtin: true, fields: [{ name: 'text', kind: 'text' }] },

  {
    id: 'alpaca',
    name: 'Alpaca',
    group: '指令微调 · SFT',
    builtin: true,
    fields: [
      { name: 'instruction', kind: 'text' },
      { name: 'input', kind: 'text' },
      { name: 'output', kind: 'text' }
    ]
  },
  {
    id: 'alpaca-system',
    name: 'Alpaca · 带系统提示',
    group: '指令微调 · SFT',
    builtin: true,
    fields: [
      { name: 'system', kind: 'text' },
      { name: 'instruction', kind: 'text' },
      { name: 'input', kind: 'text' },
      { name: 'output', kind: 'text' }
    ]
  },
  {
    id: 'prompt-response',
    name: '提示 - 回复',
    group: '指令微调 · SFT',
    builtin: true,
    fields: [
      { name: 'prompt', kind: 'text' },
      { name: 'response', kind: 'text' }
    ]
  },

  {
    id: 'chat',
    name: 'ShareGPT · OpenAI 风格（role / content）',
    group: '多轮对话',
    builtin: true,
    fields: [{ name: 'messages', kind: 'messages', roleKey: 'role', contentKey: 'content' }]
  },
  {
    id: 'sharegpt',
    name: 'ShareGPT · from / value',
    group: '多轮对话',
    builtin: true,
    fields: [{ name: 'conversations', kind: 'messages', roleKey: 'from', contentKey: 'value' }]
  },
  {
    id: 'chat-system',
    name: '多轮对话 · 带系统提示',
    group: '多轮对话',
    builtin: true,
    fields: [
      { name: 'system', kind: 'text' },
      { name: 'messages', kind: 'messages', roleKey: 'role', contentKey: 'content' }
    ]
  },

  {
    id: 'dpo',
    name: 'DPO · 偏好对比',
    group: '偏好对比 · DPO',
    builtin: true,
    fields: [
      { name: 'prompt', kind: 'text' },
      { name: 'chosen', kind: 'text' },
      { name: 'rejected', kind: 'text' }
    ]
  },
  {
    id: 'dpo-system',
    name: 'DPO · 带系统提示',
    group: '偏好对比 · DPO',
    builtin: true,
    fields: [
      { name: 'system', kind: 'text' },
      { name: 'prompt', kind: 'text' },
      { name: 'chosen', kind: 'text' },
      { name: 'rejected', kind: 'text' }
    ]
  },

  {
    id: 'qa',
    name: '单轮问答',
    group: '问答',
    builtin: true,
    fields: [
      { name: 'question', kind: 'text' },
      { name: 'answer', kind: 'text' }
    ]
  }
]

/** 内置模板的展示顺序即 BUILTIN_TEMPLATES 的分组顺序。 */
export const TEMPLATE_GROUP_ORDER = [
  '通用',
  '指令微调 · SFT',
  '多轮对话',
  '偏好对比 · DPO',
  '问答'
]

export interface SessionSummary {
  id: string
  sourcePath: string
  sourceName: string
  format: SourceFormat
  recordCount: number
  modifiedCount: number
  deletedCount: number
  addedCount: number
  confirmedCount: number
  createdAt: number
  updatedAt: number
  /** 源文件当前的体积/指纹是否与会话记录一致。 */
  sourceIntact: boolean
  sourceMissing: boolean
}

/** 新建记录时用的字段骨架。kind 决定空值长什么样，对话类能直接给出 role/content 骨架。 */
export type TemplateFieldKind = 'text' | 'messages' | 'json'

export interface TemplateField {
  name: string
  kind: TemplateFieldKind
  /**
   * 对话字段的角色 / 内容键名，默认 role / content。
   * ShareGPT 的 from / value 风格要显式写成 from / value，
   * 否则新建出来的记录会和数据集里已有的记录结构对不上。
   */
  roleKey?: string
  contentKey?: string
  /** 新建记录时预填的默认值；省略表示留空。 */
  default?: Json
}

export interface RecordTemplate {
  id: string
  name: string
  /** 界面分组标签。内置模板才有；用户自定义模板统一归到「我的模板」。 */
  group?: string
  /** 内置模板为 true，不允许删除。 */
  builtin?: boolean
  fields: TemplateField[]
}

export interface Settings {
  theme: 'light' | 'dark' | 'system'
  locale: 'zh-CN'
  lastOpenDir: string | null
  recentSessionIds: string[]
  /** 用户自定义的新建记录模板。内置模板不落盘，避免升级后新旧两份打架。 */
  recordTemplates?: RecordTemplate[]
}

export interface OpenResult {
  sessionId: string
  source: SourceMeta
  recordCount: number
  fieldOrder: string[]
  warnings: string[]
  /** 恢复会话时回填的编辑与删除状态。 */
  edits: PatchMap
  deleted: number[]
  view: ViewState | null
  exportConfig: ExportConfig | null
  lastExportPath: string | null
  /** 恢复会话时源文件与快照不一致的提示。 */
  resumed: boolean
  sourceChanged: boolean
  /** 新增记录，源文件里没有。 */
  added?: AddedRecord[]
  /** 已确认下标集合。 */
  confirmed?: number[]
}

export type ReplaceTarget =
  | { type: 'everything' }
  | { type: 'field'; field: string }
  | { type: 'role'; field: string; role: string }

export interface ReplaceOptions {
  find: string
  replace: string
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
}

export interface ReplaceSample {
  recordId: string
  recordIndex: number
  pathKey: string
  pathLabel: string
  before: string
  after: string
}

export interface ReplacePlan {
  matchCount: number
  affectedRecords: number
  samples: ReplaceSample[]
  patch: PatchMap
  inverse: PatchMap
}

export interface ExportResult {
  destPath: string
  recordCount: number
  bytes: number
}

/** 一次操作对某个「下标集合」造成的增删。撤销时 add 与 remove 对调即得到反向操作。 */
export interface IndexDelta {
  /** 正向操作要加入集合的下标 */
  add: number[]
  /** 正向操作要从集合移除的下标 */
  remove: number[]
}

/** 删除标记集合专用别名，保持老调用点的可读性。 */
export type DeletedDelta = IndexDelta

export interface HistoryEntry {
  label: string
  forward: PatchMap
  inverse: PatchMap
  /**
   * 需要「整条替换」而不是合并的记录 id。
   * 增删对话轮次会改变数组下标，必须整体重写该记录的补丁条目。
   */
  replace?: string[]
  /** 删除标记的变更（删除 / 恢复整条记录）。 */
  deleted?: IndexDelta
  /** 确认状态的变更（确认 / 退回确认），与 deleted 完全同构。 */
  confirmed?: IndexDelta
  /**
   * 新增一条记录。撤销时按 pos 反向平移并把它从 added 里摘掉；
   * 重做时再插回去。撤销栈的整体平移要跳过带这个字段的 entry 自身。
   */
  added?: AddedRecord
}
