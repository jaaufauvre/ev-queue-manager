import { describe, expect, it, jest } from '@jest/globals'

jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  WASocket: jest.fn(),
  useMultiFileAuthState: jest.fn(),
  fetchLatestWaWebVersion: jest.fn(),
  Browsers: { macOS: jest.fn(() => ({})) },
  WAMessage: class {},
  MessageUpsertType: {},
  proto: {},
}))

import { hasValidNote, extractNote } from '../src'

describe('hasValidNote', () => {
  it('accepts common single-line notes', () => {
    ;['/j', '/join', '/n', '/note'].forEach((c) => {
      expect(hasValidNote(`${c} In bay 36, 11kW only (basement)`)).toBe(true)
    })
  })

  it('accepts empty notes', () => {
    ;['/j', '/join', '/n', '/note'].forEach((c) => {
      expect(hasValidNote(`${c}`)).toBe(true)
    })
  })

  it('rejects / and @ characters', () => {
    ;['/j', '/join', '/n', '/note'].forEach((c) => {
      expect(hasValidNote(`${c} note/with-slash`)).toBe(false)
      expect(hasValidNote(`${c} note@mention`)).toBe(false)
    })
  })

  it('rejects ~, _, *, and ` characters', () => {
    ;['/j', '/join', '/n', '/note'].forEach((c) => {
      expect(hasValidNote(`${c} note~with~tilde`)).toBe(false)
      expect(hasValidNote(`${c} note_with_underscore`)).toBe(false)
      expect(hasValidNote(`${c} note*with*asterisk`)).toBe(false)
      expect(hasValidNote(`${c} note\`with\`backtick`)).toBe(false)
    })
  })

  it('rejects multiline notes', () => {
    ;['/j', '/join', '/n', '/note'].forEach((c) => {
      expect(hasValidNote(`${c} first line\nsecond line`)).toBe(false)
    })
  })

  it('rejects command not supporting notes', () => {
    expect(hasValidNote('/check note')).toBe(false)
  })

  it('rejects notes longer than 80 characters', () => {
    ;['/j', '/join', '/n', '/note'].forEach((c) => {
      const longNote = 'a'.repeat(81)
      expect(hasValidNote(`${c} ${longNote}`)).toBe(false)
    })
  })
})

describe('extractNote', () => {
  it('extracts a note from join and note commands', () => {
    ;['/j', '/join', '/n', '/note'].forEach((c) => {
      expect(extractNote(`${c} note`)).toBe('note')
    })
  })

  it('returns undefined when command not supporting notes', () => {
    expect(extractNote('/check note')).toBeUndefined()
  })

  it('trims notes', () => {
    ;['/j', '/join', '/n', '/note'].forEach((c) => {
      expect(extractNote(`${c}    note   `)).toBe('note')
    })
  })

  it('extracts unicode notes', () => {
    ;['/j', '/join', '/n', '/note'].forEach((c) => {
      expect(extractNote(`${c} 🌞`)).toBe('🌞')
    })
  })

  it('returns undefined when the command has no note', () => {
    ;['/j', '/join', '/n', '/note'].forEach((c) => {
      expect(extractNote(`${c}`)).toBeUndefined()
    })
  })

  it('truncates the note if too long', () => {
    ;['/j', '/join', '/n', '/note'].forEach((c) => {
      expect(
        extractNote(
          `${c} This is a relatively long note 👋🌍🔥. Should keep the first 40 chars.`,
        ),
      ).toBe('This is a relatively long note 👋🌍🔥. Shou…')
    })
  })
})
