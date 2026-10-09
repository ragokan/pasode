import { expect, test } from "bun:test"
import { truncateFilePath } from "./file-path"

test("path truncation retains roots and extensions within display width", () => {
  expect(truncateFilePath("/long/directory/file.ts", 15)).toBe("/…/dir…/file.ts")
  expect(truncateFilePath("file.ts", 4)).toBe("….ts")
  expect(truncateFilePath("短い.ts", 6)).toBe("短….ts")
  expect(truncateFilePath("C:\\long\\directory\\file.ts", 15)).toBe("C:\\…\\d…\\file.ts")
  expect(truncateFilePath("short.ts", 80)).toBe("short.ts")
  expect(truncateFilePath("file.ts", 0)).toBe("")
})
