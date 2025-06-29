//
// Copyright © 2025 Hardcore Engineering Inc.
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
import { randomUUID } from 'crypto'
import { readEml, ReadedEmlJson } from 'eml-parse-js'
import TurndownService from 'turndown'
import sanitizeHtml from 'sanitize-html'
import { MeasureContext } from '@hcengineering/core'
import { type Attachment } from '@hcengineering/mail-common'

import { MtaMessage } from './types'
import { getDecodedContent } from './decode'

export async function parseContent (
  ctx: MeasureContext,
  mta: MtaMessage
): Promise<{ content: string, attachments: Attachment[] }> {
  // TODO: UBERF-11029 - remove this logging after testing
  ctx.info('Parsing email content', { mta })
  const contentType = getHeader(mta, 'Content-Type')
  if (contentType === undefined) {
    throw new Error('Content-Type header not found')
  }

  if (contentType.toLowerCase().startsWith('text/plain')) {
    return { content: getDecodedContent(ctx, mta), attachments: [] }
  }

  const email = await getEmailContent(ctx, mta)

  let content = email.text ?? ''
  let isMarkdown = false
  if (email.html !== undefined) {
    try {
      const html = sanitizeHtml(email.html)
      const tds = new TurndownService()
      content = tds.turndown(html)

      isMarkdown = true
    } catch (error) {
      ctx.warn('Failed to parse html content', { error })
    }
  }

  const attachments: Attachment[] = []
  for (const a of email.attachments ?? []) {
    if (a.name === undefined || a.name.length === 0) {
      // EML parser returns attachments with empty name for parts of content
      // that do not have "Content-Disposition: attachment" e.g. for part
      // Content-Type: text/calendar; charset="UTF-8"; method=REQUEST
      continue
    }
    const attachment: Attachment = {
      id: randomUUID(),
      name: a.name,
      data: Buffer.from(a.data64, 'base64'),
      contentType: a.contentType.split(';')[0].trim()
    }
    attachments.push(attachment)

    // For inline images, replace the CID references with the blob id
    if (isMarkdown && a.inline && a.id !== undefined) {
      const cid = a.id.replace(/[<>]/g, '')
      content = content.replaceAll(new RegExp(`!\\[.*?\\]\\(cid:${cid}\\)`, 'g'), `![${a.name}](cid:${attachment.id})`)
    }
  }
  return { content, attachments }
}

export function convertMtaToEml (ctx: MeasureContext, mta: MtaMessage): string {
  return `MIME-Version: 1.0
Date: ${new Date().toUTCString()}
From: ${mta.envelope.from.address}
To: ${mta.envelope.to.map((to) => to.address).join(', ')}
Content-Type: ${getHeader(mta, 'Content-Type') ?? 'text/plain; charset=utf-8'}

${unescapeString(getDecodedContent(ctx, mta))}`
}

function unescapeString (str: string): string {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

export function getHeader (mta: MtaMessage, header: string): string | undefined {
  const h = header.toLowerCase()
  return mta.message.headers.find((header) => header[0].toLowerCase() === h)?.[1]?.trim()
}

async function getEmailContent (ctx: MeasureContext, mta: MtaMessage): Promise<ReadedEmlJson> {
  const eml = convertMtaToEml(ctx, mta)
  const email = await new Promise<ReadedEmlJson>((resolve, reject) => {
    readEml(eml, (err, json) => {
      if (err !== undefined && err !== null) {
        reject(new Error(`Email parsing error: ${err.message}`))
      } else if (json === undefined) {
        reject(new Error('Email parser returned undefined result'))
      } else {
        resolve(json)
      }
    })
  })
  if (isEmptyString(email.text) && isEmptyString(email.html)) {
    return {
      ...email,
      text: removeContentTypeHeader(getDecodedContent(ctx, mta))
    }
  }
  return email
}

export function removeContentTypeHeader (content: string): string {
  if (content == null) {
    return content
  }

  const contentTypeRegex = /^Content-Type:.*?(?:\r\n|\n|\r)/im
  return content.replace(contentTypeRegex, '')
}

function isEmptyString (str: string | undefined): boolean {
  return str == null || str.trim() === ''
}
