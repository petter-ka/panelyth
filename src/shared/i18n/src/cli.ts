import { join } from "node:path"
import { extractMessages } from "./extract.ts"

const SRC = join(import.meta.dirname, "..", "..", "..")
const source = [...extractMessages(SRC).keys()].sort()
const args = process.argv.slice(2)
if (args[0] === "--json") {
  console.log(JSON.stringify(source, null, 2))
} else if (args[0] === "--missing" && args[1]) {
  const messages = (
    (await import(`./messages/${args[1]}.ts`)) as { default: Record<string, string> }
  ).default
  console.log(
    JSON.stringify(
      source.filter((m) => !(m in messages)),
      null,
      2,
    ),
  )
} else {
  console.log(`${source.length} messages`)
}
