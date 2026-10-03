// ============================================================
// lib/urlGuard.ts — Defesa contra SSRF nos downloads de anexos de edital.
//
// As URLs de anexo vêm de HTML/JSON de terceiros (PNCP, Novacap, SESC-GO).
// Sem trava, um link malicioso (ou uma fonte comprometida) faria o servidor
// acessar a rede interna da infraestrutura — ex.: http://169.254.169.254 (metadata
// de nuvem) ou http://redis.railway.internal:6379. Aqui garantimos que:
//   1. o protocolo é https;
//   2. o host pertence a uma das fontes conhecidas (allowlist por sufixo);
//   3. NENHUM IP resolvido é privado/reservado — checado na hora de abrir a
//      conexão (o `lookup` do agente roda em cada hop, então cobre também
//      redirects e DNS rebinding).
// ============================================================

import { Agent as HttpsAgent } from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import type { LookupFunction } from 'node:net'

// Sufixos de host aceitos. Só as fontes de onde a plataforma realmente baixa
// anexo (ver pncpDocumentsService.downloadPNCPDocument e quem o chama).
const HOSTS_PERMITIDOS = ['pncp.gov.br', 'novacap.df.gov.br', 'sescgo.com.br']

export function hostPermitido(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return HOSTS_PERMITIDOS.some((sufixo) => h === sufixo || h.endsWith('.' + sufixo))
}

// Valida a URL antes de qualquer requisição. Lança em caso de URL inválida,
// protocolo diferente de https ou host fora da allowlist.
export function assertUrlDownloadPermitida(uri: string): URL {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error('URL de anexo inválida')
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Protocolo não permitido para download: ${url.protocol}`)
  }
  if (!hostPermitido(url.hostname)) {
    throw new Error(`Host não permitido para download: ${url.hostname}`)
  }
  return url
}

// IPs que nunca devem ser alvo de um download vindo de link externo: loopback,
// redes privadas (RFC 1918), link-local (inclui o 169.254.169.254 de metadata
// de nuvem), CGNAT, e os equivalentes IPv6.
export function isIpPrivadoOuReservado(ip: string): boolean {
  const tipo = net.isIP(ip)
  if (tipo === 4) {
    const p = ip.split('.').map(Number)
    if (p[0] === 10) return true
    if (p[0] === 127) return true
    if (p[0] === 0) return true
    if (p[0] === 169 && p[1] === 254) return true
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
    if (p[0] === 192 && p[1] === 168) return true
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true // CGNAT
    if (p[0] >= 224) return true // multicast/reservado
    return false
  }
  if (tipo === 6) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, '')
    if (v === '::1' || v === '::') return true
    if (v.startsWith('fe80')) return true // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true // ULA
    // IPv4 mapeado em IPv6 (::ffff:10.0.0.1) — revalida a parte IPv4.
    const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (m) return isIpPrivadoOuReservado(m[1])
    return false
  }
  return true // não é IP reconhecível: rejeita por precaução
}

// lookup que recusa a conexão se o nome resolver para um IP privado/reservado.
// Passado ao agente https, roda a cada abertura de socket — inclusive nos
// redirects seguidos internamente e em tentativas de DNS rebinding.
const lookupSeguro: LookupFunction = (hostname, options, callback) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dns.lookup(hostname, options as any, (err, address, family) => {
    if (err) return callback(err, address as string, family as number)
    const enderecos = Array.isArray(address)
      ? (address as unknown as { address: string }[]).map((a) => a.address)
      : [address as string]
    for (const ip of enderecos) {
      if (isIpPrivadoOuReservado(ip)) {
        return callback(new Error(`Destino bloqueado (IP interno): ${ip}`), '', 0)
      }
    }
    callback(null, address as string, family as number)
  })
}

// Agente https reutilizável que aplica o lookupSeguro em toda conexão.
export const agenteDownloadSeguro = new HttpsAgent({ lookup: lookupSeguro })
