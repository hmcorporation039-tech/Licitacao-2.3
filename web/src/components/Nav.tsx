'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { clearSessionUser, getSessionUser, SessionUser } from '@/lib/session'
import { api } from '@/lib/api'

const LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/items', label: 'Itens monitorados' },
  { href: '/tenders', label: 'Licitações' },
  { href: '/matches', label: 'Meus matches' },
  { href: '/escolhidas', label: 'Licitações escolhidas' },
  { href: '/empresa', label: 'Empresa' },
  { href: '/guia', label: 'Guia' },
]

export default function Nav() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    setUser(getSessionUser())
  }, [pathname])

  if (pathname === '/login') return null

  const links = user?.isAdmin ? [...LINKS, { href: '/admin/usuarios', label: 'Usuários' }] : LINKS

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        <Link href="/dashboard" className="font-semibold text-slate-900">
          Monitor de Licitações
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={
                pathname?.startsWith(link.href)
                  ? 'font-medium text-indigo-700'
                  : 'text-slate-600 hover:text-slate-900'
              }
            >
              {link.label}
            </Link>
          ))}
          {user && (
            <span className="ml-2 flex items-center gap-2 border-l border-slate-200 pl-4 text-slate-500">
              <Link href="/conta" className="hover:text-indigo-700 hover:underline">
                {user.email}
              </Link>
              <button
                onClick={async () => {
                  // Invalida o token no servidor (incrementa o tokenVersion),
                  // não só no navegador — assim um token copiado antes de sair
                  // para de valer na hora. Best-effort: se a chamada falhar,
                  // ainda limpamos a sessão local e mandamos pro login.
                  try {
                    await api.post('/api/auth/logout')
                  } catch {
                    // ignora — segue com a limpeza local
                  }
                  clearSessionUser()
                  router.push('/login')
                }}
                className="text-red-600 hover:underline"
              >
                Sair
              </button>
            </span>
          )}
        </nav>
      </div>
    </header>
  )
}
