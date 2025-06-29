import { MeasureContext, type WorkspaceIds } from '@hcengineering/core'
import { StorageAdapter } from '@hcengineering/server-core'
import { createReadStream, createWriteStream, existsSync, statSync } from 'fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { PassThrough, Readable, Writable } from 'stream'

export interface FileInfo {
  size: number
  etag: string
  contentType?: string
  lastModified: number
}

/**
 * @public
 */
export interface BackupStorage {
  loadFile: (name: string) => Promise<Buffer>
  load: (name: string) => Promise<Readable>
  write: (name: string) => Promise<Writable>

  writeFile: (name: string, data: string | Buffer | Readable) => Promise<void>
  exists: (name: string) => Promise<boolean>

  stat: (name: string) => Promise<number>

  statInfo: (name: string) => Promise<FileInfo>
  delete: (name: string) => Promise<void>

  deleteRecursive: (name: string) => Promise<void>
}

class FileStorage implements BackupStorage {
  constructor (readonly root: string) {}
  async loadFile (name: string): Promise<Buffer> {
    return await readFile(join(this.root, name))
  }

  async write (name: string): Promise<Writable> {
    const fileName = join(this.root, name)
    const dir = dirname(fileName)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    return createWriteStream(join(this.root, name))
  }

  async load (name: string): Promise<Readable> {
    return createReadStream(join(this.root, name))
  }

  async exists (name: string): Promise<boolean> {
    return existsSync(join(this.root, name))
  }

  async stat (name: string): Promise<number> {
    return statSync(join(this.root, name)).size
  }

  async statInfo (name: string): Promise<FileInfo> {
    const stat = statSync(join(this.root, name))
    return { size: stat.size, etag: stat.mtime.toUTCString(), lastModified: stat.mtime.getTime() }
  }

  async delete (name: string): Promise<void> {
    await rm(join(this.root, name))
  }

  async deleteRecursive (name: string): Promise<void> {
    // Check if folder has no files
    const files = await readdir(join(this.root, name))
    if (files.length === 0) {
      await rm(join(this.root, name), {
        recursive: true
      })
    }
  }

  async writeFile (name: string, data: string | Buffer | Readable): Promise<void> {
    const fileName = join(this.root, name)
    const dir = dirname(fileName)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    await writeFile(fileName, data as any)
  }
}

class AdapterStorage implements BackupStorage {
  constructor (
    readonly client: StorageAdapter,
    readonly wsIds: WorkspaceIds,
    readonly root: string,
    readonly ctx: MeasureContext
  ) {}

  async loadFile (name: string): Promise<Buffer> {
    const data = await this.client.read(this.ctx, this.wsIds, join(this.root, name))
    return Buffer.concat(data as any)
  }

  async write (name: string): Promise<Writable> {
    const wr = new PassThrough()
    void this.client.put(this.ctx, this.wsIds, join(this.root, name), wr, 'application/octet-stream')
    return wr
  }

  async load (name: string): Promise<Readable> {
    return await this.client.get(this.ctx, this.wsIds, join(this.root, name))
  }

  async exists (name: string): Promise<boolean> {
    try {
      return (await this.client.stat(this.ctx, this.wsIds, join(this.root, name))) !== undefined
    } catch (err: any) {
      return false
    }
  }

  async stat (name: string): Promise<number> {
    try {
      const st = await this.client.stat(this.ctx, this.wsIds, join(this.root, name))
      return st?.size ?? 0
    } catch (err: any) {
      return 0
    }
  }

  async statInfo (name: string): Promise<FileInfo> {
    try {
      const st = await this.client.stat(this.ctx, this.wsIds, join(this.root, name))
      return {
        size: st?.size ?? 0,
        etag: st?.etag ?? '',
        contentType: st?.contentType,
        lastModified: st?.modifiedOn ?? 0
      }
    } catch (err: any) {
      return { size: 0, etag: '', lastModified: 0 }
    }
  }

  async delete (name: string): Promise<void> {
    await this.client.remove(this.ctx, this.wsIds, [join(this.root, name)])
  }

  async deleteRecursive (name: string): Promise<void> {
    // Do not need to do anything
  }

  async writeFile (name: string, data: string | Buffer | Readable): Promise<void> {
    // TODO: add mime type detection here.
    await this.client.put(this.ctx, this.wsIds, join(this.root, name), data, 'application/octet-stream')
  }
}

/**
 * @public
 */
export async function createFileBackupStorage (fileName: string): Promise<BackupStorage> {
  if (!existsSync(fileName)) {
    console.log(__dirname)
    await mkdir(fileName, { recursive: true })
  }
  return new FileStorage(fileName)
}

/**
 * @public
 */
export async function createStorageBackupStorage (
  ctx: MeasureContext,
  client: StorageAdapter,
  wsIds: WorkspaceIds,
  root: string,
  check: boolean = true
): Promise<BackupStorage> {
  if (check && !(await client.exists(ctx, wsIds))) {
    await client.make(ctx, wsIds)
  }
  return new AdapterStorage(client, wsIds, root, ctx)
}
