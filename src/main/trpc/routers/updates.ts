import { publicProcedure, router } from '../base.ts'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installUpdate,
} from '../../updates/service.ts'

export const updatesRouter = router({
  state: publicProcedure.query(() => getUpdateState()),
  check: publicProcedure.mutation(() => checkForUpdates()),
  download: publicProcedure.mutation(() => downloadUpdate()),
  install: publicProcedure.mutation(() => installUpdate()),
})
