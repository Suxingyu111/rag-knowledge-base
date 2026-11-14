import { api } from '@/api/client'
import type {
  DatasetListResponse, EvaluationItemPage, EvaluationItemRead, EvaluationItemUpdate,
  EvaluationRunCreate, EvaluationRunPage, EvaluationRunRead, ListEvaluationItemsData,
} from '@/client'

export type BadCaseCategory = NonNullable<EvaluationItemRead['bad_case_category']>
export type EvaluationItemFilters = NonNullable<ListEvaluationItemsData['query']>

export const evaluationKeys = {
  datasets: ['evaluation', 'datasets'] as const,
  runs: ['evaluation', 'runs'] as const,
  run: (id: string) => ['evaluation', 'run', id] as const,
  item: (id: string) => ['evaluation', 'item', id] as const,
  items: (id: string) => ['evaluation', 'items', id] as const,
}

const root = '/evaluations'
const json = { headers: { 'Content-Type': 'application/json' } }
const runPath = (id: string) => `${root}/runs/${encodeURIComponent(id)}`

export const evaluationApi = {
  datasets: (signal: AbortSignal) =>
    api.get<DatasetListResponse>(`${root}/datasets`, { signal, silent: true }),
  runs: (page: number, page_size: number, signal: AbortSignal) =>
    api.get<EvaluationRunPage>(`${root}/runs`, { query: { page, page_size }, signal, silent: true }),
  run: (id: string, signal: AbortSignal) =>
    api.get<EvaluationRunRead>(runPath(id), { signal, silent: true }),
  items: (id: string, query: EvaluationItemFilters, signal: AbortSignal) =>
    api.get<EvaluationItemPage>(`${runPath(id)}/items`, { query, signal, silent: true }),
  item: (id: string, signal: AbortSignal) =>
    api.get<EvaluationItemRead>(`${root}/items/${encodeURIComponent(id)}`, { signal, silent: true }),
  create: (body: EvaluationRunCreate) => api.post<EvaluationRunRead>(`${root}/runs`, body, json),
  remove: (id: string) => api.remove<void>(runPath(id)),
  updateItem: (id: string, body: EvaluationItemUpdate) =>
    api.patch<EvaluationItemRead>(`${root}/items/${encodeURIComponent(id)}`, body, json),
}
