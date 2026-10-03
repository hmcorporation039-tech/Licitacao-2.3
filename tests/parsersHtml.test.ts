// ============================================================
// tests/parsersHtml.test.ts — Parsers de HTML da Etapa 5 (Novacap, FIEG,
// SESC GO). Fixtures abaixo são recortes do HTML real de cada site,
// capturados em 2026-09-28 — se o site mudar de layout, é esperado que
// esses testes acusem antes da coleta em produção quebrar silenciosamente.
// ============================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseNovacapListagem } from '../src/services/novacapParser'
import { parseFiegListagem, extrairTotalPaginas } from '../src/services/fiegParser'
import { parseSescGoListagem } from '../src/services/sescGoParser'

describe('parseNovacapListagem', () => {
  const DATA_DA_CAPTURA_DO_HTML = new Date('2026-09-28T12:00:00-03:00')

  beforeAll(() => {
    vi.useFakeTimers({ now: DATA_DA_CAPTURA_DO_HTML, toFake: ['Date'] })
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  const html = `
    <table id="tblicita">
      <tbody>
        <tr>
          <td data-title="Número/ano" class="align-middle">
            <a href="https://app.novacap.df.gov.br/sislicitapublica/licitadetail/6751" title="Detalhamento e anexos">
              00046/2026 <i class="fas fa-arrow-circle-right"></i>
            </a>
          </td>
          <td data-title="Descrição/objeto">Registro de Preços para fornecimento de insumos betuminosos.</td>
          <td data-title="Data-hora" class="numeric">02/10/2026 14:00</td>
          <td data-title="Data-expira" class="numeric">08/09/2027</td>
          <td data-title="Custo estimado" class="numeric">R$ 35.524.053,95</td>
          <td data-title="Anexos" class="numeric">
            <a class="btn btn-sm btn-primary" href="https://app.novacap.df.gov.br/sislicitapublica/licitadetail/6751">anexos</a>
          </td>
        </tr>
      </tbody>
    </table>
  `

  it('extrai a licitação com fonte, valor e data corretos', () => {
    const [tender] = parseNovacapListagem(html, 'PREGAO_ELETRONICO')
    expect(tender.fonte).toBe('NOVACAP')
    expect(tender.fonteId).toBe('NOVACAP-6751')
    expect(tender.modalidade).toBe('PREGAO_ELETRONICO')
    expect(tender.numeroControle).toBe('00046/2026')
    expect(tender.objeto).toContain('insumos betuminosos')
    expect(tender.valorEstimado).toBeCloseTo(35524053.95)
    expect(tender.uf).toBe('DF')
    expect(tender.orgaoCnpj).toBe('00037457000170')
    expect(tender.encerramentoAt?.toISOString().slice(0, 10)).toBe('2026-10-02')
  })

  it('pula linha sem link de detalhe em vez de quebrar', () => {
    const semLink = `<table id="tblicita"><tbody><tr><td data-title="Número/ano">sem link</td></tr></tbody></table>`
    expect(parseNovacapListagem(semLink, 'OUTROS')).toHaveLength(0)
  })

  // Licitação encerrada/executada não deve entrar no sistema (mesmo
  // princípio em fiegParser.ts, sescGoParser.ts, sestSenatParser.ts) — esta
  // fonte não tem campo de status, então a sessão já passada é o sinal.
  it('exclui licitação cuja data/hora de certame já passou', () => {
    const jaPassou = html.replace('02/10/2026 14:00', '02/10/2020 14:00')
    expect(parseNovacapListagem(jaPassou, 'PREGAO_ELETRONICO')).toHaveLength(0)
  })
})

describe('parseFiegListagem / extrairTotalPaginas', () => {
  const html = `
    <center><span class="pagebanner"> 165 itens encontrado(s), mostrando 1 a 20. </span></center>
    <ul class="licitacoesLista">
      <li>
        <div class="data">
          <span>Abertura em:</span>
          <span class="maior">08/06/2026</span>
          <br/><span>às 10:00</span>
        </div>
        <div class="tituDesc">
          <span class="titu">
            Cotação nº 026/0000 - SESI
          </span>
          <p>Link IP Dedicado 500Mbps - Escola SESI - Santo Antônio do Descoberto.</p>
        </div>
        <a href="CotacaoVisualizar.do?acao=carregar&vo.codigo=10788" class="visualizarLic" title="Visualizar Licitação"></a>
      </li>
    </ul>
  `

  it('extrai a cotação com entidade e data de abertura', () => {
    const [tender] = parseFiegListagem(html)
    expect(tender.fonte).toBe('FIEG')
    expect(tender.fonteId).toBe('FIEG-10788')
    expect(tender.modalidade).toBe('OUTROS')
    expect(tender.numeroControle).toBe('026/0000')
    expect(tender.orgao).toBe('Sistema FIEG - SESI')
    expect(tender.objeto).toContain('Link IP Dedicado')
    expect(tender.aberturaAt?.toISOString().slice(0, 10)).toBe('2026-06-08')
  })

  it('calcula o total de páginas a partir do banner, não dos links visíveis', () => {
    expect(extrairTotalPaginas(html)).toBe(9) // ceil(165 / 20)
  })

  // Licitação encerrada/executada não deve entrar no sistema (mesmo
  // princípio em sescGoParser.ts, novacapParser.ts, sestSenatParser.ts) —
  // "(Finalizada)" no título é o único sinal de status que este site expõe.
  it('exclui cotação marcada como "(Finalizada)" no título', () => {
    const finalizada = html.replace('Cotação nº 026/0000 - SESI', 'Cotação nº 026/0000 - SESI &nbsp;(Finalizada)')
    expect(parseFiegListagem(finalizada)).toHaveLength(0)
  })
})

describe('parseSescGoListagem', () => {
  const html = `
    <div class="accordion" id="licitacoes">
      <div class="card">
        <div class="card-header" id="heading0">
          <span class="col-10 col-xl-11 title">Aquisição de escadas diversas, destinadas às unidades do Sesc Goiás.</span>
        </div>
        <div id="collapse0" class="collapse show">
          <div class="card-body">
            <div class="row">
              <div class="col">
                <span class="lista-licitacoes__label">Processo n°</span>
                <span class="lista-licitacoes__descricao">0051/2026</span>
              </div>
              <div class="col-auto">
                <span class="lista-licitacoes__label">Abertura</span>
                <span class="lista-licitacoes__descricao">07/10/2026 10:00</span>
              </div>
              <div class="col">
                <span class="lista-licitacoes__label">Modalidade</span>
                <span class="lista-licitacoes__descricao">Pregão Eletrônico</span>
              </div>
              <div class="col">
                <span class="lista-licitacoes__label">Situação</span>
                <span class="lista-licitacoes__descricao">Disponível</span>
              </div>
              <div class="col-12">
                <nav>
                  <a href="https://www3.sescgo.com.br/licitacao/download/50015" target="_blank" class="item">Edital.pdf</a>
                </nav>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `

  it('extrai a licitação com modalidade e link do edital', () => {
    const [tender] = parseSescGoListagem(html)
    expect(tender.fonte).toBe('SESC_GO')
    expect(tender.fonteId).toBe('SESCGO-0051-2026')
    expect(tender.modalidade).toBe('PREGAO_ELETRONICO')
    expect(tender.objeto).toContain('escadas diversas')
    expect(tender.linkEdital).toBe('https://www3.sescgo.com.br/licitacao/download/50015')
    expect(tender.encerramentoAt?.toISOString().slice(0, 10)).toBe('2026-10-07')
    // Anexos vão pro rawJson (não têm página de detalhe pra buscar sob
    // demanda como Novacap/PNCP) — é o que a análise de edital por IA lê.
    expect(tender.rawJson).toEqual({ anexos: [{ uri: 'https://www3.sescgo.com.br/licitacao/download/50015', titulo: 'Edital.pdf' }] })
  })

  it('pula card sem "Processo n°" em vez de quebrar', () => {
    const semProcesso = `<div class="accordion" id="licitacoes"><div class="card"><div class="card-body"></div></div></div>`
    expect(parseSescGoListagem(semProcesso)).toHaveLength(0)
  })

  // Licitação encerrada/executada não deve entrar no sistema (mesmo
  // princípio em fiegParser.ts, novacapParser.ts, sestSenatParser.ts).
  it('exclui licitação com situação encerrada', () => {
    const encerrada = html.replace('Disponível', 'Encerrada')
    expect(parseSescGoListagem(encerrada)).toHaveLength(0)
  })
})
