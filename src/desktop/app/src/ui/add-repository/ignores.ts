import * as Path from 'path'
import { readdir, readFile, writeFile } from 'fs/promises'

const GitIgnoreExtension = '.gitignore'

const root = Path.join(__dirname, 'static', 'gitignore')

let cachedIgnores: Map<string, string> | null = null

export interface IIgnore {
  /** The human-readable name. */
  readonly name: string
  /** Is the ignore featured? */
  readonly featured: boolean
}

async function getCachedIgnores(): Promise<Map<string, string>> {
  if (cachedIgnores != null) {
    return cachedIgnores
  } else {
    const files = await readdir(root)
    const ignoreFiles = files.filter(file => file.endsWith(GitIgnoreExtension))

    cachedIgnores = new Map()
    for (const file of ignoreFiles) {
      cachedIgnores.set(
        Path.basename(file, GitIgnoreExtension),
        Path.join(root, file)
      )
    }

    return cachedIgnores
  }
}

/** Get the names of the available ignores. */
export async function getIgnoreNames(): Promise<ReadonlyArray<IIgnore>> {
  const ignores = await getCachedIgnores()
  return Array.from(ignores.keys()).map(name => {
    return {
      name,
      featured:
        name === 'UnrealEngine' ||
        name === 'Unity' ||
        name === 'Godot' ||
        name === 'FlaxEngine',
    }
  })
}

/** Get the gitignore based on a name from `getIgnoreNames()`. */
async function getIgnoreText(name: string): Promise<string> {
  const gitIgnores = await getCachedIgnores()

  const path = gitIgnores.get(name)
  if (!path) {
    throw new Error(
      `Unknown ignore: ${name}. Only names returned from getIgnoreNames() can be used.`
    )
  }

  return await readFile(path, 'utf8')
}

/** Write the named ignore to the repository. */
export async function writeIgnore(
  repositoryPath: string,
  name: string
): Promise<void> {
  const fullPath = Path.join(repositoryPath, '.ignore')
  const text = await getIgnoreText(name)
  await writeFile(fullPath, text)
}
