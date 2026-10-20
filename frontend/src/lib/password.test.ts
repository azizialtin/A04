import { generatePassword, MIN_PASSWORD_LENGTH } from './password'

test('a generated password is long enough, unambiguous and fresh each time', () => {
  const a = generatePassword()
  const b = generatePassword()
  expect(a).toHaveLength(16)
  expect(a.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH)
  expect(a).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/)
  expect(a).not.toBe(b)
  expect(generatePassword(24)).toHaveLength(24)
})
