import fs from 'fs'
import path from 'path'

function getConfigPath() {
  if (process.pkg) {
    const configPath = path.join(path.dirname(process.execPath), './config.dev.json')
    if (fs.existsSync(configPath)) {
      return configPath
    }
    return path.join(path.dirname(process.execPath), './config.json')
  }
  const configPath = path.join(path.dirname(process.argv[1]), '../config.dev.json')
  if (fs.existsSync(configPath)) {
    return configPath
  }
  return path.join(path.dirname(process.argv[1]), '../config.json')
}

function validateConfig(config) {
  return true
}

export function getConfig() {
  try {
    const configPath = getConfigPath()
    const cert = fs.readFileSync(configPath)
    const configObject = JSON.parse(cert.toString('utf-8'))
    if (!validateConfig(configObject)) {
      return null
    }
    return configObject
  } catch (error) {
    return null
  }
}
