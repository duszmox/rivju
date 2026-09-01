import type { RivjuDatabase } from '../db/client.ts'

export interface TrpcContext {
  db: RivjuDatabase
}
