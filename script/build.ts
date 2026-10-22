// Builds standalone binaries and their release assets (dist/*.gz, dist/SHA256SUMS):
// bun script/build.ts [bun-linux-arm64 bun-darwin-arm64 ...] (default: this machine).
// Cross-builds need every platform's OpenTUI package: bun install --frozen-lockfile --os='*' --cpu='*'
import solidPlugin from "@opentui/solid/bun-plugin"
import path from "node:path"

const targets = process.argv.slice(2)
const sums: string[] = []
for (const target of targets.length ? targets : [`bun-${process.platform}-${process.arch}`]) {
  const outfile = `dist/pasode-${target.replace(/^bun-/, "")}`
  const result = await Bun.build({
    entrypoints: ["./bin/paseo-tui.ts"],
    plugins: [solidPlugin],
    // No bunfig/.env autoload: the binary must not pick up preloads or env from whatever directory it runs in.
    compile: { target: target as Bun.Build.CompileTarget, outfile, autoloadBunfig: false, autoloadDotenv: false },
    minify: true,
  })
  if (!result.success) {
    console.error(result.logs.join("\n"))
    process.exit(1)
  }
  // Bun ad-hoc signs darwin-arm64 but leaves darwin-x64 with its own runtime's, now invalid, signature; on a Mac
  // (where the release workflow builds them) sign both ad hoc. A cross-build elsewhere keeps the invalid one.
  if (target.startsWith("bun-darwin") && process.platform === "darwin") {
    if (!Bun.spawnSync(["codesign", "--force", "--sign", "-", outfile], { stderr: "inherit" }).success) process.exit(1)
  }
  const archive = Bun.gzipSync(await Bun.file(outfile).bytes(), { level: 9 })
  await Bun.write(`${outfile}.gz`, archive)
  sums.push(`${new Bun.CryptoHasher("sha256").update(archive).digest("hex")}  ${path.basename(outfile)}.gz`)
  console.log(`${outfile}.gz`)
}
await Bun.write("dist/SHA256SUMS", sums.join("\n") + "\n")
