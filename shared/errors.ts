/**
 * 面向用户的错误码与警告码。
 *
 * 为什么要有这层：界面上每一条中文都要能翻成英文，而「按文案做控制流」会在翻译后静默失效 ——
 * 最严重的一处是"目标文件已存在"的守卫靠 `message.startsWith('这个位置')` 判断，
 * 文案一变就变成 false，直接落到 writeFile 覆盖用户文件（违反红线一）。
 * 所以判断一律用码，文案只在最后一步显示时才生成。
 *
 * 为什么码要编码进 message：主进程抛出的错误要跨 IPC 到渲染进程才能显示，而 Electron 只保证
 * `message` 一定到达，Error 子类与自定义属性（code / params）不保证。统一走 encode / decode
 * 这一对函数，将来 Electron 行为变了只改这两处。
 */

export type Vars = Record<string, string | number>

export type ErrorCode =
  // 打开源文件
  | 'PATH_NOT_FILE'
  | 'FILE_TOO_LARGE'
  | 'PARSE_JSON_FAILED'
  | 'PARSE_YAML_FAILED'
  | 'PARSE_YAML_EMPTY'
  | 'PARSE_UNSUPPORTED_FORMAT'
  // 会话
  | 'INVALID_SESSION_ID'
  | 'SESSION_EXPIRED'
  // 新建数据集（红线守卫）
  | 'FILE_EXISTS'
  | 'DEST_IN_SESSIONS_DIR'
  // 导出（红线守卫 + 配置校验）
  | 'EXPORT_TO_SOURCE'
  | 'EXPORT_TO_SESSIONS_DIR'
  | 'EXPORT_NO_COLUMN'
  | 'EXPORT_COLUMN_EMPTY'
  | 'EXPORT_COLUMN_DUPLICATE'
  | 'EXPORT_DELIMITER_EMPTY'
  // 替换
  | 'REPLACE_FIND_EMPTY'
  | 'REPLACE_REGEX_INVALID'

export type WarningCode =
  // 解析期
  | 'PARSE_TOP_LEVEL_DICT'
  | 'PARSE_WRAPPED'
  | 'PARSE_TRUNCATED'
  | 'PARSE_NO_RECORDS'
  | 'PARSE_EMPTY_FILE'
  | 'PARSE_JSONL_FALLBACK_TXT'
  | 'PARSE_JSONL_BAD_LINES'
  | 'PARSE_DELIMITED_ERRORS'
  | 'PARSE_DUPLICATE_HEADERS'
  | 'PARSE_HEADER_ONLY'
  | 'PARSE_YAML_MULTI_DOC'
  | 'PARSE_SKIPPED_BLANKS'
  | 'PARSE_TXT_MODE'
  // 打开会话时与主进程状态相关的提示
  | 'SESSION_EDITS_DROPPED'
  | 'SESSION_DELETES_CLEARED'

export interface Warning {
  code: WarningCode
  params?: Vars
}

const PREFIX = 'CE:'

/** 带错误码的错误。code 同时挂在实例上，方便主进程内部与单测直接读。 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly params?: Vars

  constructor(code: ErrorCode, params?: Vars) {
    super(encodeError(code, params))
    this.name = 'AppError'
    this.code = code
    this.params = params
  }
}

export function appError(code: ErrorCode, params?: Vars): AppError {
  return new AppError(code, params)
}

function encodeError(code: ErrorCode, params?: Vars): string {
  if (!params || Object.keys(params).length === 0) return `${PREFIX}${code}`
  return `${PREFIX}${code}\t${JSON.stringify(params)}`
}

export interface ErrorPayload {
  code: ErrorCode
  params?: Vars
}

/**
 * 从任意抛出的东西里取回错误码。
 * 优先读实例属性（同进程调用时最快），读不到再解 message —— 跨 IPC 后只剩 message。
 */
export function decodeError(err: unknown): ErrorPayload | null {
  if (!err) return null
  const e = err as { code?: unknown; params?: Vars; message?: unknown }
  if (typeof e.code === 'string' && isErrorCode(e.code)) {
    return { code: e.code, params: e.params }
  }
  if (typeof e.message !== 'string') return null
  return parseEncoded(e.message)
}

function parseEncoded(message: string): ErrorPayload | null {
  if (!message.startsWith(PREFIX)) return null
  const rest = message.slice(PREFIX.length)
  const tab = rest.indexOf('\t')
  const code = tab < 0 ? rest : rest.slice(0, tab)
  if (!isErrorCode(code)) return null
  if (tab < 0) return { code }
  try {
    const params = JSON.parse(rest.slice(tab + 1)) as Vars
    return { code, params }
  } catch {
    return { code }
  }
}

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'PATH_NOT_FILE',
  'FILE_TOO_LARGE',
  'PARSE_JSON_FAILED',
  'PARSE_YAML_FAILED',
  'PARSE_YAML_EMPTY',
  'PARSE_UNSUPPORTED_FORMAT',
  'INVALID_SESSION_ID',
  'SESSION_EXPIRED',
  'FILE_EXISTS',
  'DEST_IN_SESSIONS_DIR',
  'EXPORT_TO_SOURCE',
  'EXPORT_TO_SESSIONS_DIR',
  'EXPORT_NO_COLUMN',
  'EXPORT_COLUMN_EMPTY',
  'EXPORT_COLUMN_DUPLICATE',
  'EXPORT_DELIMITER_EMPTY',
  'REPLACE_FIND_EMPTY',
  'REPLACE_REGEX_INVALID'
])

function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODES.has(value)
}

/** 构造一条警告。params 只有真正要插值的才传。 */
export function warn(code: WarningCode, params?: Vars): Warning {
  return params ? { code, params } : { code }
}
