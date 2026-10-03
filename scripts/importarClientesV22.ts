import { randomUUID } from 'node:crypto'
import { Client } from 'pg'

const EMAILS_IGNORADOS = new Set(['cypress-admin@example.com'])
const modoSimulacao = process.argv.includes('--dry')

interface UsuarioImportado {
  idNoDestino: string
  companyId: string
  email: string
}

interface LinhaDeOrigem {
  dados: string
  [coluna: string]: unknown
}

interface Placar {
  inseridos: number
  jaExistiam: number
}

const placar = new Map<string, Placar>()

function registrar(tabela: string, inserido: boolean) {
  const atual = placar.get(tabela) ?? { inseridos: 0, jaExistiam: 0 }
  if (inserido) atual.inseridos += 1
  else atual.jaExistiam += 1
  placar.set(tabela, atual)
}

function exigirVariavel(nome: string): string {
  const valor = process.env[nome]
  if (!valor) {
    console.error(`Defina ${nome}.`)
    process.exit(1)
  }
  return valor
}

function hostDaUrl(url: string): string {
  const { hostname, port, pathname } = new URL(url)
  return `${hostname}:${port}${pathname}`
}

const colunasPorTabela = new Map<string, Set<string>>()

async function colunasDoDestino(destino: Client, tabela: string): Promise<Set<string>> {
  const emCache = colunasPorTabela.get(tabela)
  if (emCache) return emCache
  const resultado = await destino.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [tabela]
  )
  const colunas = new Set(resultado.rows.map((linha) => linha.column_name))
  colunasPorTabela.set(tabela, colunas)
  return colunas
}

async function inserirNoDestino(
  destino: Client,
  tabela: string,
  dadosDeOrigem: string,
  substituicoes: Record<string, unknown> = {}
): Promise<boolean> {
  const colunasDestino = await colunasDoDestino(destino, tabela)
  const colunasDeOrigem = Object.keys(JSON.parse(dadosDeOrigem) as Record<string, unknown>)
  const colunas = [...new Set([...colunasDeOrigem, ...Object.keys(substituicoes)])].filter((coluna) =>
    colunasDestino.has(coluna)
  )
  const listaDeColunas = colunas.map((coluna) => `"${coluna}"`).join(', ')
  const resultado = await destino.query(
    `INSERT INTO "${tabela}" (${listaDeColunas})
     SELECT ${listaDeColunas} FROM jsonb_populate_record(NULL::"${tabela}", $1::jsonb || $2::jsonb)
     ON CONFLICT DO NOTHING`,
    [dadosDeOrigem, JSON.stringify(substituicoes)]
  )
  const inserido = resultado.rowCount === 1
  registrar(tabela, inserido)
  return inserido
}

async function importarUsuarios(origem: Client, destino: Client): Promise<Map<string, UsuarioImportado>> {
  const usuariosDeOrigem = await origem.query<LinhaDeOrigem & { id: string; email: string; name: string | null }>(
    `SELECT row_to_json(u)::text AS dados, u.id, u.email, u.name FROM users u ORDER BY u.created_at`
  )
  const importados = new Map<string, UsuarioImportado>()

  for (const usuario of usuariosDeOrigem.rows) {
    if (EMAILS_IGNORADOS.has(usuario.email)) continue

    const existente = await destino.query<{ id: string; company_id: string }>(
      `SELECT id, company_id FROM users WHERE email = $1`,
      [usuario.email]
    )
    if (existente.rows[0]) {
      registrar('users', false)
      importados.set(usuario.id, {
        idNoDestino: existente.rows[0].id,
        companyId: existente.rows[0].company_id,
        email: usuario.email,
      })
      continue
    }

    const companyId = randomUUID()
    await destino.query(
      `INSERT INTO companies (id, tipo, name, created_at, updated_at) VALUES ($1, 'PESSOA_FISICA', $2, now(), now())`,
      [companyId, usuario.name ?? usuario.email]
    )
    registrar('companies', true)

    const inserido = await inserirNoDestino(destino, 'users', usuario.dados, {
      company_id: companyId,
      company_role: 'OWNER',
    })
    if (!inserido) throw new Error(`O id do usuário ${usuario.email} já existe no destino com outro e-mail.`)

    importados.set(usuario.id, { idNoDestino: usuario.id, companyId, email: usuario.email })
  }

  return importados
}

async function importarLicitacoes(
  origem: Client,
  destino: Client,
  idsDeUsuariosNaOrigem: string[]
): Promise<Map<string, string>> {
  const licitacoesReferenciadas = await origem.query<LinhaDeOrigem & { id: string; fonte_id: string }>(
    `SELECT row_to_json(t)::text AS dados, t.id, t.fonte_id
     FROM tenders t
     WHERE t.id IN (
       SELECT tender_id FROM tender_matches WHERE user_id = ANY($1)
       UNION SELECT tender_id FROM tender_checklists WHERE user_id = ANY($1)
       UNION SELECT tender_id FROM tender_participation_plans WHERE user_id = ANY($1)
       UNION SELECT tender_id FROM tender_analyses
     )`,
    [idsDeUsuariosNaOrigem]
  )
  const idNoDestinoPorIdNaOrigem = new Map<string, string>()

  for (const licitacao of licitacoesReferenciadas.rows) {
    const existente = await destino.query<{ id: string }>(`SELECT id FROM tenders WHERE fonte_id = $1`, [
      licitacao.fonte_id,
    ])
    if (existente.rows[0]) {
      registrar('tenders', false)
      idNoDestinoPorIdNaOrigem.set(licitacao.id, existente.rows[0].id)
      continue
    }

    const inserida = await inserirNoDestino(destino, 'tenders', licitacao.dados)
    if (!inserida) throw new Error(`O id da licitação ${licitacao.fonte_id} já existe no destino com outro fonte_id.`)
    idNoDestinoPorIdNaOrigem.set(licitacao.id, licitacao.id)

    const itens = await origem.query<LinhaDeOrigem>(
      `SELECT row_to_json(i)::text AS dados FROM tender_items i WHERE i.tender_id = $1`,
      [licitacao.id]
    )
    for (const item of itens.rows) await inserirNoDestino(destino, 'tender_items', item.dados)
  }

  return idNoDestinoPorIdNaOrigem
}

async function importarTabelaDoUsuario(
  origem: Client,
  destino: Client,
  tabela: string,
  usuarios: Map<string, UsuarioImportado>,
  licitacoes: Map<string, string>
) {
  const linhas = await origem.query<LinhaDeOrigem & { user_id: string; tender_id?: string }>(
    `SELECT row_to_json(x)::text AS dados, x.* FROM "${tabela}" x WHERE x.user_id = ANY($1)`,
    [[...usuarios.keys()]]
  )

  for (const linha of linhas.rows) {
    const dono = usuarios.get(linha.user_id)!
    const substituicoes: Record<string, unknown> = { user_id: dono.idNoDestino, company_id: dono.companyId }
    if (linha.tender_id) {
      const tenderNoDestino = licitacoes.get(linha.tender_id)
      if (!tenderNoDestino) throw new Error(`${tabela}: licitação ${linha.tender_id} não foi mapeada.`)
      substituicoes.tender_id = tenderNoDestino
    }
    await inserirNoDestino(destino, tabela, linha.dados, substituicoes)
  }
}

async function importarAnalises(origem: Client, destino: Client, licitacoes: Map<string, string>) {
  const analises = await origem.query<LinhaDeOrigem & { tender_id: string }>(
    `SELECT row_to_json(a)::text AS dados, a.tender_id FROM tender_analyses a`
  )
  for (const analise of analises.rows) {
    await inserirNoDestino(destino, 'tender_analyses', analise.dados, {
      tender_id: licitacoes.get(analise.tender_id),
    })
  }
}

async function conferirNoDestino(destino: Client, usuarios: Map<string, UsuarioImportado>) {
  const conferencia = await destino.query(
    `SELECT u.email, c.name AS empresa,
       (SELECT count(*) FROM monitored_items m WHERE m.user_id = u.id) AS itens,
       (SELECT count(*) FROM tender_matches t WHERE t.user_id = u.id) AS matches,
       (SELECT count(*) FROM tender_checklists k WHERE k.user_id = u.id) AS checklists,
       (SELECT count(*) FROM tender_participation_plans p WHERE p.user_id = u.id) AS planos,
       (SELECT count(*) FROM company_documents d WHERE d.user_id = u.id) AS documentos
     FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.id = ANY($1) ORDER BY u.created_at`,
    [[...usuarios.values()].map((usuario) => usuario.idNoDestino)]
  )
  console.log('\nClientes no destino:')
  console.table(conferencia.rows)
}

async function main() {
  const urlOrigem = exigirVariavel('ORIGEM_DATABASE_URL')
  const urlDestino = exigirVariavel('DESTINO_DATABASE_URL')
  console.log(`Origem (somente leitura): ${hostDaUrl(urlOrigem)}`)
  console.log(`Destino: ${hostDaUrl(urlDestino)}`)
  if (modoSimulacao) console.log('Modo --dry: tudo roda numa transação desfeita no final.')

  const origem = new Client({ connectionString: urlOrigem })
  const destino = new Client({ connectionString: urlDestino })
  await origem.connect()
  await destino.connect()
  await origem.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  await destino.query('BEGIN')

  try {
    const usuarios = await importarUsuarios(origem, destino)
    const licitacoes = await importarLicitacoes(origem, destino, [...usuarios.keys()])
    await importarTabelaDoUsuario(origem, destino, 'monitored_items', usuarios, licitacoes)
    await importarTabelaDoUsuario(origem, destino, 'tender_matches', usuarios, licitacoes)
    await importarTabelaDoUsuario(origem, destino, 'tender_checklists', usuarios, licitacoes)
    await importarTabelaDoUsuario(origem, destino, 'tender_participation_plans', usuarios, licitacoes)
    await importarTabelaDoUsuario(origem, destino, 'company_documents', usuarios, licitacoes)
    await importarAnalises(origem, destino, licitacoes)

    console.log('\nResumo por tabela:')
    console.table(Object.fromEntries(placar))
    await conferirNoDestino(destino, usuarios)

    await destino.query(modoSimulacao ? 'ROLLBACK' : 'COMMIT')
    console.log(modoSimulacao ? '\n--dry: nada foi gravado.' : '\nImportação gravada.')
  } catch (erro) {
    await destino.query('ROLLBACK')
    throw erro
  } finally {
    await origem.end()
    await destino.end()
  }
}

main().catch((erro) => {
  console.error('\nImportação desfeita, nada foi gravado:', erro instanceof Error ? erro.message : erro)
  process.exit(1)
})
