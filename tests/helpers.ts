import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let root: string | null = null

export async function tmpDir(): Promise<string> {
  if (!root) root = await fsp.mkdtemp(path.join(os.tmpdir(), 'corpuseditor-test-'))
  return root
}

export async function writeFile(name: string, content: string | Buffer): Promise<string> {
  const dir = await tmpDir()
  const file = path.join(dir, name)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content)
  return file
}

export async function readText(file: string): Promise<string> {
  return fsp.readFile(file, 'utf8')
}

export async function cleanup(): Promise<void> {
  if (root) await fsp.rm(root, { recursive: true, force: true })
  root = null
}
