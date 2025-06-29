//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { Analytics } from '@hcengineering/analytics'
import core, {
  BackupClient,
  Client as CoreClient,
  Doc,
  Domain,
  DOMAIN_BLOB,
  DOMAIN_MODEL,
  DOMAIN_MODEL_TX,
  DOMAIN_TRANSIENT,
  DOMAIN_TX,
  MeasureContext,
  MeasureMetricsContext,
  RateLimiter,
  Ref,
  SortingOrder,
  systemAccountUuid,
  toIdMap,
  TxProcessor,
  type BackupStatus,
  type Blob,
  type Tx,
  type TxCUD,
  type WorkspaceIds,
  type WorkspaceUuid
} from '@hcengineering/core'
import { BlobClient, createClient, getTransactorEndpoint } from '@hcengineering/server-client'
import { estimateDocSize, type StorageAdapter } from '@hcengineering/server-core'
import { generateToken } from '@hcengineering/server-token'
import { deepEqual } from 'fast-equals'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { PassThrough } from 'node:stream'
import { createGzip } from 'node:zlib'
import { join } from 'path'
import { Writable } from 'stream'
import { extract, Pack, pack } from 'tar-stream'
import { createGunzip, gunzipSync, gzipSync } from 'zlib'
import { BackupStorage } from './storage'
export * from './storage'

const dataBlobSize = 250 * 1024 * 1024
const dataUploadSize = 2 * 1024 * 1024
const batchSize = 5000

const defaultLevel = 9

/**
 * Blob data from s3 storage
 * @public
 */
interface BlobData extends Doc {
  name: string
  size: number
  type: string
  provider?: string // If node defined, will be default one
  base64Data: string // base64 encoded data
}

/**
 * @public
 */
export interface Snapshot {
  added: Map<Ref<Doc>, string>
  updated: Map<Ref<Doc>, string>
  removed: Ref<Doc>[]
}

/**
 * @public
 */
export interface SnapshotV6 {
  added: Record<Ref<Doc>, string>
  updated: Record<Ref<Doc>, string>
  removed: Ref<Doc>[]
}

/**
 * @public
 */
export interface DomainData {
  snapshot?: string // 0.6 json snapshot
  snapshots?: string[]
  storage?: string[]

  // Some statistics
  added: number
  updated: number
  removed: number
}

/**
 * @public
 */
export interface BackupSnapshot {
  // _id => hash of added items.
  domains: Record<Domain, DomainData>
  date: number

  compacting?: boolean
  stIndex: number // Snapshot index
}

/**
 * @public
 */
export interface BackupInfo {
  workspace: WorkspaceUuid
  version: string
  snapshots: BackupSnapshot[]
  snapshotsIndex?: number
  lastTxId?: string

  // A hash of current domain transactions, so we could skip all other checks if same.
  domainHashes: Record<Domain, string>

  migrations: Record<string, boolean | string>
}

async function loadDigest (
  ctx: MeasureContext,
  storage: BackupStorage,
  snapshots: BackupSnapshot[],
  domain: Domain,
  date?: number
): Promise<Map<Ref<Doc>, string>> {
  const result = new Map<Ref<Doc>, string>()
  for (const s of snapshots) {
    const d = s.domains[domain]

    // Load old JSON snapshot
    if (d?.snapshot !== undefined) {
      try {
        const dChanges: SnapshotV6 = JSON.parse(
          gunzipSync(new Uint8Array(await storage.loadFile(d.snapshot))).toString()
        )
        for (const [k, v] of Object.entries(dChanges.added)) {
          result.set(k as Ref<Doc>, v)
        }
        for (const [k, v] of Object.entries(dChanges.updated)) {
          result.set(k as Ref<Doc>, v)
        }
        for (const d of dChanges.removed) {
          result.delete(d)
        }
      } catch (err: any) {
        ctx.warn('failed to load digest', { snapshot: d.snapshot })
      }
    }
    for (const snapshot of d?.snapshots ?? []) {
      try {
        const dataBlob = gunzipSync(new Uint8Array(await storage.loadFile(snapshot)))
          .toString()
          .split('\n')
        const addedCount = parseInt(dataBlob.shift() ?? '0')
        const added = dataBlob.splice(0, addedCount)
        for (const it of added) {
          const [k, v] = it.split(';')
          result.set(k as Ref<Doc>, v)
        }

        const updatedCount = parseInt(dataBlob.shift() ?? '0')
        const updated = dataBlob.splice(0, updatedCount)
        for (const it of updated) {
          const [k, v] = it.split(';')
          result.set(k as Ref<Doc>, v)
        }

        const removedCount = parseInt(dataBlob.shift() ?? '0')
        const removed = dataBlob.splice(0, removedCount)
        for (const k of removed) {
          result.delete(k as Ref<Doc>)
        }
      } catch (err: any) {
        ctx.warn('digest is broken, will do full backup for', { domain, err: err.message, snapshot })
      }
    }
    // Stop if stop date is matched and provided
    if (date !== undefined && date === s.date) {
      break
    }
  }
  // ctx.info('load-digest', { domain, snapshots: snapshots.length, documents: result.size })
  return result
}
async function verifyDigest (
  ctx: MeasureContext,
  storage: BackupStorage,
  snapshots: BackupSnapshot[],
  domain: Domain
): Promise<{ modified: boolean, modifiedFiles: string[] }> {
  ctx = ctx.newChild('verify digest', { domain, count: snapshots.length })
  ctx.info('verify-digest', { domain, count: snapshots.length })
  let modified = false
  const modifiedFiles: string[] = []
  for (const s of snapshots) {
    const d = s.domains[domain]
    if (d === undefined) {
      continue
    }

    const storageToRemove = new Set<string>()
    // We need to verify storage has all necessary resources
    ctx.info('checking', { domain })
    // We have required documents here.
    const validDocs = new Set<Ref<Doc>>()
    const zeroEntres = new Set<Ref<Doc>>()

    for (const sf of d.storage ?? []) {
      const blobs = new Map<string, { doc: Doc | undefined, buffer: Buffer | undefined }>()
      try {
        ctx.info('checking storage', { sf })
        const readStream = await storage.load(sf)
        const ex = extract()

        ex.on('entry', (headers, stream, next) => {
          const name = headers.name ?? ''
          // We found blob data
          if (name.endsWith('.json')) {
            const chunks: Buffer[] = []
            const bname = name.substring(0, name.length - 5)
            stream.on('data', (chunk) => {
              chunks.push(chunk)
            })
            stream.on('end', () => {
              try {
                const bf = Buffer.concat(chunks as any)
                const doc = JSON.parse(bf.toString()) as Doc
                if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
                  const data = migradeBlobData(doc as Blob, '')
                  const d = blobs.get(bname) ?? (data !== '' ? Buffer.from(data, 'base64') : undefined)
                  if (d === undefined) {
                    blobs.set(bname, { doc, buffer: undefined })
                  } else {
                    blobs.delete(bname)
                  }
                }
                validDocs.add(bname as Ref<Doc>)
              } catch (err: any) {
                // If not a json, skip
              }
              next()
            })
          } else {
            if (headers.size === 0) {
              zeroEntres.add(name as any)
            }
            next()
          }
          stream.resume() // just auto drain the stream
        })

        const unzip = createGunzip({ level: defaultLevel })
        const endPromise = new Promise((resolve, reject) => {
          readStream.on('error', (err) => {
            console.error(err)
            reject(err)
          })
          ex.on('finish', () => {
            resolve(null)
          })
          unzip.on('error', (err) => {
            ctx.error('error during reading of', { sf, err })
            modified = true
            storageToRemove.add(sf)
            resolve(null)
          })
        })

        readStream.on('end', () => {
          readStream.destroy()
        })
        readStream.pipe(unzip)
        unzip.pipe(ex)

        await endPromise
      } catch (err: any) {
        ctx.error('error during reading of', { sf, err })
        // In case of invalid archive, we need to
        // We need to remove broken storage file
        modified = true
        storageToRemove.add(sf)
      }
    }

    // Clear zero files, they potentially wrong downloaded.
    for (const zz of zeroEntres.values()) {
      validDocs.delete(zz)
    }
    if (storageToRemove.size > 0) {
      modified = true
      d.storage = (d.storage ?? []).filter((it) => !storageToRemove.has(it))
      modifiedFiles.push(...Array.from(storageToRemove))
      for (const sf of storageToRemove) {
        await storage.delete(sf)
      }
    }
    let mfiles: string[] = []
    ;({ modified, modifiedFiles: mfiles } = await updateDigest(d, ctx, storage, validDocs, modified, domain))
    modifiedFiles.push(...mfiles)
  }
  ctx.end()
  return { modified, modifiedFiles }
}

async function updateDigest (
  d: DomainData,
  ctx: MeasureContext<any>,
  storage: BackupStorage,
  validDocs: Set<Ref<Doc>>,
  modified: boolean,
  domain: Domain
): Promise<{ modified: boolean, modifiedFiles: string[] }> {
  const digestToRemove = new Set<string>()
  const modifiedFiles: string[] = []
  for (const snapshot of d?.snapshots ?? []) {
    try {
      ctx.info('checking', { snapshot })
      const changes: Snapshot = {
        added: new Map(),
        removed: [],
        updated: new Map()
      }
      let lmodified = false
      try {
        const dataBlob = gunzipSync(new Uint8Array(await storage.loadFile(snapshot)))
          .toString()
          .split('\n')
        const addedCount = parseInt(dataBlob.shift() ?? '0')
        const added = dataBlob.splice(0, addedCount)
        for (const it of added) {
          const [k, v] = it.split(';')
          if (validDocs.has(k as any)) {
            changes.added.set(k as Ref<Doc>, v)
          } else {
            lmodified = true
          }
        }

        const updatedCount = parseInt(dataBlob.shift() ?? '0')
        const updated = dataBlob.splice(0, updatedCount)
        for (const it of updated) {
          const [k, v] = it.split(';')
          if (validDocs.has(k as any)) {
            changes.updated.set(k as Ref<Doc>, v)
          } else {
            lmodified = true
          }
        }

        const removedCount = parseInt(dataBlob.shift() ?? '0')
        const removed = dataBlob.splice(0, removedCount)
        changes.removed = removed as Ref<Doc>[]
        if (addedCount === 0 && removedCount === 0 && updatedCount === 0) {
          // Empty digest, need to clean
          digestToRemove.add(snapshot)
          lmodified = true
        }
      } catch (err: any) {
        ctx.warn('failed during processing of snapshot file, it will be skipped', { snapshot })
        digestToRemove.add(snapshot)
        modified = true
      }

      if (lmodified) {
        modified = true
        if (digestToRemove.has(snapshot)) {
          await storage.delete(snapshot) // No need for digest, lets' remove it
        } else {
          // Store changes without missing files
          await writeChanges(storage, snapshot, changes)
        }
      }
    } catch (err: any) {
      digestToRemove.add(snapshot)
      modifiedFiles.push(snapshot)
      ctx.warn('digest is broken, will do full backup for', { domain, err: err.message, snapshot })
      modified = true
    }
  }
  d.snapshots = (d.snapshots ?? []).filter((it) => !digestToRemove.has(it))
  return { modified, modifiedFiles }
}

async function write (chunk: any, stream: Writable): Promise<void> {
  let needDrain = false
  await new Promise((resolve, reject) => {
    needDrain = !stream.write(chunk, (err) => {
      if (err != null) {
        reject(err)
      } else {
        resolve(null)
      }
    })
  })
  if (needDrain) {
    await new Promise((resolve) => stream.once('drain', resolve))
  }
}

async function writeChanges (storage: BackupStorage, snapshot: string, changes: Snapshot): Promise<void> {
  const snapshotWritable = await storage.write(snapshot)
  const writable = createGzip({ level: defaultLevel })
  writable.pipe(snapshotWritable)

  // Write size
  await write(`${changes.added.size}\n`, writable)
  for (const [k, v] of changes.added.entries()) {
    await write(`${k};${v}\n`, writable)
  }
  await write(`${changes.updated.size}\n`, writable)
  for (const [k, v] of changes.updated.entries()) {
    await write(`${k};${v}\n`, writable)
  }
  await write(`${changes.removed.length}\n`, writable)
  for (const k of changes.removed) {
    await write(`${k}\n`, writable)
  }
  writable.end()
  await new Promise((resolve) => {
    writable.flush(() => {
      resolve(null)
    })
  })
}

/**
 * @public
 */
export async function cloneWorkspace (
  ctx: MeasureContext,
  transactorUrl: string,
  sourceWorkspaceId: WorkspaceUuid,
  targetWorkspaceId: WorkspaceUuid,
  clearTime: boolean = true,
  progress: (value: number) => Promise<void>,
  storageAdapter: StorageAdapter
): Promise<void> {
  // TODO: FIXME
  throw new Error('Not implemented')
  // await ctx.with(
  //   'clone-workspace',
  //   {},
  //   async (ctx) => {
  //     const sourceConnection = await ctx.with(
  //       'connect-source',
  //       {},
  //       async (ctx) =>
  //         (await connect(transactorUrl, sourceWorkspaceId, undefined, {
  //           mode: 'backup'
  //         })) as unknown as CoreClient & BackupClient
  //     )
  //     const targetConnection = await ctx.with(
  //       'connect-target',
  //       {},
  //       async (ctx) =>
  //         (await connect(transactorUrl, targetWorkspaceId, undefined, {
  //           mode: 'backup',
  //           model: 'upgrade',
  //           admin: 'true'
  //         })) as unknown as CoreClient & BackupClient
  //     )
  //     try {
  //       const domains = sourceConnection
  //         .getHierarchy()
  //         .domains()
  //         .filter((it) => it !== DOMAIN_TRANSIENT && it !== DOMAIN_MODEL)

  //       let i = 0
  //       for (const c of domains) {
  //         ctx.info('clone domain...', { domain: c, workspace: targetWorkspaceId })

  //         // We need to clean target connection before copying something.
  //         await ctx.with('clean-domain', { domain: c }, (ctx) => cleanDomain(ctx, targetConnection, c))

  //         const changes: Snapshot = {
  //           added: new Map(),
  //           updated: new Map(),
  //           removed: []
  //         }

  //         let idx: number | undefined

  //         // update digest tar
  //         const needRetrieveChunks: Ref<Doc>[][] = []

  //         let processed = 0
  //         let domainProgress = 0
  //         let st = Date.now()
  //         // Load all digest from collection.
  //         await ctx.with('retrieve-domain-info', { domain: c }, async (ctx) => {
  //           while (true) {
  //             try {
  //               const it = await ctx.with('load-chunk', {}, () => sourceConnection.loadChunk(c, idx))
  //               idx = it.idx

  //               let needRetrieve: Ref<Doc>[] = []

  //               for (const { id, hash } of it.docs) {
  //                 processed++
  //                 if (Date.now() - st > 2500) {
  //                   ctx.info('processed', { processed, time: Date.now() - st, workspace: targetWorkspaceId })
  //                   st = Date.now()
  //                 }

  //                 changes.added.set(id as Ref<Doc>, hash)
  //                 needRetrieve.push(id as Ref<Doc>)

  //                 if (needRetrieve.length > 200) {
  //                   needRetrieveChunks.push(needRetrieve)
  //                   needRetrieve = []
  //                 }
  //               }
  //               if (needRetrieve.length > 0) {
  //                 needRetrieveChunks.push(needRetrieve)
  //               }
  //               if (it.finished) {
  //                 ctx.info('processed-end', { processed, time: Date.now() - st, workspace: targetWorkspaceId })
  //                 await ctx.with('close-chunk', {}, async () => {
  //                   await sourceConnection.closeChunk(idx as number)
  //                 })
  //                 break
  //               }
  //             } catch (err: any) {
  //               ctx.error('failed to clone', { err, workspace: targetWorkspaceId })
  //               if (idx !== undefined) {
  //                 await ctx.with('load-chunk', {}, () => sourceConnection.closeChunk(idx as number))
  //               }
  //               // Try again
  //               idx = undefined
  //               processed = 0
  //             }
  //           }
  //         })
  //         await ctx.with('clone-domain', { domain: c }, async (ctx) => {
  //           while (needRetrieveChunks.length > 0) {
  //             const needRetrieve = needRetrieveChunks.shift() as Ref<Doc>[]

  //             ctx.info('Retrieve chunk:', { count: needRetrieve.length })
  //             let docs: Doc[] = []
  //             try {
  //               docs = await ctx.with('load-docs', {}, (ctx) => sourceConnection.loadDocs(c, needRetrieve))
  //               if (clearTime) {
  //                 docs = prepareClonedDocuments(docs)
  //               }
  //               const executor = new RateLimiter(10)
  //               for (const d of docs) {
  //                 if (d._class === core.class.Blob) {
  //                   const blob = d as Blob
  //                   await executor.add(async () => {
  //                     try {
  //                       ctx.info('clone blob', { name: blob._id, contentType: blob.contentType })
  //                       const readable = await storageAdapter.get(ctx, sourceWorkspaceId, blob._id)
  //                       const passThrue = new PassThrough()
  //                       readable.pipe(passThrue)
  //                       await storageAdapter.put(
  //                         ctx,
  //                         targetWorkspaceId,
  //                         blob._id,
  //                         passThrue,
  //                         blob.contentType,
  //                         blob.size
  //                       )
  //                     } catch (err: any) {
  //                       Analytics.handleError(err)
  //                       console.error(err)
  //                     }
  //                     domainProgress++
  //                     await progress((100 / domains.length) * i + (100 / domains.length / processed) * domainProgress)
  //                   })
  //                 } else {
  //                   domainProgress++
  //                 }
  //               }
  //               await executor.waitProcessing()
  //               await ctx.with('upload-docs', {}, (ctx) => targetConnection.upload(c, docs), { length: docs.length })
  //               await progress((100 / domains.length) * i + (100 / domains.length / processed) * domainProgress)
  //             } catch (err: any) {
  //               console.log(err)
  //               Analytics.handleError(err)
  //               // Put back.
  //               needRetrieveChunks.push(needRetrieve)
  //               continue
  //             }
  //           }
  //         })

  //         i++
  //         await progress((100 / domains.length) * i)
  //       }
  //     } catch (err: any) {
  //       console.error(err)
  //       Analytics.handleError(err)
  //     } finally {
  //       ctx.info('end clone')
  //       await ctx.with('close-source', {}, async (ctx) => {
  //         await sourceConnection.close()
  //       })
  //       await ctx.with('close-target', {}, async (ctx) => {
  //         await targetConnection.sendForceClose()
  //         await targetConnection.close()
  //       })
  //     }
  //   },
  //   {
  //     source: sourceWorkspaceId,
  //     target: targetWorkspaceId
  //   }
  // )
}

// async function cleanDomain (ctx: MeasureContext, connection: CoreClient & BackupClient, domain: Domain): Promise<void> {
//   // Load all digest from collection.
//   let idx: number | undefined
//   const ids: Ref<Doc>[] = []
//   while (true) {
//     try {
//       const it = await connection.loadChunk(domain, idx)
//       idx = it.idx

//       ids.push(...it.docs.map((it) => it.id as Ref<Doc>))
//       if (it.finished) {
//         break
//       }
//     } catch (err: any) {
//       console.error(err)
//       if (idx !== undefined) {
//         await connection.closeChunk(idx)
//       }
//     }
//   }
//   while (ids.length > 0) {
//     const part = ids.splice(0, 5000)
//     await connection.clean(domain, part)
//   }
// }

function doTrimHash (s: string | undefined): string | undefined {
  if (s == null) {
    return undefined
  }
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, s.length - 1)
  }
  return s
}

export interface BackupResult extends Omit<BackupStatus, 'backups' | 'lastBackup'> {
  result: boolean
}

/**
 * @public
 */
export async function backup (
  ctx: MeasureContext,
  transactorUrl: string,
  wsIds: WorkspaceIds,
  storage: BackupStorage,
  options: {
    include?: Set<string>
    skipDomains: string[]
    force: boolean
    timeout: number
    connectTimeout: number
    skipBlobContentTypes: string[]
    blobDownloadLimit: number
    getLastTx?: () => Promise<Tx | undefined>
    getConnection?: () => Promise<CoreClient & BackupClient>
    storageAdapter?: StorageAdapter
    // Return true in case
    isCanceled?: () => boolean
    progress?: (progress: number) => Promise<void>
    token?: string
    fullVerify?: boolean
    keepSnapshots: number
  } = {
    force: false,
    timeout: 0,
    skipDomains: [],
    connectTimeout: 30000,
    skipBlobContentTypes: ['video/'],
    blobDownloadLimit: 15,
    keepSnapshots: 7 * 12
  }
): Promise<BackupResult> {
  const result: BackupResult = {
    result: false,
    dataSize: 0,
    blobsSize: 0,
    backupSize: 0
  }
  const workspaceId = wsIds.uuid
  ctx = ctx.newChild('backup', {})

  let _canceled = false
  const canceled = (): boolean => {
    return _canceled || (options.isCanceled?.() ?? false)
  }

  let timer: any
  let ops = 0

  if (options.timeout > 0) {
    timer = setInterval(() => {
      if (ops === 0) {
        ctx.error('Timeout during backup', { workspace: workspaceId, timeout: options.timeout / 1000 })
        ops = 0
        _canceled = true
      }
    }, options.timeout)
  }

  const st = Date.now()
  let connection!: CoreClient & BackupClient
  let printEnd = true

  const tmpRoot = mkdtempSync('huly')

  try {
    let backupInfo: BackupInfo = {
      workspace: workspaceId,
      version: '0.6.2',
      snapshots: [],
      domainHashes: {},
      migrations: {
        zeroCheckSize: true, // Assume already checked for new backups
        forcedFullCheck: '1' // A force to full recheck.
      }
    }

    // Version 0.6.2, format of digest file is changed to

    const infoFile = 'backup.json.gz'

    if (await storage.exists(infoFile)) {
      backupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
    }
    backupInfo.version = '0.6.2'

    if (backupInfo.migrations == null) {
      backupInfo.migrations = {}
    }

    const forcedFullCheck = '2'

    // Apply verification to backup, since we know it should have broken blobs
    if (backupInfo.migrations.zeroCheckSize == null) {
      await checkBackupIntegrity(ctx, storage)
      if (await storage.exists(infoFile)) {
        backupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
      }
      if (backupInfo.migrations == null) {
        backupInfo.migrations = {}
      }
      backupInfo.migrations.zeroCheckSize = true
      await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
    }

    backupInfo.workspace = workspaceId

    if (backupInfo.domainHashes === undefined) {
      // Migration
      backupInfo.domainHashes = {}
    }

    if (backupInfo.domainHashes === undefined) {
      // Migration
      backupInfo.domainHashes = {}
    }

    let fullCheck = options.fullVerify === true

    if (backupInfo.migrations.forcedFullCheck !== forcedFullCheck) {
      // We have forced full check to be performed.
      fullCheck = true
    }
    if (backupInfo.snapshots.length > options.keepSnapshots) {
      // We need to perform compaction
      ctx.warn('Compacting backup')
      await compactBackup(ctx, storage, true, {
        blobLimit: options.blobDownloadLimit,
        skipContentTypes: options.skipBlobContentTypes
      })
      backupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())

      // Enable full check, just in case.
      fullCheck = true
    }

    let lastTx: Tx | undefined

    let lastTxChecked = false
    // Skip backup if there is no transaction changes.
    if (options.getLastTx !== undefined && !fullCheck) {
      lastTx = await options.getLastTx()
      if (lastTx !== undefined) {
        if (lastTx._id === backupInfo.lastTxId && !options.force) {
          printEnd = false
          ctx.info('No transaction changes. Skipping backup.', { workspace: workspaceId })
          result.result = false
          return result
        }
      }
      lastTxChecked = true
    }
    const token =
      options.token ??
      generateToken(systemAccountUuid, workspaceId, {
        service: 'backup',
        mode: 'backup'
      })

    ctx.warn('starting backup', { workspace: workspaceId })

    connection =
      options.getConnection !== undefined
        ? await options.getConnection()
        : ((await createClient(transactorUrl, token, undefined, options.connectTimeout)) as CoreClient & BackupClient)

    if (!lastTxChecked && !fullCheck) {
      lastTx = await connection.findOne(
        core.class.Tx,
        { objectSpace: { $ne: core.space.Model } },
        { limit: 1, sort: { modifiedOn: SortingOrder.Descending } }
      )
      if (lastTx !== undefined) {
        if (lastTx._id === backupInfo.lastTxId && !options.force) {
          ctx.info('No transaction changes. Skipping backup.', { workspace: workspaceId })
          if (options.getConnection === undefined) {
            await connection.close()
          }
          result.result = false
          return result
        }
      }
    }

    const blobClient = new BlobClient(transactorUrl, token, wsIds, { storageAdapter: options.storageAdapter })

    const domains = [
      DOMAIN_BLOB,
      DOMAIN_MODEL_TX,
      DOMAIN_TX,
      ...connection
        .getHierarchy()
        .domains()
        .filter(
          (it) =>
            it !== DOMAIN_TRANSIENT &&
            it !== DOMAIN_MODEL &&
            it !== DOMAIN_MODEL_TX &&
            it !== DOMAIN_TX &&
            it !== DOMAIN_BLOB &&
            it !== ('fulltext-blob' as Domain) &&
            !options.skipDomains.includes(it) &&
            (options.include === undefined || options.include.has(it))
        )
    ]

    ctx.info('domains for dump', { domains: domains.length })

    backupInfo.lastTxId = '' // Clear until full backup will be complete

    const recheckSizes: string[] = []

    const snapshot: BackupSnapshot = {
      date: Date.now(),
      domains: {},
      stIndex: 0
    }

    // Increment snapshot index
    backupInfo.snapshotsIndex = (backupInfo.snapshotsIndex ?? backupInfo.snapshots.length) + 1
    let backupIndex = `${backupInfo.snapshotsIndex}`
    backupInfo.snapshots.push(snapshot)
    while (backupIndex.length < 6) {
      backupIndex = '0' + backupIndex
    }

    let downloadedMb = 0
    let downloaded = 0

    const printDownloaded = (msg: string, size?: number | null, pending?: number): void => {
      if (size == null || Number.isNaN(size) || !Number.isInteger(size)) {
        return
      }
      ops++
      downloaded += size
      const newDownloadedMb = Math.round(downloaded / (1024 * 1024))
      const newId = Math.round(newDownloadedMb / 10)
      if (downloadedMb !== newId) {
        downloadedMb = newId
        ctx.info('downloaded', {
          msg,
          written: newDownloadedMb,
          pending
        })
      }
    }

    async function loadChangesFromServer (
      ctx: MeasureContext,
      domain: Domain,
      digest: Map<Ref<Doc>, string>,
      changes: Snapshot,
      same: Map<Ref<Doc>, string>
    ): Promise<{ changed: number, needRetrieveChunks: Ref<Doc>[][] }> {
      let idx: number | undefined
      let processed = 0
      let st = Date.now()
      let changed: number = 0
      const needRetrieveChunks: Ref<Doc>[][] = []
      const oldHash = new Map<Ref<Doc>, string>()

      function removeFromNeedRetrieve (needRetrieve: Ref<Doc>[], id: string): void {
        const pos = needRetrieve.indexOf(id as Ref<Doc>)
        if (pos !== -1) {
          needRetrieve.splice(pos, 1)
          processed--
          changed--
        }
        for (const ch of needRetrieveChunks) {
          const pos = ch.indexOf(id as Ref<Doc>)
          if (pos !== -1) {
            ch.splice(pos, 1)
            processed--
            changed--
          }
        }
      }
      while (true) {
        try {
          const currentChunk = await ctx.with('loadChunk', {}, () => connection.loadChunk(domain, idx))
          if (domain === DOMAIN_BLOB) {
            result.blobsSize += currentChunk.size ?? 0
          } else {
            result.dataSize += currentChunk.size ?? 0
          }

          idx = currentChunk.idx
          ops++

          let needRetrieve: Ref<Doc>[] = []

          for (const { id, hash, contentType } of currentChunk.docs) {
            processed++
            if (
              domain === DOMAIN_BLOB &&
              contentType !== undefined &&
              options.skipBlobContentTypes.length > 0 &&
              options.skipBlobContentTypes.some((it) => contentType.includes(it))
            ) {
              continue
            }
            if (Date.now() - st > 2500) {
              ctx.info('processed', {
                processed,
                digest: digest.size,
                time: Date.now() - st,
                workspace: workspaceId
              })
              st = Date.now()
            }
            const serverDocHash = doTrimHash(hash) as string
            const currentHash = doTrimHash(digest.get(id as Ref<Doc>) ?? oldHash.get(id as Ref<Doc>))
            if (currentHash !== undefined) {
              const oldD = digest.get(id as Ref<Doc>)
              if (digest.delete(id as Ref<Doc>)) {
                if (oldD !== undefined) {
                  same.set(id as Ref<Doc>, oldD)
                }
                oldHash.set(id as Ref<Doc>, currentHash)
              }
              if (currentHash !== serverDocHash) {
                if (changes.updated.has(id as Ref<Doc>)) {
                  removeFromNeedRetrieve(needRetrieve, id as Ref<Doc>)
                }
                changes.updated.set(id as Ref<Doc>, serverDocHash)
                needRetrieve.push(id as Ref<Doc>)
                changed++
              } else if (changes.updated.has(id as Ref<Doc>)) {
                // We have same
                changes.updated.delete(id as Ref<Doc>)
                removeFromNeedRetrieve(needRetrieve, id as Ref<Doc>)
                processed -= 1
              }
            } else {
              if (domain === DOMAIN_BLOB && changes.added.has(id as Ref<Doc>)) {
                // We need to clean old need retrieve in case of duplicates.
                removeFromNeedRetrieve(needRetrieve, id)
              }
              changes.added.set(id as Ref<Doc>, serverDocHash)
              needRetrieve.push(id as Ref<Doc>)
              changed++
            }

            if (needRetrieve.length > batchSize) {
              needRetrieveChunks.push(needRetrieve)
              needRetrieve = []
            }
          }
          if (needRetrieve.length > 0) {
            needRetrieveChunks.push(needRetrieve)
            needRetrieve = []
          }
          if (currentChunk.finished) {
            ctx.info('processed', {
              processed,
              digest: digest.size,
              time: Date.now() - st,
              workspace: workspaceId
            })
            await ctx.with('closeChunk', {}, async () => {
              await connection.closeChunk(idx as number)
            })
            break
          }
        } catch (err: any) {
          ctx.error('failed to load chunks', { error: err })
          if (idx !== undefined) {
            await ctx.with('closeChunk', {}, async () => {
              await connection.closeChunk(idx as number)
            })
          }
          // Try again
          idx = undefined
          processed = 0
        }
      }
      return { changed, needRetrieveChunks }
    }

    async function processDomain (
      ctx: MeasureContext,
      domain: Domain,
      progress: (value: number) => Promise<void>
    ): Promise<void> {
      const changes: Snapshot = {
        added: new Map(),
        updated: new Map(),
        removed: []
      }

      const processedChanges: Snapshot = {
        added: new Map(),
        updated: new Map(),
        removed: []
      }

      let stIndex = 0
      let snapshotIndex = 0
      const domainInfo: DomainData = {
        snapshot: undefined,
        snapshots: [],
        storage: [],
        added: 0,
        updated: 0,
        removed: 0
      }

      const dHash = await connection.getDomainHash(domain)
      if (backupInfo.domainHashes[domain] === dHash && !fullCheck) {
        ctx.info('no changes in domain', { domain })
        return
      }
      // Cumulative digest
      const digest = await ctx.with('load-digest', {}, (ctx) => loadDigest(ctx, storage, backupInfo.snapshots, domain))
      const same = new Map<Ref<Doc>, string>()

      let _pack: Pack | undefined
      let _packClose = async (): Promise<void> => {}
      let addedDocuments = (): number => 0

      if (progress !== undefined) {
        await progress(0)
      }
      let { changed, needRetrieveChunks } = await ctx.with('load-chunks', { domain }, (ctx) =>
        loadChangesFromServer(ctx, domain, digest, changes, same)
      )
      processedChanges.removed = Array.from(digest.keys())
      digest.clear()

      if (fullCheck && domain !== DOMAIN_BLOB && same.size > 0) {
        // We need to verify existing documents are correct
        const rsnapshots = Array.from(backupInfo.snapshots).reverse()
        // We need to load all documents locally and from server and compare
        for (const s of rsnapshots) {
          const d = s.domains[domain]
          if (d == null) {
            continue
          }
          let needRetrieve: Ref<Doc>[] = []
          const { modified, modifiedFiles } = await verifyDocsFromSnapshot(
            ctx,
            domain,
            d,
            s,
            storage,
            same,
            async (docs) => {
              const serverDocs = await connection.loadDocs(
                domain,
                docs.map((it) => it._id)
              )
              const smap = toIdMap(serverDocs)
              for (const localDoc of docs) {
                if (TxProcessor.isExtendsCUD(localDoc._class)) {
                  const tx = localDoc as TxCUD<Doc>
                  if (tx.objectSpace == null) {
                    tx.objectSpace = core.space.Workspace
                  }
                }
                const serverDoc = smap.get(localDoc._id)
                if (serverDoc === undefined) {
                  // We do not have a doc on server already, ignore it.
                } else {
                  const { '%hash%': _h1, ...dData } = localDoc as any
                  const { '%hash%': _h2, ...sData } = serverDoc as any

                  const dsame = deepEqual(dData, sData)
                  if (!dsame) {
                    needRetrieve.push(localDoc._id)
                    changes.updated.set(localDoc._id, same.get(localDoc._id) ?? '')
                    // Docs are not same
                    if (needRetrieve.length > batchSize) {
                      needRetrieveChunks.push(needRetrieve)
                      needRetrieve = []
                    }
                  }
                }
              }
            },
            batchSize
          )
          if (modified) {
            changed++
            recheckSizes.push(...modifiedFiles)
          }
          if (needRetrieve.length > 0) {
            needRetrieveChunks.push(needRetrieve)
            needRetrieve = []
          }
        }
        // We need to retrieve all documents from same not matched
        const sameArray: Ref<Doc>[] = Array.from(same.keys())
        while (sameArray.length > 0) {
          const docs = sameArray.splice(0, batchSize)
          needRetrieveChunks.push(docs)
        }
      } else {
        same.clear()
      }

      if (progress !== undefined) {
        await progress(10)
      }
      const totalChunks = needRetrieveChunks.flatMap((it) => it.length).reduce((p, c) => p + c, 0)
      let processed = 0

      try {
        global.gc?.()
      } catch (err) {}

      let lastSize = 0

      while (needRetrieveChunks.length > 0) {
        if (canceled()) {
          return
        }
        const needRetrieve = needRetrieveChunks.shift() as Ref<Doc>[]

        if (needRetrieve.length === 0) {
          continue
        }
        ctx.info('<<<< chunk', {
          needRetrieve: needRetrieveChunks.reduce((v, docs) => v + docs.length, 0),
          toLoad: needRetrieve.length,
          workspace: workspaceId,
          lastSize: Math.round((lastSize * 100) / (1024 * 1024)) / 100
        })
        let docs: Doc[] = []
        try {
          docs = await ctx.with('<<<< load-docs', {}, async () => await connection.loadDocs(domain, needRetrieve))
          lastSize = docs.reduce((p, it) => p + estimateDocSize(it), 0)
          if (docs.length !== needRetrieve.length) {
            ctx.error('failed to retrieve all documents', {
              docsLen: docs.length,
              needRetrieve: needRetrieve.length
            })
          }
          ops++
        } catch (err: any) {
          ctx.error('error loading docs', { domain, err, workspace: workspaceId })
          // Put back.
          needRetrieveChunks.push(needRetrieve)
          continue
        }

        while (docs.length > 0) {
          // Chunk data into small pieces
          if (
            (addedDocuments() > dataBlobSize || processedChanges.added.size + processedChanges.updated.size > 500000) &&
            _pack !== undefined
          ) {
            await _packClose()

            if (changed > 0) {
              try {
                global.gc?.()
              } catch (err) {}
              snapshot.domains[domain] = domainInfo
              domainInfo.added += processedChanges.added.size
              domainInfo.updated += processedChanges.updated.size
              domainInfo.removed += processedChanges.removed.length

              const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${extendZero(snapshotIndex)}.snp.gz`)
              snapshotIndex++
              domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
              await writeChanges(storage, snapshotFile, processedChanges)

              processedChanges.added.clear()
              processedChanges.removed = []
              processedChanges.updated.clear()
              await storage.writeFile(
                infoFile,
                gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel, memLevel: 9 })
              )
            }
          }
          if (_pack === undefined) {
            _pack = pack()
            stIndex++
            const storageFile = join(backupIndex, `${domain}-data-${snapshot.date}-${extendZero(stIndex)}.tar.gz`)
            domainInfo.storage = [...(domainInfo.storage ?? []), storageFile]
            const tmpFile = join(tmpRoot, basename(storageFile) + '.tmp')
            const tempFile = createWriteStream(tmpFile)
            // const dataStream = await storage.write(storageFile)

            const sizePass = new PassThrough()
            let sz = 0
            sizePass._transform = (chunk, encoding, cb) => {
              // No transformation, just pass through data
              sz += chunk.length
              sizePass.push(chunk)
              cb()
            }

            sizePass.pipe(tempFile)

            const storageZip = createGzip({ level: defaultLevel, memLevel: 9 })
            addedDocuments = () => sz
            _pack.pipe(storageZip)
            storageZip.pipe(sizePass)

            _packClose = async () => {
              await new Promise<void>((resolve) => {
                tempFile.on('close', () => {
                  resolve()
                })
                _pack?.finalize()
              })

              // We need to upload file to storage
              ctx.info('>>>> upload pack', { storageFile, size: sz, workspace: wsIds.url })
              await storage.writeFile(storageFile, createReadStream(tmpFile))
              await rm(tmpFile)

              _pack = undefined
            }
          }
          if (canceled()) {
            return
          }
          const d = docs.shift()
          if (d === undefined) {
            break
          }

          function processChanges (d: Doc, error: boolean = false): void {
            processed++
            // Move processed document to processedChanges
            if (changes.added.has(d._id)) {
              if (!error) {
                processedChanges.added.set(d._id, changes.added.get(d._id) ?? '')
              }
              changes.added.delete(d._id)
            } else {
              if (!error) {
                processedChanges.updated.set(d._id, changes.updated.get(d._id) ?? '')
              }
              changes.updated.delete(d._id)
            }
          }
          if (d._class === core.class.Blob) {
            const blob = d as Blob
            const descrJson = JSON.stringify(d)

            if (blob.size > options.blobDownloadLimit * 1024 * 1024) {
              ctx.info('skip blob download, limit excheed', {
                blob: blob._id,
                provider: blob.provider,
                size: Math.round(blob.size / (1024 * 1024)),
                limit: options.blobDownloadLimit
              })
              processChanges(d, true)
              if (progress !== undefined) {
                await progress(10 + (processed / totalChunks) * 90)
              }
              continue
            }

            if (
              options.skipBlobContentTypes.length > 0 &&
              options.skipBlobContentTypes.some((it) => blob.contentType.includes(it))
            ) {
              processChanges(d, true)
              if (progress !== undefined) {
                await progress(10 + (processed / totalChunks) * 90)
              }
              continue
            }

            let blobFiled = false

            printDownloaded(
              '',
              descrJson.length,
              needRetrieveChunks.reduce((v, docs) => v + docs.length, 0) + docs.length
            )
            try {
              const buffers: Buffer[] = []
              await blobClient.writeTo(ctx, blob._id, blob.size, {
                write (buffer, cb) {
                  buffers.push(buffer)
                  cb()
                },
                end: (cb: () => void) => {
                  cb()
                }
              })

              const finalBuffer = Buffer.concat(buffers as any)
              if (finalBuffer.length !== blob.size) {
                ctx.error('download blob size mismatch', {
                  _id: blob._id,
                  contentType: blob.contentType,
                  size: blob.size,
                  bufferSize: finalBuffer.length,
                  provider: blob.provider
                })
              }
              await new Promise<void>((resolve, reject) => {
                _pack?.entry({ name: d._id + '.json' }, descrJson, (err) => {
                  if (err != null) reject(err)
                  resolve()
                })
              })
              await new Promise<void>((resolve, reject) => {
                _pack?.entry({ name: d._id, size: finalBuffer.length }, finalBuffer, (err) => {
                  if (err != null) {
                    reject(err)
                  }
                  resolve()
                })
              })

              printDownloaded('', blob.size, needRetrieveChunks.reduce((v, docs) => v + docs.length, 0) + docs.length)
            } catch (err: any) {
              if (err.message?.startsWith('No file for') === true) {
                ctx.error('failed to download blob', { message: err.message })
              } else {
                ctx.error('failed to download blob', { err })
              }
              blobFiled = true
            }

            processChanges(d, blobFiled)
          } else {
            const data = JSON.stringify(d)
            await new Promise<void>((resolve, reject) => {
              _pack?.entry({ name: d._id + '.json' }, data, function (err) {
                if (err != null) reject(err)
                resolve()
              })
            })
            processChanges(d)
            printDownloaded('', data.length, needRetrieveChunks.reduce((v, docs) => v + docs.length, 0) + docs.length)
          }
        }
      }

      if (processedChanges.removed.length > 0) {
        changed++
      }

      if (changed > 0 || (domain !== DOMAIN_BLOB && backupInfo.domainHashes[domain] !== dHash)) {
        // Store domain hash, to be used on next time.
        backupInfo.domainHashes[domain] = dHash

        domainInfo.added += processedChanges.added.size
        domainInfo.updated += processedChanges.updated.size
        domainInfo.removed += processedChanges.removed.length
        if (domainInfo.added + domainInfo.updated + domainInfo.removed > 0) {
          snapshot.domains[domain] = domainInfo

          const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${extendZero(snapshotIndex)}.snp.gz`)
          snapshotIndex++
          domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
          await writeChanges(storage, snapshotFile, processedChanges)
        }

        processedChanges.added.clear()
        processedChanges.removed = []
        processedChanges.updated.clear()
        await _packClose()
        // This will allow to retry in case of critical error.
        await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
      }
    }

    let domainProgress = 0
    for (const domain of domains) {
      if (canceled()) {
        break
      }
      const oldUsed = process.memoryUsage().heapUsed
      try {
        global.gc?.()
      } catch (err) {}

      const mm = {
        old: Math.round(oldUsed / (1024 * 1024)),
        current: Math.round(process.memoryUsage().heapUsed / (1024 * 1024))
      }
      if (mm.old > mm.current + mm.current / 10) {
        ctx.info('memory-stats', mm)
      }
      await ctx.with('process-domain', { domain }, async (ctx) => {
        await processDomain(
          ctx,
          domain,
          (value) =>
            options.progress?.(Math.round(((domainProgress + value / 100) / domains.length) * 100)) ?? Promise.resolve()
        )
      })
      domainProgress++
      await options.progress?.(Math.round((domainProgress / domains.length) * 10000) / 100)
    }
    if (!canceled()) {
      backupInfo.lastTxId = lastTx?._id ?? '0' // We could store last tx, since full backup is complete
      await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
    }
    result.result = true

    if (!canceled()) {
      backupInfo.lastTxId = lastTx?._id ?? '0' // We could store last tx, since full backup is complete
      backupInfo.migrations.forcedFullCheck = forcedFullCheck
      await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
    }

    await rebuildSizeInfo(storage, recheckSizes, ctx, result, backupInfo, infoFile)

    return result
  } catch (err: any) {
    ctx.error('backup error', { err, workspace: workspaceId })
    return result
  } finally {
    await rm(tmpRoot, { recursive: true })
    if (printEnd) {
      ctx.info('end backup', { workspace: workspaceId, totalTime: Date.now() - st })
    }
    if (options.getConnection === undefined && connection !== undefined) {
      await connection.close()
    }
    ctx.end()
    if (options.timeout !== -1) {
      clearInterval(timer)
    }
  }
}

async function rebuildSizeInfo (
  storage: BackupStorage,
  recheckSizes: string[],
  ctx: MeasureContext<any>,
  result: BackupResult,
  backupInfo: BackupInfo,
  infoFile: string
): Promise<void> {
  const sizeFile = 'backup.size.gz'

  let sizeInfo: Record<string, number> = {}

  if (await storage.exists(sizeFile)) {
    sizeInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(sizeFile))).toString())
  }
  let processed = 0

  for (const file of recheckSizes) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete sizeInfo[file]
  }

  const addFileSize = async (file: string | undefined | null): Promise<void> => {
    if (file != null) {
      try {
        const sz = sizeInfo[file]
        const fileSize = sz ?? (await storage.stat(file))
        if (sz === undefined) {
          sizeInfo[file] = fileSize
          processed++
          if (processed % 10 === 0) {
            ctx.info('Calculate size processed', { processed, size: Math.round(result.backupSize / (1024 * 1024)) })
          }
        }
        result.backupSize += fileSize
      } catch (err: any) {
        ctx.error('failed to calculate size', { file, err })
      }
    }
  }

  // Let's calculate data size for backup
  for (const sn of backupInfo.snapshots) {
    for (const [, d] of Object.entries(sn.domains)) {
      await addFileSize(d.snapshot)
      for (const snp of d.snapshots ?? []) {
        await addFileSize(snp)
      }
      for (const snp of d.storage ?? []) {
        await addFileSize(snp)
      }
    }
  }
  await addFileSize(infoFile)

  await storage.writeFile(sizeFile, gzipSync(JSON.stringify(sizeInfo, undefined, 2), { level: defaultLevel }))
}

/**
 * @public
 */
export async function backupList (storage: BackupStorage): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)
  for (const s of backupInfo.snapshots) {
    console.log('snapshot: id:', s.date, ' date:', new Date(s.date))
  }
}

/**
 * @public
 */
export async function backupRemoveLast (storage: BackupStorage, date: number): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)
  const old = backupInfo.snapshots.length
  backupInfo.snapshots = backupInfo.snapshots.filter((it) => it.date < date)
  if (old !== backupInfo.snapshots.length) {
    console.log('removed snapshots: id:', old - backupInfo.snapshots.length)

    await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
  }
}

/**
 * @public
 */
export async function backupSize (storage: BackupStorage): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  let size = 0

  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)
  const addFileSize = async (file: string | undefined | null): Promise<void> => {
    if (file != null && (await storage.exists(file))) {
      try {
        const fileSize = await storage.stat(file)
        console.log(file, fileSize)
        size += fileSize
      } catch (err: any) {
        console.error('failed to calculate size', { file, err })
      }
    }
  }

  // Let's calculate data size for backup
  for (const sn of backupInfo.snapshots) {
    for (const [, d] of Object.entries(sn.domains)) {
      await addFileSize(d.snapshot)
      for (const snp of d.snapshots ?? []) {
        await addFileSize(snp)
      }
      for (const snp of d.storage ?? []) {
        await addFileSize(snp)
      }
    }
  }
  await addFileSize(infoFile)

  console.log('Backup size', size / (1024 * 1024), 'Mb')
}

/**
 * @public
 */
export async function backupDownload (storage: BackupStorage, storeIn: string, skipDomains: Set<string>): Promise<void> {
  const infoFile = 'backup.json.gz'
  const sizeFile = 'backup.size.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  let size = 0

  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)

  let sizeInfo: Record<string, number> = {}
  if (existsSync(join(storeIn, sizeFile))) {
    console.log('Parse size file')
    sizeInfo = JSON.parse(gunzipSync(new Uint8Array(readFileSync(join(storeIn, sizeFile)))).toString())
  }
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)

  const downloadFile = async (file: string | undefined | null, force: boolean = false): Promise<void> => {
    console.log('Checking file', file)
    if (file != null) {
      const target = join(storeIn, file)
      const dir = dirname(target)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const serverSize: number | undefined = sizeInfo[file] ?? (await storage.stat(file))
      if (serverSize !== sizeInfo[file]) {
        sizeInfo[file] = serverSize
        writeFileSync(
          join(storeIn, sizeFile),
          gzipSync(JSON.stringify(sizeInfo, undefined, 2), { level: defaultLevel })
        )
      }

      if (!existsSync(target) || force || (serverSize !== undefined && serverSize !== statSync(target).size)) {
        try {
          console.log('downloading', file, serverSize)
          const readStream = await storage.load(file)
          const outp = createWriteStream(target)

          readStream.pipe(outp)
          await new Promise<void>((resolve, reject) => {
            readStream.on('error', (err) => {
              console.error('failed to download file', { file, err })
              reject(err)
            })
            outp.on('error', (err) => {
              console.error('failed to write file', { file, err })
              reject(err)
            })
            outp.on('finish', () => {
              readStream.destroy()
              outp.close()
              resolve()
            })
            readStream.on('end', () => {
              outp.end()
            })
          })
          size += serverSize
        } catch (err: any) {
          console.error('failed to calculate size', { file, err })
        }
      }
    }
  }

  await downloadFile(infoFile, true)
  // Let's calculate data size for backup
  for (const sn of backupInfo.snapshots) {
    for (const [k, d] of Object.entries(sn.domains)) {
      console.log('processing', sn.date, k)
      if (skipDomains.has(k)) {
        continue
      }
      await downloadFile(d.snapshot)
      for (const snp of d.snapshots ?? []) {
        await downloadFile(snp)
      }
      for (const snp of d.storage ?? []) {
        await downloadFile(snp)
      }
    }
  }

  console.log('Backup size', size / (1024 * 1024), 'Mb')
}

/**
 * @public
 */
export async function backupFind (
  storage: BackupStorage,
  id: Ref<Doc>,
  showAll: boolean,
  domain?: string
): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)

  const toolCtx = new MeasureMetricsContext('', {})

  const snapshots = backupInfo.snapshots
  const rnapshots = Array.from(backupInfo.snapshots).reverse()

  // Collect all possible domains
  const domains = new Set<Domain>()
  for (const s of snapshots) {
    Object.keys(s.domains).forEach((it) => domains.add(it as Domain))
  }

  for (const dd of domains) {
    if (domain !== undefined && dd !== domain) {
      continue
    }
    console.log('checking:', dd)
    const sDigest = await loadDigest(toolCtx, storage, snapshots, dd)
    if (sDigest.has(id)) {
      console.log('we found file')
      let found = false
      for (const sn of rnapshots) {
        const ssDigest = await loadDigest(toolCtx, storage, [sn], dd)
        if (!ssDigest.has(id)) {
          continue
        }
        const d = sn.domains[dd]
        if (found && !showAll) {
          break
        }
        for (const sf of d?.storage ?? []) {
          if (found && !showAll) {
            break
          }
          console.log('processing', sf)
          const readStream = await storage.load(sf)
          const ex = extract()
          ex.on('entry', (headers, stream, next) => {
            if (headers.name === id + '.json') {
              console.log('file found in:', sf)

              const chunks: Buffer[] = []
              stream.on('data', (chunk) => {
                chunks.push(chunk)
              })
              stream.on('end', () => {
                const bf = Buffer.concat(chunks as any)
                console.log('>>>>>>>>>>>')
                console.log(JSON.stringify(JSON.parse(bf.toString()), undefined, 2))
                console.log('>>>>>>>>>>>')
                next()
              })

              found = true
            } else {
              stream.resume() // auto drain for non-matching entries
              next() // continue to the next entry
            }
          })

          const endPromise = new Promise((resolve) => {
            ex.on('finish', () => {
              resolve(null)
            })
          })
          const unzip = createGunzip({ level: defaultLevel })

          readStream.on('end', () => {
            readStream.destroy()
          })
          readStream.pipe(unzip)
          unzip.pipe(ex)

          await endPromise
        }
      }
    }
  }
}

/**
 * @public
 * Restore state of DB to specified point.
 *
 * Recheck mean we download and compare every document on our side and if found difference upload changed version to server.
 */
export async function restore (
  ctx: MeasureContext,
  transactorUrl: string,
  wsIds: WorkspaceIds,
  storage: BackupStorage,
  opt: {
    date: number
    merge?: boolean
    parallel?: number
    recheck?: boolean
    include?: Set<string>
    skip?: Set<string>
    getConnection?: () => Promise<CoreClient & BackupClient>
    storageAdapter?: StorageAdapter
    token?: string
    progress?: (progress: number) => Promise<void>
    cleanIndexState?: boolean
    historyFile?: string
  }
): Promise<boolean> {
  const infoFile = 'backup.json.gz'
  const workspaceId = wsIds.uuid
  if (!(await storage.exists(infoFile))) {
    ctx.error('file not pressent', { file: infoFile })
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
  let snapshots = backupInfo.snapshots
  if (opt.date !== -1) {
    const bk = backupInfo.snapshots.findIndex((it) => it.date === opt.date)
    if (bk === -1) {
      ctx.error('could not restore to', { date: opt.date, file: infoFile, workspaceId })
      throw new Error(`${infoFile} could not restore to ${opt.date}. Snapshot is missing.`)
    }
    snapshots = backupInfo.snapshots.slice(0, bk + 1)
  } else {
    opt.date = snapshots[snapshots.length - 1].date
  }

  if (backupInfo.domainHashes === undefined) {
    backupInfo.domainHashes = {}
  }
  ctx.info('restore to ', { id: opt.date, date: new Date(opt.date).toDateString() })
  const rsnapshots = Array.from(snapshots).reverse()

  // Collect all possible domains
  const domains = new Set<Domain>()
  for (const s of snapshots) {
    Object.keys(s.domains).forEach((it) => domains.add(it as Domain))
  }

  ctx.info('connecting:', { transactorUrl, workspace: workspaceId })

  const historyFile: Record<string, string> =
    opt.historyFile !== undefined && existsSync(opt.historyFile)
      ? JSON.parse(readFileSync(opt.historyFile).toString())
      : {}

  const token =
    opt.token ??
    generateToken(systemAccountUuid, workspaceId, {
      service: 'backup',
      mode: 'backup',
      model: 'upgrade'
    })

  const connection =
    opt.getConnection !== undefined
      ? await opt.getConnection()
      : ((await createClient(transactorUrl, token)) as CoreClient & BackupClient)

  if (opt.getConnection === undefined) {
    try {
      let serverEndpoint = await getTransactorEndpoint(token, 'external')
      serverEndpoint = serverEndpoint.replaceAll('wss://', 'https://').replace('ws://', 'http://')
      await fetch(serverEndpoint + `/api/v1/manage?token=${token}&operation=force-close`, {
        method: 'PUT'
      })
    } catch (err: any) {
      // Ignore
    }
  }

  const blobClient = new BlobClient(transactorUrl, token, wsIds, { storageAdapter: opt.storageAdapter })
  console.log('connected')

  // We need to find empty domains and clean them.
  const allDomains = connection.getHierarchy().domains()
  for (const d of allDomains) {
    domains.add(d)
  }

  // We do not backup elastic anymore
  domains.delete('fulltext-blob' as Domain)
  domains.delete('doc-index-state' as Domain)

  let uploadedMb = 0
  let uploaded = 0

  let domainProgress = 0

  const printUploaded = (msg: string, size: number): void => {
    if (size == null) {
      return
    }
    uploaded += size
    const newDownloadedMb = Math.round(uploaded / (1024 * 1024))
    const newId = Math.round(newDownloadedMb / 10)
    if (uploadedMb !== newId) {
      uploadedMb = newId
      ctx.info('Uploaded', {
        msg,
        written: newDownloadedMb,
        workspace: workspaceId
      })
    }
  }

  async function processDomain (c: Domain): Promise<void> {
    const dHash = await connection.getDomainHash(c)
    if (backupInfo.domainHashes[c] === dHash) {
      ctx.info('no changes in domain', { domain: c })
      return
    }
    const changeset = await loadDigest(ctx, storage, snapshots, c, opt.date)
    // We need to load full changeset from server
    const serverChangeset = new Map<Ref<Doc>, string>()

    const oldUsed = process.memoryUsage().heapUsed
    try {
      global.gc?.()
    } catch (err) {}
    const mm = { old: oldUsed / (1024 * 1024), current: process.memoryUsage().heapUsed / (1024 * 1024) }
    if (mm.old > mm.current + mm.current / 10) {
      ctx.info('memory-stats', mm)
    }

    let idx: number | undefined
    let loaded = 0
    let el = 0
    let chunks = 0
    let dataSize = 0
    try {
      while (true) {
        if (opt.progress !== undefined) {
          await opt.progress?.(domainProgress)
        }
        const st = Date.now()
        const it = await connection.loadChunk(c, idx)
        dataSize += it.size ?? 0
        chunks++

        idx = it.idx
        el += Date.now() - st

        for (const { id, hash } of it.docs) {
          serverChangeset.set(id as Ref<Doc>, hash)
          loaded++
        }

        if (el > 2500) {
          ctx.info('loaded from server', { domain: c, loaded, el, chunks, workspace: workspaceId })
          el = 0
          chunks = 0
        }
        if (it.finished) {
          break
        }
      }
    } finally {
      if (idx !== undefined) {
        await connection.closeChunk(idx)
      }
    }
    ctx.info('loaded', {
      domain: c,
      loaded,
      workspace: workspaceId,
      dataSize: Math.round((dataSize / (1024 * 1024)) * 100) / 100
    })
    ctx.info('\tcompare documents', {
      size: changeset.size,
      serverSize: serverChangeset.size,
      workspace: workspaceId
    })

    // Let's find difference
    const docsToAdd = new Map(
      opt.recheck === true // If recheck we check all documents.
        ? Array.from(changeset.entries())
        : Array.from(changeset.entries()).filter(
          ([it]) =>
            !serverChangeset.has(it) ||
              (serverChangeset.has(it) && doTrimHash(serverChangeset.get(it)) !== doTrimHash(changeset.get(it)))
        )
    )
    const docsToRemove = Array.from(serverChangeset.keys()).filter((it) => !changeset.has(it))

    const docs: Doc[] = []
    const blobs = new Map<string, { doc: Doc | undefined, buffer: Buffer | undefined }>()
    let sendSize = 0
    let totalSend = 0
    async function sendChunk (doc: Doc | undefined, len: number): Promise<void> {
      if (opt.progress !== undefined) {
        await opt.progress?.(domainProgress)
      }
      if (doc !== undefined) {
        docsToAdd.delete(doc._id)
        docs.push(doc)
      }
      sendSize = sendSize + len

      if (sendSize > dataUploadSize || (doc === undefined && docs.length > 0)) {
        let docsToSend = docs
        totalSend += docs.length
        ctx.info('upload-' + c, {
          docs: docs.length,
          totalSend,
          from: docsToAdd.size + totalSend,
          sendSize,
          workspace: workspaceId
        })
        // Correct docs without space
        for (const d of docs) {
          if (d.space == null) {
            d.space = core.space.Workspace
          }

          if (TxProcessor.isExtendsCUD(d._class)) {
            const tx = d as TxCUD<Doc>
            if (tx.objectSpace == null) {
              tx.objectSpace = core.space.Workspace
            }
          }
        }

        if (opt.recheck === true) {
          // We need to download all documents and compare them.
          const serverDocs = toIdMap(
            await connection.loadDocs(
              c,
              docs.map((it) => it._id)
            )
          )
          docsToSend = docs.filter((doc) => {
            const serverDoc = serverDocs.get(doc._id)
            if (serverDoc !== undefined) {
              const { '%hash%': _h1, ...dData } = doc as any
              const { '%hash%': _h2, ...sData } = serverDoc as any

              return !deepEqual(dData, sData)
            }
            return true
          })
        }
        try {
          await connection.upload(c, docsToSend)
        } catch (err: any) {
          ctx.error('error during upload', { err, docs: JSON.stringify(docs) })
        }

        docs.length = 0
        sendSize = 0
      }
      printUploaded('upload', len)
    }

    let processed = 0

    const blobUploader = new RateLimiter(10)

    for (const s of rsnapshots) {
      const d = s.domains[c]

      if (d !== undefined && docsToAdd.size > 0) {
        const sDigest = await loadDigest(ctx, storage, [s], c)
        const requiredDocs = new Map(Array.from(sDigest.entries()).filter(([it]) => docsToAdd.has(it)))

        let lastSendTime = Date.now()
        async function sendBlob (blob: Blob, data: Buffer, next: (err?: any) => void): Promise<void> {
          await blobUploader.add(async () => {
            next()
            let needSend = true
            if (opt.historyFile !== undefined) {
              if (historyFile[blob._id] === blob.etag) {
                needSend = false
              }
            }

            if (needSend) {
              try {
                await blobClient.upload(ctx, blob._id, blob.size, blob.contentType, data)
                if (opt.historyFile !== undefined) {
                  historyFile[blob._id] = blob.etag
                  if (totalSend % 1000 === 0) {
                    writeFileSync(opt.historyFile, JSON.stringify(historyFile, undefined, 2))
                  }
                }
              } catch (err: any) {
                ctx.warn('failed to upload blob', { _id: blob._id, err, workspace: wsIds.uuid })
                next(err)
              }
            }
            docsToAdd.delete(blob._id)
            requiredDocs.delete(blob._id)
            printUploaded('upload:' + blobUploader.processingQueue.size, data.length)
            totalSend++
            if (lastSendTime < Date.now()) {
              lastSendTime = Date.now() + 2500

              ctx.info('upload ' + c, {
                totalSend,
                from: docsToAdd.size + totalSend,
                sendSize,
                workspace: workspaceId
              })
            }
          })
        }

        if (requiredDocs.size > 0) {
          ctx.info('updating', { domain: c, requiredDocs: requiredDocs.size, workspace: workspaceId })
          // We have required documents here.
          for (const sf of d.storage ?? []) {
            if (docsToAdd.size === 0) {
              break
            }
            ctx.info('processing', { storageFile: sf, processed, workspace: wsIds.url })
            try {
              const readStream = await storage.load(sf)
              const ex = extract()

              ex.on('entry', (headers, stream, next) => {
                const name = headers.name ?? ''
                processed++
                // We found blob data
                if (requiredDocs.has(name as Ref<Doc>)) {
                  const chunks: Buffer[] = []
                  stream.on('data', (chunk) => {
                    chunks.push(chunk)
                  })
                  stream.on('end', () => {
                    const bf = Buffer.concat(chunks as any)
                    const d = blobs.get(name)
                    if (d === undefined) {
                      blobs.set(name, { doc: undefined, buffer: bf })
                      next()
                    } else {
                      blobs.delete(name)
                      const blob = d?.doc as Blob
                      ;(blob as any)['%hash%'] = changeset.get(blob._id)
                      let sz = blob.size
                      if (Number.isNaN(sz) || sz !== bf.length) {
                        sz = bf.length
                      }
                      void sendBlob(blob, bf, next).catch((err) => {
                        ctx.error('failed to send blob', { message: err.message })
                      })
                    }
                  })
                } else if (name.endsWith('.json') && requiredDocs.has(name.substring(0, name.length - 5) as Ref<Doc>)) {
                  const chunks: Buffer[] = []
                  const bname = name.substring(0, name.length - 5)
                  stream.on('data', (chunk) => {
                    chunks.push(chunk)
                  })
                  stream.on('end', () => {
                    const bf = Buffer.concat(chunks as any)
                    let doc: Doc
                    try {
                      doc = JSON.parse(bf.toString()) as Doc
                    } catch (err) {
                      ctx.warn('failed to parse blob metadata', { name, workspace: wsIds.url, err })
                      next()
                      return
                    }

                    if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
                      const data = migradeBlobData(doc as Blob, changeset.get(doc._id) as string)
                      const d = blobs.get(bname) ?? (data !== '' ? Buffer.from(data, 'base64') : undefined)
                      if (d === undefined) {
                        blobs.set(bname, { doc, buffer: undefined })
                        next()
                      } else {
                        blobs.delete(bname)
                        const blob = doc as Blob
                        const buff = d instanceof Buffer ? d : d.buffer
                        if (buff != null) {
                          void sendBlob(blob, d instanceof Buffer ? d : (d.buffer as Buffer), next).catch((err) => {
                            ctx.error('failed to send blob', { err })
                          })
                        } else {
                          next()
                        }
                      }
                    } else {
                      ;(doc as any)['%hash%'] = changeset.get(doc._id)
                      void sendChunk(doc, bf.length)
                        .finally(() => {
                          requiredDocs.delete(doc._id)
                          next()
                        })
                        .catch((err) => {
                          ctx.error('failed to sendChunk', { err })
                          next(err)
                        })
                    }
                  })
                } else {
                  next()
                }
                stream.resume() // just auto drain the stream
              })

              await blobUploader.waitProcessing()

              const unzip = createGunzip({ level: defaultLevel })

              const endPromise = new Promise((resolve, reject) => {
                ex.on('finish', () => {
                  resolve(null)
                })

                readStream.on('end', () => {
                  readStream.destroy()
                })
                readStream.pipe(unzip).on('error', (err) => {
                  readStream.destroy()
                  reject(err)
                })
                unzip.pipe(ex)
              })

              await endPromise
            } catch (err: any) {
              ctx.error('failed to processing', { storageFile: sf, processed, workspace: wsIds.url })
            }
          }
        }
      }
    }

    await sendChunk(undefined, 0)
    async function performCleanOfDomain (docsToRemove: Ref<Doc>[], c: Domain): Promise<void> {
      ctx.info('cleanup', { toRemove: docsToRemove.length, workspace: workspaceId, domain: c })
      while (docsToRemove.length > 0) {
        const part = docsToRemove.splice(0, 10000)
        try {
          await connection.clean(c, part)
        } catch (err: any) {
          ctx.error('failed to clean, will retry', { error: err, workspaceId })
          docsToRemove.push(...part)
        }
      }
    }
    if (c !== DOMAIN_BLOB) {
      // Clean domain documents if not blob
      if (docsToRemove.length > 0 && opt.merge !== true) {
        await performCleanOfDomain(docsToRemove, c)
      }
    }
  }

  const limiter = new RateLimiter(opt.parallel ?? 1)

  try {
    let i = 0
    for (const c of domains) {
      if (opt.progress !== undefined) {
        await opt.progress?.(domainProgress)
      }
      if (opt.include !== undefined && !opt.include.has(c)) {
        continue
      }
      if (opt.skip?.has(c) === true) {
        continue
      }
      await limiter.add(async () => {
        ctx.info('processing domain', { domain: c, workspaceId })
        let retry = 5
        let delay = 1
        while (retry > 0) {
          retry--
          try {
            await processDomain(c)
            if (delay > 1) {
              ctx.warn('retry-success', { retry, delay, workspaceId })
            }
            break
          } catch (err: any) {
            ctx.error('failed to process domain', { err, domain: c, workspaceId })
            if (retry !== 0) {
              ctx.warn('cool-down to retry', { delay, domain: c, workspaceId })
              await new Promise((resolve) => setTimeout(resolve, delay * 1000))
              delay++
            }
          }
        }
        domainProgress = Math.round(i / domains.size) * 100
        i++
      })
    }
    await limiter.waitProcessing()
  } catch (err: any) {
    Analytics.handleError(err)
    return false
  } finally {
    if (opt.getConnection === undefined && connection !== undefined) {
      await connection.sendForceClose()
      await connection.close()
    }
  }
  return true
}

async function verifyDocsFromSnapshot (
  ctx: MeasureContext,
  domain: Domain,
  d: DomainData,
  s: BackupSnapshot,
  storage: BackupStorage,
  digest: Map<Ref<Doc>, string>,
  verify: (docs: Doc[]) => Promise<void>,
  chunkSize: number
): Promise<{ modified: boolean, modifiedFiles: string[] }> {
  let result: Doc[] = []
  const storageToRemove = new Set<string>()
  const validDocs = new Set<Ref<Doc>>()
  const modifiedFiles: string[] = []
  if (digest.size > 0) {
    const sDigest = await loadDigest(ctx, storage, [s], domain)
    const requiredDocs = new Map(Array.from(sDigest.entries()).filter(([it]) => digest.has(it)))

    if (requiredDocs.size > 0) {
      ctx.info('updating', { domain, requiredDocs: requiredDocs.size })
      // We have required documents here.
      for (const sf of d.storage ?? []) {
        if (digest.size === 0) {
          break
        }
        try {
          const readStream = await storage.load(sf)
          const ex = extract()

          ex.on('entry', (headers, stream, next) => {
            const name = headers.name ?? ''
            // We found blob data
            const rdoc = name.substring(0, name.length - 5) as Ref<Doc>
            if (name.endsWith('.json') && requiredDocs.has(rdoc)) {
              const chunks: Buffer[] = []
              const bname = name.substring(0, name.length - 5)
              stream.on('data', (chunk) => {
                chunks.push(chunk)
              })
              stream.on('end', () => {
                const bf = Buffer.concat(chunks as any)
                let doc: Doc
                try {
                  doc = JSON.parse(bf.toString()) as Doc
                } catch (err) {
                  // Do not failure on this.
                  next()
                  return
                }

                if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
                  // Skip blob
                  validDocs.add(bname as Ref<Doc>)
                } else {
                  ;(doc as any)['%hash%'] = digest.get(rdoc)
                  digest.delete(rdoc)
                  result.push(doc)
                  validDocs.add(bname as Ref<Doc>)

                  if (result.length > chunkSize) {
                    void verify(result)
                      .then(() => {
                        result = []
                        next()
                      })
                      .catch((err) => {
                        ctx.error('failed to verify', { err })
                        next(err)
                      })
                  } else {
                    next()
                  }
                }
              })
            } else {
              next()
            }
            stream.resume() // just auto drain the stream
          })

          const unzip = createGunzip({ level: defaultLevel })

          const endPromise = new Promise((resolve, reject) => {
            ex.on('finish', () => {
              resolve(null)
            })

            readStream.on('end', () => {
              readStream.destroy()
            })
            readStream.pipe(unzip).on('error', (err) => {
              readStream.destroy()
              storageToRemove.add(sf)
              reject(err)
            })
            unzip.pipe(ex)
          })

          await endPromise
          if (result.length > 0) {
            await verify(result)
          }
        } catch (err: any) {
          storageToRemove.add(sf)
          ctx.error('failed to processing', { storageFile: sf })
        }
      }
    }
  }
  let modified = false
  if (storageToRemove.size > 0) {
    modifiedFiles.push(...Array.from(storageToRemove))
    d.storage = (d.storage ?? []).filter((it) => !storageToRemove.has(it))
    for (const sf of storageToRemove) {
      await storage.delete(sf)
    }
    modified = true
  }
  let smodifiedFiles: string[] = []
  ;({ modified, modifiedFiles: smodifiedFiles } = await updateDigest(d, ctx, storage, validDocs, modified, domain))
  modifiedFiles.push(...smodifiedFiles)
  return { modified, modifiedFiles }
}

function extendZero (value: number, count: number = 4): string {
  let idxName = `${value}`
  while (idxName.length < count) {
    idxName = '0' + idxName
  }
  return idxName
}

/**
 * Compacting backup into just one snapshot.
 * @public
 */
export async function compactBackup (
  ctx: MeasureContext,
  storage: BackupStorage,
  force: boolean = false,
  opt?: {
    blobLimit?: number
    skipContentTypes?: string[]
  }
): Promise<void> {
  console.log('starting backup compaction')

  const tmpRoot = mkdtempSync('huly')

  try {
    let backupInfo: BackupInfo

    // Version 0.6.2, format of digest file is changed to

    const infoFile = 'backup.json.gz'

    if (await storage.exists(infoFile)) {
      backupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
    } else {
      console.log('No backup found')
      return
    }
    if (backupInfo.version !== '0.6.2') {
      console.log('Invalid backup version')
      return
    }

    if (backupInfo.snapshots.length < 1 && !force) {
      console.log('No need to compact')
      return
    }

    // Find compacting backup or create new one
    const snapshot: BackupSnapshot = backupInfo.snapshots.find((it) => it.compacting === true) ?? {
      date: Date.now(),
      domains: {},
      compacting: true,
      stIndex: 0
    }

    let backupIndex = `${(backupInfo.snapshotsIndex ?? backupInfo.snapshots.length) + 1}`
    while (backupIndex.length < 6) {
      backupIndex = '0' + backupIndex
    }

    const domains: Domain[] = []
    for (const sn of backupInfo.snapshots) {
      for (const d of Object.keys(sn.domains)) {
        if (!domains.includes(d as Domain)) {
          domains.push(d as Domain)
        }
      }
    }
    const snapshotsToClean = backupInfo.snapshots.filter((it) => it.compacting !== true).reverse()
    backupInfo.snapshots.push(snapshot)

    const dirsToClean = new Set<string>()
    const filesToClean = new Set<string>()

    const cleanFiles = async (): Promise<void> => {
      if (filesToClean.size > 0) {
        for (const file of filesToClean) {
          try {
            await storage.delete(file)
          } catch (err: any) {
            // Ignore
          }
        }
        filesToClean.clear()
      }
    }

    for (const domain of domains) {
      console.log('compacting domain...', domain)

      const processedChanges: Snapshot = {
        added: new Map(),
        updated: new Map(),
        removed: []
      }

      let changed = 0
      let snapshotIndex = 0
      const domainInfo: DomainData = {
        snapshot: undefined,
        snapshots: [],
        storage: [],
        added: 0,
        updated: 0,
        removed: 0
      }

      // Cumulative digest
      // Documents modified in compacting snapshots in case of restart
      const untouchedDigest = await loadDigest(ctx, storage, [snapshot], domain)

      // We need to load snapshots from removed ones and
      const digest = await loadDigest(ctx, storage, snapshotsToClean, domain)

      // We remove all items we have in last part
      Array.from(untouchedDigest.keys()).forEach((it) => digest.delete(it))

      const digestAdded = new Map<Ref<Doc>, string>()

      let _pack: Pack | undefined
      let _packClose = async (): Promise<void> => {}
      let addedDocuments: () => number = () => 0

      let processed = 0

      let skipBlobs = 0
      let skipSize = 0

      let lastSkipPrint = 0

      const blobs = new Map<string, { doc: Doc | undefined, buffer: Buffer | undefined }>()

      async function pushDocs (doc: Doc | undefined, size: number, blobData: Record<Ref<Doc>, Buffer>): Promise<void> {
        if (doc == null) {
          return
        }
        changed += 1
        // Chunk data into small pieces
        // The size check 'addedDocuments() > dataBlobSize' is performed here, evaluating the archive's size
        // *before* the documents in the current 'docs' batch are added.
        // If the archive is, e.g., 49MB, this check passes. If the current 'docs' batch then adds 5MB,
        // the archive becomes 54MB. This oversized archive is closed only on the *next* call to pushDocs.
        const addedDocsValue = addedDocuments()
        if (addedDocsValue > dataBlobSize && _pack !== undefined) {
          await _packClose()

          if (changed > 0) {
            snapshot.domains[domain] = domainInfo
            domainInfo.added += processedChanges.added.size
            domainInfo.updated += processedChanges.updated.size
            domainInfo.removed += processedChanges.removed.length

            const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${extendZero(snapshotIndex)}.snp.gz`)
            snapshotIndex++
            domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
            await writeChanges(storage, snapshotFile, processedChanges)

            processedChanges.added.clear()
            processedChanges.removed = []
            processedChanges.updated.clear()
            await storage.writeFile(
              infoFile,
              gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel })
            )

            await cleanFiles()
          }
        }
        if (_pack === undefined) {
          _pack = pack()
          snapshot.stIndex++
          const storageFile = join(
            backupIndex,
            `${domain}-data-${snapshot.date}-${extendZero(snapshot.stIndex)}.tar.gz`
          )
          console.log('storing from domain', domain, storageFile)
          domainInfo.storage = [...(domainInfo.storage ?? []), storageFile]

          const tmpFile = join(tmpRoot, basename(storageFile) + '.tmp')
          const tempFile = createWriteStream(tmpFile)
          // const dataStream = await storage.write(storageFile)

          const sizePass = new PassThrough()
          let sz = 0
          sizePass._transform = (chunk, encoding, cb) => {
            // No transformation, just pass through data
            sz += chunk.length
            sizePass.push(chunk)
            cb()
          }

          sizePass.pipe(tempFile)

          const storageZip = createGzip({ level: defaultLevel, memLevel: 9 })
          addedDocuments = () => sz

          _pack.pipe(storageZip)
          storageZip.pipe(sizePass)

          _packClose = async () => {
            ctx.info('finalize pack', { storageFile, size: sz })
            await new Promise<void>((resolve) => {
              tempFile.on('close', () => {
                resolve()
              })
              _pack?.finalize()
            })
            // We need to upload file to storage
            ctx.info('>>>> upload pack', { storageFile, size: sz })
            await storage.writeFile(storageFile, createReadStream(tmpFile))
            await rm(tmpFile)

            _pack = undefined
          }
        }

        // Move processed document to processedChanges
        processedChanges.added.set(doc._id, digestAdded.get(doc._id) ?? '')

        if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
          const blob = doc as Blob | BlobData

          const data = blobData[blob._id]
          const descrJson = JSON.stringify(doc)
          await new Promise<void>((resolve, reject) => {
            _pack?.entry({ name: doc._id + '.json' }, descrJson, function (err) {
              if (err != null) reject(err)
              resolve()
            })
          })
          await new Promise<void>((resolve, reject) => {
            _pack?.entry({ name: doc._id }, data, function (err) {
              if (err != null) reject(err)
              resolve()
            })
          })
        } else {
          const data = JSON.stringify(doc)
          await new Promise<void>((resolve, reject) => {
            _pack?.entry({ name: doc._id + '.json' }, data, function (err) {
              if (err != null) reject(err)
              resolve()
            })
          })
        }
      }
      async function sendChunk (doc: Doc | undefined, len: number, blobData: Record<Ref<Doc>, Buffer>): Promise<void> {
        if (doc !== undefined) {
          if (domain === DOMAIN_BLOB) {
            if (opt?.skipContentTypes !== undefined || (opt?.blobLimit ?? 0) > 0) {
              // Check if we need to skip blob
              const blob = doc as Blob

              const newSkipPrint = Math.round(skipSize / (1024 * 1024 * 100))
              if (newSkipPrint !== lastSkipPrint) {
                lastSkipPrint = newSkipPrint
                console.log('skipping blobs', skipBlobs, Math.round(skipSize / (1024 * 1024)))
              }
              const bsize = blob.size == null || Number.isNaN(blob.size) || !Number.isInteger(blob.size) ? 0 : blob.size

              if (
                opt?.skipContentTypes !== undefined &&
                opt?.skipContentTypes.some((it) => (blob.contentType ?? '').includes(it))
              ) {
                skipBlobs++
                skipSize += bsize
                digest.delete(doc._id)
                return
              }
              if (opt?.blobLimit !== undefined && opt?.blobLimit > 0 && bsize > opt.blobLimit) {
                skipBlobs++
                skipSize += bsize
                digest.delete(doc._id)
                return
              }
            }
          }
          const hash = digest.get(doc._id)
          digest.delete(doc._id)
          digestAdded.set(doc._id, hash ?? '')
          await pushDocs(doc, len, blobData)
        }
      }

      for (const s of snapshotsToClean) {
        const d = s.domains[domain]

        if (d !== undefined && digest.size > 0) {
          ctx.info('checking-domain', { domain, name: s.date })
          const sDigest = await loadDigest(ctx, storage, [s], domain)
          const requiredDocs = new Map(Array.from(sDigest.entries()).filter(([it]) => digest.has(it)))
          if (requiredDocs.size > 0) {
            console.log('updating', domain, requiredDocs.size)
            // We have required documents here.
            for (const sf of d.storage ?? []) {
              if (digest.size === 0) {
                break
              }
              try {
                console.log('processing', sf, processed)

                const readStream = await storage.load(sf)
                const ex = extract()

                ex.on('entry', (headers, stream, next) => {
                  const name = headers.name ?? ''
                  processed++
                  // We found blob data
                  if (requiredDocs.has(name as Ref<Doc>)) {
                    const chunks: Buffer[] = []
                    stream.on('data', (chunk) => {
                      chunks.push(chunk)
                    })
                    stream.on('end', () => {
                      const bf = Buffer.concat(chunks as any)
                      const d = blobs.get(name)
                      if (d === undefined) {
                        blobs.set(name, { doc: undefined, buffer: bf })
                        next()
                      } else {
                        blobs.delete(name)
                        const doc = d.doc as Blob | undefined // d here is from the outer scope, known not to be undefined.
                        if (doc == null) {
                          const errorMsg = `CompactBackup: Metadata (doc) missing in blobs entry for data file ${name}`
                          ctx.error(errorMsg, { name })
                          next() // Just skip
                          return
                        }
                        void sendChunk(doc, bf.length, { [doc._id]: bf })
                          .finally(() => {
                            requiredDocs.delete(doc._id)
                            next()
                          })
                          .catch((err) => {
                            next(err)
                          })
                      }
                    })
                  } else if (
                    name.endsWith('.json') &&
                    requiredDocs.has(name.substring(0, name.length - 5) as Ref<Doc>)
                  ) {
                    const chunks: Buffer[] = []
                    const bname = name.substring(0, name.length - 5)
                    stream.on('data', (chunk) => {
                      chunks.push(chunk)
                    })
                    stream.on('end', () => {
                      const bf = Buffer.concat(chunks as any)
                      let doc: Doc
                      try {
                        doc = JSON.parse(bf.toString()) as Doc
                      } catch (err: any) {
                        console.error(err)
                        next()
                        return
                      }
                      if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
                        const d = blobs.get(bname)
                        if (d === undefined) {
                          blobs.set(bname, { doc, buffer: undefined })
                          next()
                        } else {
                          blobs.delete(bname)
                          ;(doc as any)['%hash%'] = digest.get(doc._id)
                          void sendChunk(doc, bf.length, { [doc._id]: d?.buffer as Buffer })
                            .finally(() => {
                              requiredDocs.delete(doc._id)
                              next()
                            })
                            .catch((err) => {
                              ctx.error('failed to sendChunk', { err })
                              next(err)
                            })
                        }
                      } else {
                        ;(doc as any)['%hash%'] = digest.get(doc._id)
                        void sendChunk(doc, bf.length, {})
                          .finally(() => {
                            requiredDocs.delete(doc._id)
                            next()
                          })
                          .catch((err) => {
                            ctx.error('failed to sendChunk', { err })
                            next(err)
                          })
                      }
                    })
                  } else {
                    next()
                  }
                  stream.resume() // just auto drain the stream
                })

                const unzip = createGunzip({ level: defaultLevel })
                const endPromise = new Promise((resolve, reject) => {
                  ex.on('finish', () => {
                    resolve(null)
                  })
                  readStream.on('error', (err) => {
                    ctx.error('error during processing', { snapshot, err })
                    reject(err)
                  })
                  unzip.on('error', (err) => {
                    ctx.error('error during processing', { snapshot, err })
                    reject(err)
                  })
                })

                readStream.on('end', () => {
                  readStream.destroy()
                })
                readStream.pipe(unzip)
                unzip.pipe(ex)

                await endPromise
              } catch (err: any) {
                ctx.error('error processing', err)
              }
            }
          } else {
            console.log('domain had no changes', domain)
          }
        }
        if (d !== undefined) {
          for (const sf of d.storage ?? []) {
            console.log('removing', sf)
            dirsToClean.add(dirname(sf))
            filesToClean.add(sf)
          }
          for (const sf of d.snapshots ?? []) {
            console.log('removing', sf)
            dirsToClean.add(dirname(sf))
            filesToClean.add(sf)
          }
          if (d.snapshot !== undefined) {
            dirsToClean.add(dirname(d.snapshot))
            filesToClean.add(d.snapshot)
          }
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete s.domains[domain]
        }
      }

      if (changed > 0) {
        domainInfo.added += processedChanges.added.size
        domainInfo.updated += processedChanges.updated.size
        domainInfo.removed += processedChanges.removed.length

        if (domainInfo.added + domainInfo.updated + domainInfo.removed > 0) {
          snapshot.domains[domain] = domainInfo

          const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${extendZero(snapshotIndex)}.snp.gz`)
          snapshotIndex++
          domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
          await writeChanges(storage, snapshotFile, processedChanges)
        }

        processedChanges.added.clear()
        processedChanges.removed = []
        processedChanges.updated.clear()
        await _packClose()
      }
      // This will allow to retry in case of critical error.
      await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
    }
    snapshot.compacting = false
    backupInfo.snapshots = [snapshot]
    backupInfo.snapshotsIndex = (backupInfo.snapshotsIndex ?? backupInfo.snapshots.length) + 1
    await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))

    await cleanFiles()
    for (const dir of dirsToClean) {
      try {
        await storage.deleteRecursive(dir)
      } catch (err: any) {
        // Ignore
      }
    }
  } catch (err: any) {
    console.error(err)
  } finally {
    await rm(tmpRoot, { recursive: true })
    console.log('end compacting')
  }
}

export * from './service'
function migradeBlobData (blob: Blob, etag: string): string {
  if (blob._class === 'core:class:BlobData') {
    const bd = blob as unknown as BlobData
    blob.contentType = blob.contentType ?? bd.type
    blob.etag = etag
    blob._class = core.class.Blob
    delete (blob as any).type
    const result = (blob as any).base64Data
    delete (blob as any).base64Data
    return result
  }
  return ''
}

/**
 * Will check backup integrity, and in case of some missing resources, will update digest files, so next backup will backup all missing parts.
 * @public
 */
export async function checkBackupIntegrity (ctx: MeasureContext, storage: BackupStorage): Promise<void> {
  console.log('check backup integrity')
  try {
    let backupInfo: BackupInfo

    // Version 0.6.2, format of digest file is changed to

    const infoFile = 'backup.json.gz'

    if (await storage.exists(infoFile)) {
      backupInfo = JSON.parse(gunzipSync(new Uint8Array(await storage.loadFile(infoFile))).toString())
    } else {
      console.log('No backup found')
      return
    }
    if (backupInfo.version !== '0.6.2') {
      console.log('Invalid backup version')
      return
    }

    const recheckSizes: string[] = []

    const domains: Domain[] = []
    for (const sn of backupInfo.snapshots) {
      for (const d of Object.keys(sn.domains)) {
        if (!domains.includes(d as Domain)) {
          domains.push(d as Domain)
        }
      }
    }
    let modified = false

    for (const domain of domains) {
      console.log('checking domain...', domain)
      const { modified: mm, modifiedFiles } = await verifyDigest(ctx, storage, backupInfo.snapshots, domain)
      if (mm) {
        recheckSizes.push(...modifiedFiles)
        modified = true
      }
    }
    if (backupInfo.migrations == null) {
      backupInfo.migrations = {}
    }
    if (backupInfo.migrations.zeroCheckSize !== true) {
      backupInfo.migrations.zeroCheckSize = true
      modified = true
    }
    if (modified) {
      await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
    }

    const bresult: BackupResult = {
      backupSize: 0,
      blobsSize: 0,
      dataSize: 0,
      result: true
    }
    await rebuildSizeInfo(storage, recheckSizes, ctx, bresult, backupInfo, infoFile)
  } catch (err: any) {
    console.error(err)
  } finally {
    console.log('end compacting')
  }
}
