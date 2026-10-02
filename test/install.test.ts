import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Lance install.sh (mode Traefik, non interactif) avec docker/openssl/curl factices. */
function runInstall(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'cq-install-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const cmd of ['docker', 'openssl', 'curl']) {
    writeFileSync(join(bin, cmd), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, cmd), 0o755)
  }
  copyFileSync('install.sh', join(dir, 'install.sh'))
  const res = spawnSync('bash', ['install.sh'], {
    cwd: dir,
    input: '',
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CQ_YES: '1',
      CQ_MODE: 'traefik',
      CQ_PUBLIC_URL: 'queue.example.com',
      CQ_TRAEFIK_HOSTS: 'queue.example.com',
      CQ_BEHIND_CLOUDFLARE: 'n',
      ...env,
    },
  })
  return { status: res.status, stderr: res.stderr, stdout: res.stdout, envWritten: existsSync(join(dir, '.env')) }
}

describe.skipIf(process.platform === 'win32')('install.sh : valeurs Traefik', () => {
  it.each([
    ['CQ_TRAEFIK_CERTRESOLVER', 'le;touch pwned'],
    ['CQ_TRAEFIK_NETWORK', 'net$(id)'],
    ['CQ_TRAEFIK_NETWORK', 'bad name'],
  ])('%s=%s : refusé, aucun .env écrit', (name, value) => {
    const r = runInstall({ [name]: value })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(`${name} invalide`)
    expect(r.envWritten).toBe(false)
  })

  it('le résumé mentionne le dossier des fichiers dans le volume /data', () => {
    const r = runInstall({})
    expect(r.stdout).toContain('/data/files')
  })

  it('valeurs sûres acceptées', () => {
    const r = runInstall({
      CQ_TRAEFIK_CERTRESOLVER: 'le.ok-1_x',
      CQ_TRAEFIK_NETWORK: 'traefik_net',
    })
    expect(r.envWritten).toBe(true)
  })
})
