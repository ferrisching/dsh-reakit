// Guided Node installation when the machine has none.
//
// The plugin never runs a package manager on its own here: it names the
// installers it actually found, prints the exact command for each, and lets the
// user install and re-detect. Upgrading a system toolchain stays the user's
// decision, with their own privileges and consent.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const isFile = async path => { try { return (await stat(path)).isFile() } catch { return false } }
const isDir = async path => { try { return (await stat(path)).isDirectory() } catch { return false } }

/** Installers that can put a Node on this machine, in preference order. */
export async function detectNodeInstallers({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const installers = []
  const pathDirs = String(env.PATH ?? '').split(platform === 'win32' ? ';' : ':')
  const has = async name => {
    for (const dir of pathDirs) if (await isFile(join(dir, name))) return true
    return false
  }
  if (platform === 'darwin') {
    const brewPath = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(() => true)
    const present = await has('brew') || await isFile(brewPath)
    if (present) installers.push({ id: 'brew', title: 'Homebrew', command: 'brew install node', note: '安装到系统全局（/opt/homebrew 或 /usr/local），需要网络，不改动插件目录。' })
    if (await isDir(join(home, '.nvm'))) installers.push({ id: 'nvm', title: 'nvm', command: 'nvm install --lts && nvm use --lts', note: '安装到 ~/.nvm，只影响当前 shell 的 Node 版本。' })
  } else if (platform === 'linux') {
    if (await has('apt-get')) installers.push({ id: 'apt', title: 'apt', command: 'sudo apt-get update && sudo apt-get install -y nodejs', note: '需要管理员权限；插件不会代跑 sudo。' })
    if (await has('dnf')) installers.push({ id: 'dnf', title: 'dnf', command: 'sudo dnf install -y nodejs', note: '需要管理员权限；插件不会代跑 sudo。' })
    if (await isDir(join(home, '.nvm'))) installers.push({ id: 'nvm', title: 'nvm', command: 'nvm install --lts && nvm use --lts', note: '安装到 ~/.nvm，不需要管理员权限。' })
  } else if (platform === 'win32') {
    if (await has('winget.exe')) installers.push({ id: 'winget', title: 'winget', command: 'winget install OpenJS.NodeJS.LTS', note: '安装到本机，可能需要管理员确认。' })
    if (await has('choco.exe')) installers.push({ id: 'choco', title: 'Chocolatey', command: 'choco install nodejs-lts -y', note: '需要管理员权限。' })
  }
  return installers
}
