/**
 * Jupiter Ultra Swap Integration
 * Uses Jupiter Ultra API (https://api.jup.ag/ultra/v1) for best-in-class routing,
 * MEV protection, and automatic fee collection.
 */

import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import dotenv from "dotenv";
dotenv.config();

const JUPITER_ULTRA_API = "https://api.jup.ag/ultra/v1";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const REFERRAL_ACCOUNT =
  process.env.JUPITER_REFERRAL_ACCOUNT ||
  "GNH7RSuVoZcWJigTg3adubrPFp4j32U8UaGkKDnvRS9Q";
const REFERRAL_FEE_BPS = parseInt(
  process.env.JUPITER_REFERRAL_FEE_BPS || "255",
  10,
);

/**
 * Poll until the transaction is observed on-chain.
 */
async function confirmSignature(connection, signature, timeoutMs = 30000) {
  const start = Date.now();
  let delay = 500;

  while (Date.now() - start < timeoutMs) {
    try {
      const { value } = await connection.getSignatureStatuses([signature]);
      const status = value?.[0];

      if (status) {
        if (status.err) {
          return {
            status: "failed",
            error:
              typeof status.err === "string"
                ? status.err
                : JSON.stringify(status.err),
          };
        }
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          return { status: "confirmed" };
        }
      }
    } catch (e) {
      // Transient RPC failure
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 2000);
  }

  return { status: "unconfirmed" };
}

function ultraHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (JUPITER_API_KEY) headers["x-api-key"] = JUPITER_API_KEY;
  return headers;
}

let jupiterTokenListPromise = null;

function getJupiterTokenList() {
  if (!jupiterTokenListPromise) {
    jupiterTokenListPromise = (async () => {
      try {
        const response = await fetch("https://token.jup.ag/all", {
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return null;
        return await response.json();
      } catch (e) {
        jupiterTokenListPromise = null;
        return null;
      }
    })();
  }
  return jupiterTokenListPromise;
}

export async function getTokenDecimals(connection, mintAddress) {
  if (mintAddress === "So11111111111111111111111111111111111111112") return 9;

  try {
    const mintPublicKey = new PublicKey(mintAddress);
    const mintInfo = await connection.getParsedAccountInfo(mintPublicKey);
    if (mintInfo.value) {
      const parsed = mintInfo.value.data;
      if (parsed.parsed && parsed.parsed.info) {
        const decimals = parsed.parsed.info.decimals;
        if (decimals !== undefined && decimals !== null) return decimals;
      }
    }
  } catch (e) {}

  try {
    const tokenList = await getJupiterTokenList();
    const token = tokenList?.find((t) => t.address === mintAddress);
    if (token?.decimals !== undefined) return token.decimals;
  } catch (e) {}

  console.warn(
    `⚠️ Could not determine decimals for ${mintAddress}, defaulting to 6`,
  );
  return 6;
}

async function getUltraOrder({
  inputMint,
  outputMint,
  amountRaw,
  taker,
  slippageBps,
}) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountRaw,
    taker,
  });

  if (slippageBps !== undefined) {
    params.set("slippageBps", slippageBps.toString());
  }

  if (REFERRAL_ACCOUNT) {
    params.set("referralAccount", REFERRAL_ACCOUNT);
    params.set("referralFee", REFERRAL_FEE_BPS.toString());
  }

  const url = `${JUPITER_ULTRA_API}/order?${params.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers: ultraHeaders(),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(`Ultra order failed: ${data.error ?? response.statusText}`);
  }

  return data;
}

async function executeUltraOrder({ signedTransaction, requestId }) {
  const response = await fetch(`${JUPITER_ULTRA_API}/execute`, {
    method: "POST",
    headers: ultraHeaders(),
    body: JSON.stringify({ signedTransaction, requestId }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Ultra execute failed: ${data.error ?? response.statusText}`,
    );
  }

  return data;
}

export async function executeJupiterSwap({
  inputMint,
  outputMint,
  amount,
  inputDecimals,
  outputDecimals,
  userPublicKey,
  slippageBps,
  connection,
  signTransaction,
  dryRun = false,
}) {
  try {
    if (!inputMint || !outputMint || !amount || amount <= 0) {
      throw new Error("Invalid input parameters");
    }

    const [inputTokenDecimals, outputTokenDecimals] = await Promise.all([
      inputDecimals !== undefined
        ? Promise.resolve(inputDecimals)
        : getTokenDecimals(connection, inputMint),
      outputDecimals !== undefined
        ? Promise.resolve(outputDecimals)
        : getTokenDecimals(connection, outputMint),
    ]);

    const amountRaw = Math.floor(
      amount * Math.pow(10, inputTokenDecimals),
    ).toString();

    const order = await getUltraOrder({
      inputMint,
      outputMint,
      amountRaw,
      taker: userPublicKey,
      slippageBps,
    });

    const transaction = VersionedTransaction.deserialize(
      Buffer.from(order.transaction, "base64"),
    );
    const signedTx = await signTransaction(transaction);
    const signedTransactionB64 = Buffer.from(signedTx.serialize()).toString(
      "base64",
    );

    const outAmountRaw = parseInt(order.outAmount || "0");
    const outAmountHuman = outAmountRaw / Math.pow(10, outputTokenDecimals);

    if (dryRun) {
      return {
        success: true,
        signature: `dry-run-${Date.now()}`,
        outAmount: outAmountHuman.toString(),
        outAmountRaw: order.outAmount,
        feeMint: order.feeMint,
        feeBps: order.feeBps,
      };
    }

    let result = null;
    let executeError = null;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await executeUltraOrder({
          signedTransaction: signedTransactionB64,
          requestId: order.requestId,
        });

        if (result.status === "Success" && result.signature) {
          break;
        }
        throw new Error(
          result.error ?? "Ultra execute returned non-success status",
        );
      } catch (err) {
        executeError = err;
        console.warn(
          `[Jupiter Ultra] Execution attempt ${attempt} failed:`,
          err.message,
        );

        if (attempt === MAX_RETRIES) break;

        const delay = 500 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (!result || result.status !== "Success" || !result.signature) {
      throw new Error(
        executeError?.message ?? "Ultra execute failed after max retries",
      );
    }

    const confirmation = await confirmSignature(connection, result.signature);

    const base = {
      signature: result.signature,
      outAmount: outAmountHuman.toString(),
      outAmountRaw: order.outAmount,
      feeMint: order.feeMint,
      feeBps: order.feeBps,
      confirmation: confirmation.status,
    };

    if (confirmation.status === "failed") {
      return {
        ...base,
        success: false,
        error: `Transaction reverted on-chain${confirmation.error ? `: ${confirmation.error}` : ""}`,
      };
    }

    return { ...base, success: confirmation.status === "confirmed" };
  } catch (error) {
    console.error("Jupiter Ultra swap failed:", error);
    return {
      success: false,
      error: error.message || "Swap failed",
    };
  }
}
