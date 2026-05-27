#!/usr/bin/env node
/**
 * Microsoft Graph sendMail showcase.
 *
 * This script is intentionally kept outside the package surface.
 * It demonstrates a Graph-based send path for environments or accounts
 * where SMTP AUTH is unavailable or not the right fit yet.
 *
 * Inputs come from shell env, matching the rest of the repo's smoke style:
 *
 *   GRAPH_CLIENT_ID        Microsoft app client id.
 *   GRAPH_TENANT           OAuth tenant segment, default: consumers.
 *   GRAPH_USER_EMAIL       Mailbox address used as the Graph /me identity.
 *   GRAPH_REFRESH_TOKEN    Current refresh token for that mailbox.
 *   GRAPH_TO_EMAIL         Recipient address.
 *   GRAPH_SUBJECT          Optional subject override.
 *   GRAPH_BODY             Optional plain-text body override.
 *   GRAPH_SCOPE            Optional refresh scope.
 *                           Default: https://graph.microsoft.com/mail.send offline_access
 *   GRAPH_RESULT_PATH      Optional JSON output path for run metadata.
 *
 * The script captures request IDs and client-request-ids so Graph calls can be
 * correlated with provider logs. It does not store token values in the result.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const clientId = process.env.GRAPH_CLIENT_ID || "";
const tenant = process.env.GRAPH_TENANT || "consumers";
const userEmail = process.env.GRAPH_USER_EMAIL || "";
const refreshToken = process.env.GRAPH_REFRESH_TOKEN || "";
const toEmail = process.env.GRAPH_TO_EMAIL || "";
const subject = process.env.GRAPH_SUBJECT || `Edge Mailer Graph showcase — ${userEmail || "unknown sender"}`;
const bodyText =
  process.env.GRAPH_BODY ||
  `Graph showcase send from ${userEmail}.\n\n` +
    `This is a repository showcase script, not a supported package provider yet.\n` +
    `Run id: ${new Date().toISOString()}`;
const scope = process.env.GRAPH_SCOPE || "https://graph.microsoft.com/mail.send offline_access";
const resultPath =
  process.env.GRAPH_RESULT_PATH ||
  path.resolve(process.cwd(), `graph_send_result-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

if (!clientId || !userEmail || !refreshToken || !toEmail) {
  console.error(
    [
      "Missing required env.",
      "Need: GRAPH_CLIENT_ID, GRAPH_USER_EMAIL, GRAPH_REFRESH_TOKEN, GRAPH_TO_EMAIL",
      "Optional: GRAPH_TENANT, GRAPH_SCOPE, GRAPH_SUBJECT, GRAPH_BODY, GRAPH_RESULT_PATH",
    ].join("\n"),
  );
  process.exit(1);
}

const tokenEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const graphSendEndpoint = "https://graph.microsoft.com/v1.0/me/sendMail";
const runId = crypto.randomUUID();

function headerValue(headers, ...names) {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return "";
}

async function parseJson(resp) {
  const text = await resp.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function main() {
  console.log(`Graph showcase run ${runId}`);
  console.log(`Sender: ${userEmail}`);
  console.log(`Recipient: ${toEmail}`);
  console.log(`Tenant: ${tenant}`);
  console.log(`Scope: ${scope}`);

  // Step 1: exchange the refresh token for a short-lived Graph access token.
  // The token response carries the useful evidence here: status + correlation ids.
  const tokenClientRequestId = crypto.randomUUID();
  const tokenBody = new URLSearchParams({
    client_id: clientId,
    scope,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const tokenResp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "client-request-id": tokenClientRequestId,
      "return-client-request-id": "true",
    },
    body: tokenBody.toString(),
  });

  const tokenData = await parseJson(tokenResp);
  const tokenMeta = {
    httpStatus: tokenResp.status,
    requestId: headerValue(tokenResp.headers, "request-id", "x-ms-request-id"),
    clientRequestId: headerValue(tokenResp.headers, "client-request-id", "x-ms-client-request-id") || tokenClientRequestId,
    xMsEstsServer: headerValue(tokenResp.headers, "x-ms-ests-server"),
    date: headerValue(tokenResp.headers, "date"),
    scope: tokenData.scope || "",
    expiresIn: tokenData.expires_in ?? null,
    tokenType: tokenData.token_type || "",
  };

  if (tokenData.error) {
    const result = {
      runId,
      sender: userEmail,
      recipient: toEmail,
      stage: "token",
      ok: false,
      error: tokenData.error,
      errorDescription: tokenData.error_description || "",
      token: tokenMeta,
    };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    console.error(`Token refresh failed: ${tokenData.error}`);
    console.error(`Saved result: ${resultPath}`);
    process.exit(1);
  }

  // Step 2: send a simple plain-text message.
  // The body intentionally stays small and ordinary because this is a transport
  // showcase, not an inbox-placement experiment.
  const sendClientRequestId = crypto.randomUUID();
  const sendPayload = {
    message: {
      subject,
      body: {
        contentType: "Text",
        content: bodyText,
      },
      toRecipients: [{ emailAddress: { address: toEmail } }],
    },
    saveToSentItems: true,
  };

  const sendResp = await fetch(graphSendEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json",
      "client-request-id": sendClientRequestId,
      "return-client-request-id": "true",
    },
    body: JSON.stringify(sendPayload),
  });

  const sendMeta = {
    httpStatus: sendResp.status,
    requestId: headerValue(sendResp.headers, "request-id", "x-ms-request-id"),
    clientRequestId: headerValue(sendResp.headers, "client-request-id", "x-ms-client-request-id") || sendClientRequestId,
    date: headerValue(sendResp.headers, "date"),
  };

  const result = {
    runId,
    sender: userEmail,
    recipient: toEmail,
    stage: "send",
    ok: sendResp.status === 202,
    token: tokenMeta,
    send: sendMeta,
  };

  if (sendResp.status !== 202) {
    const err = await parseJson(sendResp);
    result.error = err.error?.message || err.raw || `HTTP ${sendResp.status}`;
    result.errorCode = err.error?.code || "";
    result.errorBody = err;
  }

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

  if (sendResp.status === 202) {
    console.log("Graph send accepted (HTTP 202).");
    console.log(`Request ID: ${sendMeta.requestId || "<none>"}`);
    console.log(`Client Request ID: ${sendMeta.clientRequestId}`);
    console.log(`Saved result: ${resultPath}`);
    return;
  }

  console.error(`Graph send failed: HTTP ${sendResp.status}`);
  console.error(`Request ID: ${sendMeta.requestId || "<none>"}`);
  console.error(`Client Request ID: ${sendMeta.clientRequestId}`);
  console.error(`Saved result: ${resultPath}`);
  process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
