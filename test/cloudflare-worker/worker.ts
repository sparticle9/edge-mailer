import { EmailOptions } from '../../src/email'
import { LogLevel } from '../../src/logger'
import {
  EdgeMailer,
  type EdgeMailerOptions,
  type SmtpSendReceipt,
} from '../../src/mailer'

type SmokeRequest =
  | {
      mode?: 'send'
      config: EdgeMailerOptions
      email: EmailOptions
    }
  | {
      mode: 'batch' | 'sendMany'
      config: EdgeMailerOptions
      emails: EmailOptions[]
      continueOnError?: boolean
    }

function receiptToJson(receipt: SmtpSendReceipt) {
  return {
    messageId: receipt.messageId,
    accepted: receipt.accepted,
    rejected: receipt.rejected,
    responseCode: receipt.responseCode,
  }
}

function resultToJson(result: PromiseSettledResult<SmtpSendReceipt>) {
  if (result.status === 'fulfilled') {
    return { status: 'fulfilled', receipt: receiptToJson(result.value) }
  }
  const reason = result.reason
  if (reason instanceof Error) {
    return {
      status: 'rejected',
      reason: {
        name: reason.name,
        message: reason.message,
        ...(reason as any),
      },
    }
  }
  return { status: 'rejected', reason: String(reason) }
}

export default {
  async fetch(request: Request, env, ctx): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Bad request' }, { status: 405 })
    }

    try {
      const body = (await request.json()) as SmokeRequest
      const logLevel =
        body.config.logLevel === undefined
          ? LogLevel.NONE
          : body.config.logLevel

      if (body.mode === 'batch') {
        const results = await EdgeMailer.sendBatch(
          { ...body.config, logLevel },
          body.emails,
          { continueOnError: body.continueOnError },
        )
        return Response.json({ ok: true, results: results.map(resultToJson) })
      }

      if (body.mode === 'sendMany') {
        const mailer = await EdgeMailer.connect({
          ...body.config,
          logLevel,
        })
        try {
          const results = await mailer.sendMany(body.emails, {
            continueOnError: body.continueOnError,
          })
          return Response.json({ ok: true, results: results.map(resultToJson) })
        } finally {
          await mailer.close()
        }
      }

      const receipt = await EdgeMailer.send(
        {
          ...body.config,
          logLevel,
        },
        body.email,
      )

      return Response.json({ ok: true, receipt: receiptToJson(receipt) })
    } catch (error) {
      if (error instanceof Error) {
        return Response.json(
          {
            error: {
              name: error.name,
              message: error.message,
              ...(error as any),
            },
          },
          { status: 400 },
        )
      }
      return Response.json(
        { error: { name: 'UnknownError', message: 'Internal server error' } },
        { status: 500 },
      )
    }
  },
} satisfies ExportedHandler
