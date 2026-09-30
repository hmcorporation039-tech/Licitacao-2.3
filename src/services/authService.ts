// ============================================================
// services/authService.ts — Hash de senha + assinatura/verificação de
// token de sessão. bcryptjs (puro JS, sem compilação nativa — evita
// dor de cabeça de build no Windows) + jsonwebtoken.
// ============================================================

import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomInt } from 'node:crypto'

const SALT_ROUNDS = 10
// Validade do token de SESSÃO (login) — diferente da validade da CONTA
// (User.accessExpiresAt), que é quem controla se a conta ainda pode logar.
const SESSION_DURATION = '30d'

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET não configurado no .env')
  return secret
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

// Hash fixo de uma senha que ninguém usa. Serve para gastar o mesmo tempo de
// bcrypt.compare quando o e-mail não existe (ou a conta não tem senha), de
// modo que o tempo de resposta do login não revele se a conta existe — ver
// verifyPasswordConstantTime e o uso em routes/auth.ts.
const DUMMY_HASH = bcrypt.hashSync('conta-inexistente-placeholder', SALT_ROUNDS)

// Compara a senha sempre pagando o custo de um bcrypt.compare, mesmo quando
// não há hash real (usuário inexistente/sem senha). Retorna sempre false
// nesses casos, mas em tempo equivalente ao de uma senha errada real.
export async function verifyPasswordConstantTime(
  password: string,
  hash: string | null | undefined
): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(password, DUMMY_HASH)
    return false
  }
  return bcrypt.compare(password, hash)
}

// E-mail é identificador de conta: normaliza para não haver duas contas que só
// diferem em maiúsculas/minúsculas ou espaços (e para o login não depender de
// como o usuário digitou). Aplicado tanto na criação quanto no login.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export interface SessionTokenPayload {
  userId: string
  // Confrontado com User.tokenVersion no authMiddleware. Tokens emitidos antes
  // desse campo existir vêm sem ele e são tratados como versão 0.
  tokenVersion: number
}

export function signSessionToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ userId, tokenVersion } satisfies SessionTokenPayload, getJwtSecret(), {
    expiresIn: SESSION_DURATION,
  })
}

export function verifySessionToken(token: string): SessionTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret())
    if (typeof decoded === 'object' && decoded && typeof decoded.userId === 'string') {
      return {
        userId: decoded.userId,
        tokenVersion: typeof decoded.tokenVersion === 'number' ? decoded.tokenVersion : 0,
      }
    }
    return null
  } catch {
    return null
  }
}

// Gera uma senha temporária legível (usada ao criar usuário pelo admin,
// quando ele não define uma senha específica).
export function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  // randomInt (CSPRNG) em vez de Math.random: a senha temporária não pode ser
  // previsível a partir do estado do gerador pseudoaleatório.
  let out = ''
  for (let i = 0; i < 16; i++) {
    out += alphabet[randomInt(alphabet.length)]
  }
  return out
}
