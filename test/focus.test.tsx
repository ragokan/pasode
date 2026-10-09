import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { Prompt, type PromptRef } from "../src/prompt"
import { rendererOptions } from "../src/renderer"
import { theme } from "../src/theme"

test("clicking the transcript doesn't take focus from the prompt (OpenCode's autoFocus: false)", async () => {
  let prompt: PromptRef | undefined
  const screen = await testRender(
    () => (
      <box width="100%" height="100%">
        <scrollbox height={10}>
          <text>transcript</text>
        </scrollbox>
        <Prompt
          ref={(ref) => (prompt = ref)}
          focused
          cwd="/tmp"
          slashItems={[]}
          agent={{ label: "Build", color: theme.agent }}
          model={{ name: "Opus 5.5", provider: "Claude Code" }}
          location="~"
          status={{ running: false, interruptArmed: false }}
          onSubmit={() => {}}
        />
      </box>
    ),
    { ...rendererOptions, width: 80, height: 30 },
  )
  await screen.renderOnce()
  await screen.mockMouse.click(3, 1)
  await screen.mockInput.typeText("hi")
  await screen.renderOnce()
  expect(prompt?.text()).toBe("hi")
  screen.renderer.destroy()
})
