import { expect, test } from "bun:test"
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readClipboard } from "./clipboard"

test("pasted image paths preserve MIME and base64 across supported extensions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pasode-attachment-test-"))
  try {
    for (const [extension, mimeType] of [["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"]] as const) {
      await writeFile(path.join(directory, `image.${extension}`), "bytes")
      expect(await readClipboard(`image.${extension}`, directory)).toEqual({ image: { data: Buffer.from("bytes").toString("base64"), mimeType } })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("non-attachments and invalid file URLs remain literal pasted text", async () => {
  for (const text of ["ordinary\r\ntext", "  ", "https://example.org/image.png", "/not-a-real-file.png", "file://remote-host/image.png", "file:///image%2Ftest.png", "file:///"]) {
    expect(await readClipboard(text)).toEqual({ text })
  }
})

test("local image reads reject files larger than OpenCode's 20 MB bound", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pasode-attachment-limit-test-"))
  const file = path.join(directory, "large.png")
  try {
    await writeFile(file, "")
    await truncate(file, 20 * 1024 * 1024 + 1)
    await expect(readClipboard(file)).rejects.toThrow("20 MB")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
