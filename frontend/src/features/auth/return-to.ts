/** Only same-app paths are allowed as return targets, never other origins. */
export function safeReturnTo(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/'
}
