/** Saves a blob as a file (an object URL, revoked once the download has started). */
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = window.document.createElement('a')
  a.href = url
  a.download = fileName
  window.document.body.append(a)
  a.click()
  a.remove()
  // Revoked a little later: some browsers read the URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
