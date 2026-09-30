// ============================================================
// services/editalAnalysisService.ts — Baixa o conjunto documental de uma
// licitação e faz uma análise minuciosa por IA, cruzando com o
// checklist de habilitação (Lei 14.133/2021).
//
// Provedor de IA controlado por AI_PROVIDER no .env ('claude' | 'gemini',
// default 'claude'). Pensado pra trocar sem mexer em código: use 'gemini'
// (gratuito, via Google AI Studio) enquanto não tiver crédito na Claude,
// e volte pra 'claude' depois — ver src/services/llm/.
//
// AI_ANALYSIS_ENABLED é o interruptor geral: desligado (padrão), a função
// marca a análise como DISABLED antes de qualquer I/O — não baixa documento,
// não chama modelo, não gasta crédito.
// ============================================================

import axios from 'axios'
import { Tender } from '@prisma/client'
import { prisma } from './tenderService'
import { downloadPNCPDocument, isPdf, listPNCPDocuments, selecionarDocumentos } from './pncpDocumentsService'
import { listNovacapDocumentos } from './novacapParser'
import { ordenarPorPrioridade, DocumentoComTitulo } from '../lib/documentPriority'
import { extractPdf, temCamadaDeTexto } from './pdfTextService'
import { AnalysisRefusedError, EditalAnalyzer, EditalDocumento } from './llm/types'
import { analyzeEdital as analyzeWithClaude } from './llm/claudeAnalyzer'
import { analyzeEdital as analyzeWithGemini } from './llm/geminiAnalyzer'

interface DocumentoDisponivel extends DocumentoComTitulo {
  uri: string
}

// Teto por requisição da API (32 MB). Ficamos abaixo com folga porque o
// base64 infla o binário em cerca de 1/3. Só conta o que vai em PDF nativo.
const MAX_BYTES_PDF_TOTAL = 20 * 1024 * 1024
// Orçamento de texto do conjunto. Nenhum documento é truncado: quando o
// orçamento acaba, paramos de incluir novos — o edital, que é o primeiro da
// fila de prioridade, nunca é o cortado.
const MAX_CARACTERES_TOTAL = 800_000
const MAX_DOCUMENTOS = 5

export function analiseHabilitada(): boolean {
  return process.env.AI_ANALYSIS_ENABLED === 'true'
}

function getAnalyzer(): EditalAnalyzer {
  const provider = (process.env.AI_PROVIDER || 'claude').toLowerCase()
  if (provider === 'gemini') return analyzeWithGemini
  if (provider === 'claude') return analyzeWithClaude
  throw new Error(`AI_PROVIDER inválido: "${provider}" — use "claude" ou "gemini"`)
}

// Lista os documentos de uma licitação, já do mais relevante para o menos —
// cada fonte tem seu próprio jeito de chegar neles. Fontes sem acesso
// público a anexo (FIEG exige login no site de origem — mesma regra que
// vale pros outros portais com login, ver Etapa 5; ComprasNet nunca teve
// esse link capturado, módulo Lei 8.666 praticamente inativo) devolvem
// lista vazia e caem no NO_DOCUMENTS de sempre, sem tratamento especial.
async function listarDocumentosDisponiveis(tender: Tender): Promise<DocumentoDisponivel[]> {
  switch (tender.fonte) {
    case 'PNCP': {
      const raw = tender.rawJson as Record<string, unknown>
      const orgaoEntidade = raw.orgaoEntidade as Record<string, unknown> | undefined
      const cnpj = orgaoEntidade?.cnpj as string | undefined
      const ano = raw.anoCompra as number | undefined
      const sequencial = raw.sequencialCompra as number | undefined
      if (!cnpj || !ano || !sequencial) return []
      return selecionarDocumentos(await listPNCPDocuments(cnpj, ano, sequencial))
    }
    case 'NOVACAP': {
      // fonteId é sempre "NOVACAP-{id}" (ver novacapParser.ts) — sob demanda
      // aqui, na hora da análise, mesmo padrão do PNCP: não fica no banco.
      const detailId = tender.fonteId.replace('NOVACAP-', '')
      return ordenarPorPrioridade(await listNovacapDocumentos(detailId))
    }
    case 'SESC_GO': {
      // Sem página de detalhe por licitação nesta fonte — os anexos já
      // vieram capturados na coleta (ver sescGoParser.ts).
      const raw = tender.rawJson as { anexos?: DocumentoDisponivel[] }
      return ordenarPorPrioridade(raw.anexos ?? [])
    }
    default:
      return []
  }
}

// Baixa até MAX_DOCUMENTOS PDFs, do mais relevante para o menos, e decide um
// a um se vai como texto (barato) ou em PDF nativo (quando é escaneado e não
// há texto para extrair).
async function baixarDocumentos(disponiveis: DocumentoDisponivel[]): Promise<EditalDocumento[]> {
  const selecionados: EditalDocumento[] = []
  let bytesDePdf = 0
  let caracteres = 0

  for (const doc of disponiveis) {
    if (selecionados.length >= MAX_DOCUMENTOS) break

    try {
      const buffer = await downloadPNCPDocument(doc.uri)
      if (!isPdf(buffer)) continue

      let extraido: { texto: string; paginas: number } | null = null
      try {
        extraido = await extractPdf(buffer)
      } catch (err) {
        console.warn(
          `[Análise de edital] Não deu para ler o texto de "${doc.titulo}", tentando como PDF:`,
          err instanceof Error ? err.message : err
        )
      }

      if (extraido && temCamadaDeTexto(extraido.texto, extraido.paginas)) {
        if (caracteres + extraido.texto.length > MAX_CARACTERES_TOTAL) continue
        selecionados.push({ nome: doc.titulo, tipo: 'texto', texto: extraido.texto })
        caracteres += extraido.texto.length
        continue
      }

      // Sem camada de texto: é escaneado. Vai o arquivo, para o modelo ler a página.
      if (bytesDePdf + buffer.byteLength > MAX_BYTES_PDF_TOTAL) continue
      console.log(`[Análise de edital] "${doc.titulo}" parece escaneado — enviando como PDF nativo.`)
      selecionados.push({ nome: doc.titulo, tipo: 'pdf', data: buffer })
      bytesDePdf += buffer.byteLength
    } catch (err) {
      console.error(`[Análise de edital] Falha ao baixar "${doc.titulo}":`, err instanceof Error ? err.message : err)
    }
  }

  return selecionados
}

export async function runEditalAnalysis(tenderId: string): Promise<void> {
  if (!analiseHabilitada()) {
    await prisma.tenderAnalysis.upsert({
      where: { tenderId },
      update: {
        status: 'DISABLED',
        errorMsg: 'A análise de edital por IA está desligada nesta instalação (AI_ANALYSIS_ENABLED).',
      },
      create: {
        tenderId,
        status: 'DISABLED',
        errorMsg: 'A análise de edital por IA está desligada nesta instalação (AI_ANALYSIS_ENABLED).',
      },
    })
    return
  }

  await prisma.tenderAnalysis.upsert({
    where: { tenderId },
    update: { status: 'RUNNING', errorMsg: null },
    create: { tenderId, status: 'RUNNING' },
  })

  try {
    const tender = await prisma.tender.findUnique({ where: { id: tenderId } })
    if (!tender) throw new Error('Licitação não encontrada')

    const disponiveis = await listarDocumentosDisponiveis(tender)

    if (disponiveis.length === 0) {
      await prisma.tenderAnalysis.update({
        where: { tenderId },
        data: {
          status: 'NO_DOCUMENTS',
          errorMsg: 'Nenhum documento disponível publicamente para esta licitação nesta fonte.',
        },
      })
      return
    }

    const documentos = await baixarDocumentos(disponiveis)

    if (documentos.length === 0) {
      await prisma.tenderAnalysis.update({
        where: { tenderId },
        data: { status: 'NO_DOCUMENTS', errorMsg: 'Nenhum documento em PDF foi encontrado para esta licitação.' },
      })
      return
    }

    const documentoNome = documentos.map((d) => d.nome).join(' · ')

    let resultado
    try {
      resultado = await getAnalyzer()(tender.objeto, documentos)
    } catch (err) {
      if (err instanceof AnalysisRefusedError) {
        await prisma.tenderAnalysis.update({
          where: { tenderId },
          data: { status: 'FAILED', documentoNome, errorMsg: err.message },
        })
        return
      }
      throw err
    }

    await prisma.tenderAnalysis.update({
      where: { tenderId },
      data: {
        status: 'DONE',
        documentoNome,
        resultado: resultado as unknown as object,
        errorMsg: null,
      },
    })
  } catch (err) {
    // As fontes de origem (API do PNCP, sites da Novacap etc.) caem com
    // frequência, fora do nosso controle — em vez do axios "Request failed
    // with status code 503" cru, mostra algo que a pessoa usuária entenda.
    const isFonteFora = axios.isAxiosError(err) && (!err.response || err.response.status >= 500)
    // O detalhe do erro (mensagem do axios, host/porta interna, stack do SDK)
    // fica só no log do servidor — nunca em errorMsg, que qualquer usuário lê
    // em GET /:id/analysis. Ao usuário vai só uma mensagem genérica.
    console.error(`[Análise de edital] Falha ao analisar ${tenderId}:`, err instanceof Error ? err.message : err)
    const errorMsg = isFonteFora
      ? 'A fonte de origem está indisponível no momento (não foi possível baixar os documentos do edital). Tente novamente mais tarde.'
      : 'Não foi possível concluir a análise deste edital. Tente novamente mais tarde.'
    await prisma.tenderAnalysis.update({
      where: { tenderId },
      data: { status: 'FAILED', errorMsg },
    })
    throw err
  }
}
