// ============================================================
// lib/safeUrl.ts — Valida uma URL vinda de dado externo (ex.: linkEdital,
// que é raspado de sites de terceiros) antes de usá-la num href.
// Só aceita http(s); rejeita javascript:, data:, etc. — que num href
// poderiam executar script no clique.
// ============================================================

export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
    return null
  } catch {
    return null
  }
}
