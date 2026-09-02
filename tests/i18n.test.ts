import { describe, it, expect, vi, afterEach } from 'vitest'
import { lookup, interpolate } from '@shared/locales'
import zh from '@shared/locales/zh-CN'
import en from '@shared/locales/en'
import { t, setLocale } from '../src/i18n'
import { detectSystemLocale } from '../src/state/locale'

describe('i18n core', () => {
  it('lookup returns the exact value for each locale', () => {
    const key = 'home.title.line1'
    expect(lookup('zh-CN', key)).toBe(zh[key])
    expect(lookup('en', key)).toBe(en[key])
  })

  it('lookup falls back to the key itself when unknown', () => {
    const missing = 'this.key.does.not.exist'
    expect(lookup('zh-CN', missing)).toBe(missing)
    expect(lookup('en', missing)).toBe(missing)
  })

  it('interpolate replaces {var} and leaves unknown vars intact', () => {
    expect(interpolate('已跳过 {count} 个空行。', { count: 3 })).toBe('已跳过 3 个空行。')
    expect(interpolate('no vars')).toBe('no vars')
    expect(interpolate('{x}', {})).toBe('{x}')
  })
})

describe('t()', () => {
  afterEach(() => setLocale('zh-CN'))

  it('uses the current module locale and switches with setLocale', () => {
    setLocale('zh-CN')
    expect(t('home.title.line1')).toBe(zh['home.title.line1'])
    setLocale('en')
    expect(t('home.title.line1')).toBe(en['home.title.line1'])
  })

  it('returns the key itself when the key is missing', () => {
    expect(t('totally.missing.key')).toBe('totally.missing.key')
  })

  it('interpolates vars', () => {
    setLocale('zh-CN')
    expect(t('warn.PARSE_SKIPPED_BLANKS', { count: 3 })).toContain('3')
    setLocale('en')
    expect(t('warn.PARSE_SKIPPED_BLANKS', { count: 3 })).toContain('3')
  })
})

describe('dictionary parity', () => {
  it('zh-CN and en share the exact same key set', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('every en value is translated (non-empty)', () => {
    for (const k of Object.keys(zh) as Array<keyof typeof en>) {
      expect(en[k], `en translation missing/empty for ${k}`).not.toBe('')
    }
  })
})

describe('detectSystemLocale', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('zh* language → zh-CN', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(detectSystemLocale()).toBe('zh-CN')
  })

  it('non-zh language → en', () => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(detectSystemLocale()).toBe('en')
  })
})
