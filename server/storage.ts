// =============================================================================
// STORAGE LAYER — note on `wallets.balance` / `wallets.availableBalance`
// =============================================================================
// After Task #17 the ledger (`ledger_entries`) is the SOURCE OF TRUTH for
// every balance. The wallets row is a denormalised display cache for the
// existing UX layer.
//
// `updateWallet()` below MUST NOT be used to write `balance` or
// `availableBalance`. Its `Partial<InsertWallet>` signature is intentionally
// narrowed (see `WalletUpdatePayload`) so those fields cannot be passed at
// the type level. The only sanctioned writer of those columns is
// `refreshWalletCacheBalance()` in `server/services/ledger.ts`, which derives
// the value from `SUM(ledger_entries)` inside the same transaction in which
// the entries were just posted.
// =============================================================================

import { 
  users, wallets, portfolios, transactions, fxRates, aiRecommendations, investmentProducts, userInvestments, portfolioSnapshots, applications, leads,
  adviserFeeRules, adviserFeeAccruals, adviserFeeDeductions,
  type User, type InsertUser, type Wallet, type InsertWallet, 
  type Portfolio, type InsertPortfolio, type Transaction, type InsertTransaction,
  type FxRate, type InsertFxRate, type AiRecommendation, type InsertAiRecommendation,
  type InvestmentProduct, type InsertInvestmentProduct, type UserInvestment, type InsertUserInvestment,
  type PortfolioSnapshot, type InsertPortfolioSnapshot,
  type Application, type InsertApplication,
  type Lead, type InsertLead,
  type AdviserFeeRule, type InsertAdviserFeeRule,
  type AdviserFeeAccrual, type InsertAdviserFeeAccrual,
  type AdviserFeeDeduction, type InsertAdviserFeeDeduction,
} from "@shared/schema";
import { db } from "./db";
import { eq, sql, and, desc, gte, lte, inArray } from "drizzle-orm";

// Wallet update payload — `balance` and `availableBalance` are intentionally
// excluded so callers cannot bypass the ledger-derived cache refresh.
export type WalletUpdatePayload = Partial<Omit<InsertWallet, "balance" | "availableBalance">>;

export interface IStorage {
  // Users
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, user: Partial<InsertUser>): Promise<User | undefined>;

  // Portfolios
  getPortfolio(userId: number): Promise<Portfolio | undefined>;
  createPortfolio(portfolio: InsertPortfolio): Promise<Portfolio>;
  updatePortfolio(userId: number, portfolio: Partial<InsertPortfolio>): Promise<Portfolio | undefined>;

  // Wallets
  getWallets(userId: number): Promise<Wallet[]>;
  getWallet(userId: number, currency: string): Promise<Wallet | undefined>;
  createWallet(wallet: InsertWallet): Promise<Wallet>;
  updateWallet(id: number, wallet: WalletUpdatePayload): Promise<Wallet | undefined>;

  // Transactions
  getTransactions(userId: number, limit?: number): Promise<Transaction[]>;
  createTransaction(transaction: InsertTransaction): Promise<Transaction>;
  updateTransaction(id: number, transaction: Partial<InsertTransaction>): Promise<Transaction | undefined>;

  // FX Rates
  getFxRates(): Promise<FxRate[]>;
  getFxRate(baseCurrency: string, targetCurrency: string): Promise<FxRate | undefined>;
  createFxRate(rate: InsertFxRate): Promise<FxRate>;
  updateFxRate(id: number, rate: Partial<InsertFxRate>): Promise<FxRate | undefined>;

  // AI Recommendations
  getAiRecommendations(userId: number): Promise<AiRecommendation[]>;
  createAiRecommendation(recommendation: InsertAiRecommendation): Promise<AiRecommendation>;
  markRecommendationAsRead(id: number, userId: number): Promise<void>;
  clearAiRecommendations(userId: number): Promise<void>;
  supersedeAiRecommendations(userId: number): Promise<void>;

  // Investment Products
  getInvestmentProducts(filters?: { category?: string; riskProfile?: string; liquidity?: string }): Promise<InvestmentProduct[]>;
  getInvestmentProduct(id: number): Promise<InvestmentProduct | undefined>;
  getUserInvestments(userId: number): Promise<UserInvestment[]>;
  createUserInvestment(investment: InsertUserInvestment): Promise<UserInvestment>;
  updateUserInvestment(id: number, investment: Partial<InsertUserInvestment>): Promise<UserInvestment | undefined>;

  // Portfolio Snapshots
  getPortfolioSnapshots(userId: number, startDate?: Date, endDate?: Date): Promise<PortfolioSnapshot[]>;
  createPortfolioSnapshot(snapshot: InsertPortfolioSnapshot): Promise<PortfolioSnapshot>;
  deletePortfolioSnapshotsForDay(userId: number, day: string): Promise<void>; // day = "YYYY-MM-DD"

  // Applications
  createApplication(application: InsertApplication): Promise<Application>;
  getApplicationByEmail(email: string): Promise<Application | undefined>;
  updateApplicationStatus(id: number, status: string, reviewNote?: string): Promise<Application | undefined>;

  // Leads (Flow A wizard captures)
  createLead(lead: InsertLead): Promise<Lead>;
  getLeadByEmail(email: string): Promise<Lead | undefined>;

  // ---------------------------------------------------------------------------
  // SESSION 23A — Adviser Fee Engine (Gate A scaffold)
  // View/audit only; no money movement; no automatic processing.
  // ---------------------------------------------------------------------------
  createAdviserFeeRule(rule: InsertAdviserFeeRule): Promise<AdviserFeeRule>;
  getAdviserFeeRule(id: number): Promise<AdviserFeeRule | undefined>;
  pauseAdviserFeeRule(id: number, reason: string | null): Promise<AdviserFeeRule | undefined>;
  listAdviserFeeRules(filters?: {
    adviserUserId?: number;
    clientUserId?: number;
    status?: string;
  }): Promise<AdviserFeeRule[]>;

  insertAdviserFeeAccrual(accrual: InsertAdviserFeeAccrual): Promise<AdviserFeeAccrual | null>;
  listAdviserFeeAccruals(filters?: {
    feeRuleId?: number;
    adviserUserId?: number;
    clientUserId?: number;
    fromDate?: Date;
    toDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<AdviserFeeAccrual[]>;

  insertAdviserFeeDeduction(
    deduction: InsertAdviserFeeDeduction,
  ): Promise<AdviserFeeDeduction>;
  getAdviserFeeDeduction(id: number): Promise<AdviserFeeDeduction | undefined>;
  listAdviserFeeDeductions(filters?: {
    status?: string;
    adviserUserId?: number;
    clientUserId?: number;
    limit?: number;
    offset?: number;
  }): Promise<AdviserFeeDeduction[]>;
  updateAdviserFeeDeduction(
    id: number,
    patch: Partial<{
      status: string;
      approvedByUserId: number | null;
      approvedAt: Date | null;
      rejectedReason: string | null;
    }>,
  ): Promise<AdviserFeeDeduction | undefined>;
}

export class MemStorage implements IStorage {
  private users: Map<number, User> = new Map();
  private portfolios: Map<number, Portfolio> = new Map();
  private wallets: Map<number, Wallet[]> = new Map();
  private transactions: Map<number, Transaction[]> = new Map();
  private fxRates: Map<string, FxRate> = new Map();
  private aiRecommendations: Map<number, AiRecommendation[]> = new Map();
  private investmentProducts: Map<number, InvestmentProduct> = new Map();
  private userInvestments: Map<number, UserInvestment[]> = new Map();
  private portfolioSnapshotsStore: Map<number, PortfolioSnapshot[]> = new Map();
  private currentUserId = 1;
  private currentPortfolioId = 1;
  private currentWalletId = 12;
  private currentTransactionId = 15;
  private currentFxRateId = 49;
  private currentAiRecommendationId = 1;
  private currentInvestmentProductId = 1;
  private currentUserInvestmentId = 1;
  private currentSnapshotId = 1;

  constructor() {
    this.initializeData();
  }

  private initializeData() {
    // Create demo user
    const demoUser: User = {
      id: 1,
      username: "Wiseinvestor",
      email: "wiseinvestor@example.com",
      password: "Wise888",
      firstName: "Wise",
      lastName: "",
      kycStatus: "verified",
      userTier: "premium",
      role: "client",
      emailVerified: true,
      emailVerificationToken: null,
      emailVerificationTokenExpiry: null,
      emailOtp: null,
      createdAt: new Date(),
    };
    this.users.set(1, demoUser);

    // Create demo portfolio
    const demoPortfolio: Portfolio = {
      id: 1,
      userId: 1,
      totalValue: "1606209.25",
      cryptoValue: "764192.25", // BTC + ETH only
      stablecoinValue: "214500.00", // USDT + USDC
      fiatValue: "627517.00",
      investmentValue: "1963250.00",
      monthlyPnl: "53541.89",
      monthlyPnlPercent: "1.50",
      updatedAt: new Date(),
    };
    this.portfolios.set(1, demoPortfolio);

    // Create demo wallets
    const demoWallets: Wallet[] = [
      {
        id: 1,
        userId: 1,
        currency: "USD",
        balance: "67482.00",
        availableBalance: "67482.00",
        walletType: "fiat",
        updatedAt: new Date(),
      },
      {
        id: 2,
        userId: 1,
        currency: "CAD",
        balance: "89365.00",
        availableBalance: "89365.00",
        walletType: "fiat",
        updatedAt: new Date(),
      },
      {
        id: 3,
        userId: 1,
        currency: "EUR",
        balance: "45820.00",
        availableBalance: "45820.00",
        walletType: "fiat",
        updatedAt: new Date(),
      },
      {
        id: 4,
        userId: 1,
        currency: "GBP",
        balance: "38750.00",
        availableBalance: "38750.00",
        walletType: "fiat",
        updatedAt: new Date(),
      },
      {
        id: 5,
        userId: 1,
        currency: "AUD",
        balance: "72100.00",
        availableBalance: "72100.00",
        walletType: "fiat",
        updatedAt: new Date(),
      },
      {
        id: 6,
        userId: 1,
        currency: "HKD",
        balance: "285500.00",
        availableBalance: "285500.00",
        walletType: "fiat",
        updatedAt: new Date(),
      },
      {
        id: 11,
        userId: 1,
        currency: "SGD",
        balance: "28500.00",
        availableBalance: "28500.00",
        walletType: "fiat",
        updatedAt: new Date(),
      },
      {
        id: 7,
        userId: 1,
        currency: "BTC",
        balance: "12.5847",
        availableBalance: "12.5847",
        walletType: "crypto",
        updatedAt: new Date(),
      },
      {
        id: 8,
        userId: 1,
        currency: "ETH",
        balance: "85.2341",
        availableBalance: "85.2341",
        walletType: "crypto",
        updatedAt: new Date(),
      },
      {
        id: 9,
        userId: 1,
        currency: "USDT",
        balance: "125000.00",
        availableBalance: "125000.00",
        walletType: "crypto",
        updatedAt: new Date(),
      },
      {
        id: 10,
        userId: 1,
        currency: "USDC",
        balance: "89500.00",
        availableBalance: "89500.00",
        walletType: "crypto",
        updatedAt: new Date(),
      },
    ];
    this.wallets.set(1, demoWallets);

    // Create demo transactions.
    // The two-field spread below adds sourceExchange/blockchainTxHash (both null)
    // to every seed object, avoiding the need to repeat them 12 times in the literal.
    const demoTransactions: Transaction[] = ([
      {
        id: 1,
        userId: 1,
        type: "deposit",
        fromCurrency: null,
        toCurrency: "CAD",
        amount: "25000.00",
        fee: "0.00",
        exchangeRate: null,
        status: "completed",
        description: "Wire Transfer from Bank of Montreal",
        createdAt: new Date(Date.now() - 86400000), // 1 day ago
      },
      {
        id: 2,
        userId: 1,
        type: "exchange",
        fromCurrency: "USD",
        toCurrency: "CAD",
        amount: "10000.00",
        fee: "50.00",
        exchangeRate: "1.3421",
        status: "completed",
        description: "USD to CAD Exchange",
        createdAt: new Date(Date.now() - 172800000), // 2 days ago
      },
      {
        id: 3,
        userId: 1,
        type: "crypto_buy",
        fromCurrency: "USD",
        toCurrency: "BTC",
        amount: "0.5",
        fee: "25.00",
        exchangeRate: "43500.00",
        status: "completed",
        description: "Bitcoin Purchase",
        createdAt: new Date(Date.now() - 259200000), // 3 days ago
      },
      {
        id: 4,
        userId: 1,
        type: "transfer",
        fromCurrency: "USD",
        toCurrency: "USD",
        amount: "50000.00",
        fee: "25.00",
        exchangeRate: null,
        status: "pending",
        description: "International Wire to Hong Kong",
        createdAt: new Date(Date.now() - 345600000), // 4 days ago
      },
      {
        id: 5,
        userId: 1,
        type: "exchange",
        fromCurrency: "USD",
        toCurrency: "GBP",
        amount: "10000.00",
        fee: "25.00",
        exchangeRate: "0.7891",
        status: "completed",
        description: "Currency exchange USD to GBP",
        createdAt: new Date(Date.now() - 432000000), // 5 days ago
      },
      {
        id: 6,
        userId: 1,
        type: "exchange",
        fromCurrency: "CAD",
        toCurrency: "AUD",
        amount: "15000.00",
        fee: "35.00",
        exchangeRate: "1.1045",
        status: "completed",
        description: "Currency exchange CAD to AUD",
        createdAt: new Date(Date.now() - 518400000), // 6 days ago
      },
      {
        id: 7,
        userId: 1,
        type: "deposit",
        fromCurrency: null,
        toCurrency: "HKD",
        amount: "50000.00",
        fee: "0.00",
        exchangeRate: null,
        status: "completed",
        description: "Bank deposit from HSBC Hong Kong",
        createdAt: new Date(Date.now() - 604800000), // 7 days ago
      },
      {
        id: 8,
        userId: 1,
        type: "transfer",
        fromCurrency: "EUR",
        toCurrency: "GBP",
        amount: "5000.00",
        fee: "18.00",
        exchangeRate: "0.9249",
        status: "pending",
        description: "Cross-border transfer to UK",
        createdAt: new Date(Date.now() - 86400000), // 1 day ago
      },
      {
        id: 9,
        userId: 1,
        type: "crypto_buy",
        fromCurrency: "USD",
        toCurrency: "USDT",
        amount: "25000.00",
        fee: "12.50",
        exchangeRate: "1.0000",
        status: "completed",
        description: "USD to USDT conversion",
        createdAt: new Date(Date.now() - 172800000), // 2 days ago
      },
      {
        id: 10,
        userId: 1,
        type: "crypto_buy",
        fromCurrency: "USD",
        toCurrency: "USDC",
        amount: "15000.00",
        fee: "7.50",
        exchangeRate: "1.0000",
        status: "completed",
        description: "USD to USDC conversion",
        createdAt: new Date(Date.now() - 259200000), // 3 days ago
      },
      {
        id: 11,
        userId: 1,
        type: "crypto_deposit",
        fromCurrency: null,
        toCurrency: "USDT",
        amount: "50000.00",
        fee: "15.00",
        exchangeRate: null,
        status: "completed",
        description: "USDT deposit from external wallet",
        createdAt: new Date(Date.now() - 345600000), // 4 days ago
      },
      {
        id: 12,
        userId: 1,
        type: "stablecoin_swap",
        fromCurrency: "USDT",
        toCurrency: "USDC",
        amount: "10000.00",
        fee: "5.00",
        exchangeRate: "0.9998",
        status: "completed",
        description: "USDT to USDC swap",
        createdAt: new Date(Date.now() - 432000000), // 5 days ago
      },
    ] as Omit<Transaction, "sourceExchange" | "blockchainTxHash">[]).map(
      (tx): Transaction => ({ ...tx, sourceExchange: null, blockchainTxHash: null })
    );
    this.transactions.set(1, demoTransactions);

    // Create demo FX rates
    const demoFxRates: FxRate[] = [
      {
        id: 1,
        baseCurrency: "USD",
        targetCurrency: "CAD",
        rate: "1.3421",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 2,
        baseCurrency: "USD",
        targetCurrency: "EUR",
        rate: "0.8532",
        spread: "0.004",
        updatedAt: new Date(),
      },
      {
        id: 3,
        baseCurrency: "USD",
        targetCurrency: "GBP",
        rate: "0.7891",
        spread: "0.003",
        updatedAt: new Date(),
      },
      {
        id: 4,
        baseCurrency: "USD",
        targetCurrency: "AUD",
        rate: "1.4825",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 5,
        baseCurrency: "USD",
        targetCurrency: "HKD",
        rate: "7.8234",
        spread: "0.004",
        updatedAt: new Date(),
      },
      {
        id: 6,
        baseCurrency: "CAD",
        targetCurrency: "EUR",
        rate: "0.6354",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 7,
        baseCurrency: "CAD",
        targetCurrency: "GBP",
        rate: "0.5882",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 8,
        baseCurrency: "EUR",
        targetCurrency: "GBP",
        rate: "0.9249",
        spread: "0.004",
        updatedAt: new Date(),
      },
      {
        id: 9,
        baseCurrency: "GBP",
        targetCurrency: "AUD",
        rate: "1.8792",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 10,
        baseCurrency: "AUD",
        targetCurrency: "HKD",
        rate: "5.2758",
        spread: "0.006",
        updatedAt: new Date(),
      },
      // Stablecoin exchange rates
      {
        id: 11,
        baseCurrency: "USDT",
        targetCurrency: "USD",
        rate: "0.9998",
        spread: "0.001",
        updatedAt: new Date(),
      },
      {
        id: 12,
        baseCurrency: "USDC",
        targetCurrency: "USD",
        rate: "1.0001",
        spread: "0.001",
        updatedAt: new Date(),
      },
      {
        id: 13,
        baseCurrency: "USD",
        targetCurrency: "USDT",
        rate: "1.0002",
        spread: "0.001",
        updatedAt: new Date(),
      },
      {
        id: 14,
        baseCurrency: "USD",
        targetCurrency: "USDC",
        rate: "0.9999",
        spread: "0.001",
        updatedAt: new Date(),
      },
      {
        id: 15,
        baseCurrency: "USDT",
        targetCurrency: "USDC",
        rate: "1.0003",
        spread: "0.001",
        updatedAt: new Date(),
      },
      {
        id: 16,
        baseCurrency: "USDC",
        targetCurrency: "USDT",
        rate: "0.9997",
        spread: "0.001",
        updatedAt: new Date(),
      },
      // Stablecoin to other currencies
      {
        id: 17,
        baseCurrency: "USDT",
        targetCurrency: "CAD",
        rate: "1.3423",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 18,
        baseCurrency: "USDC",
        targetCurrency: "CAD",
        rate: "1.3420",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 19,
        baseCurrency: "USDT",
        targetCurrency: "EUR",
        rate: "0.8533",
        spread: "0.004",
        updatedAt: new Date(),
      },
      {
        id: 20,
        baseCurrency: "USDC",
        targetCurrency: "EUR",
        rate: "0.8531",
        spread: "0.004",
        updatedAt: new Date(),
      },
      // Bitcoin exchange rates - Updated to current market
      {
        id: 21,
        baseCurrency: "BTC",
        targetCurrency: "USD",
        rate: "97250.00",
        spread: "0.01",
        updatedAt: new Date(),
      },
      {
        id: 22,
        baseCurrency: "USD",
        targetCurrency: "BTC",
        rate: "0.00001028",
        spread: "0.01",
        updatedAt: new Date(),
      },
      {
        id: 23,
        baseCurrency: "BTC",
        targetCurrency: "CAD",
        rate: "130556.25",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 24,
        baseCurrency: "BTC",
        targetCurrency: "EUR",
        rate: "82454.75",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 25,
        baseCurrency: "BTC",
        targetCurrency: "GBP",
        rate: "76831.25",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 26,
        baseCurrency: "BTC",
        targetCurrency: "AUD",
        rate: "144206.75",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 27,
        baseCurrency: "BTC",
        targetCurrency: "HKD",
        rate: "761070.00",
        spread: "0.015",
        updatedAt: new Date(),
      },
      // Ethereum exchange rates - Updated to current market
      {
        id: 28,
        baseCurrency: "ETH",
        targetCurrency: "USD",
        rate: "3420.00",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 29,
        baseCurrency: "USD",
        targetCurrency: "ETH",
        rate: "0.000292",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 30,
        baseCurrency: "ETH",
        targetCurrency: "CAD",
        rate: "4588.84",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 31,
        baseCurrency: "ETH",
        targetCurrency: "EUR",
        rate: "2898.60",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 32,
        baseCurrency: "ETH",
        targetCurrency: "GBP",
        rate: "2701.74",
        spread: "0.012",
        updatedAt: new Date(),
      },
      // BTC to ETH and vice versa - Updated ratios
      {
        id: 33,
        baseCurrency: "BTC",
        targetCurrency: "ETH",
        rate: "28.43",
        spread: "0.02",
        updatedAt: new Date(),
      },
      {
        id: 34,
        baseCurrency: "ETH",
        targetCurrency: "BTC",
        rate: "0.0352",
        spread: "0.02",
        updatedAt: new Date(),
      },
      // Stablecoin to crypto rates - Updated 
      {
        id: 35,
        baseCurrency: "USDT",
        targetCurrency: "BTC",
        rate: "0.00001028",
        spread: "0.01",
        updatedAt: new Date(),
      },
      {
        id: 36,
        baseCurrency: "USDT",
        targetCurrency: "ETH",
        rate: "0.000292",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 37,
        baseCurrency: "USDC",
        targetCurrency: "BTC",
        rate: "0.00001028",
        spread: "0.01",
        updatedAt: new Date(),
      },
      {
        id: 38,
        baseCurrency: "USDC",
        targetCurrency: "ETH",
        rate: "0.000292",
        spread: "0.008",
        updatedAt: new Date(),
      },
      // Reverse crypto to stablecoin rates - Updated
      {
        id: 39,
        baseCurrency: "BTC",
        targetCurrency: "USDT",
        rate: "97248.00",
        spread: "0.01",
        updatedAt: new Date(),
      },
      {
        id: 40,
        baseCurrency: "BTC",
        targetCurrency: "USDC",
        rate: "97252.00",
        spread: "0.01",
        updatedAt: new Date(),
      },
      {
        id: 41,
        baseCurrency: "ETH",
        targetCurrency: "USDT",
        rate: "3418.50",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 42,
        baseCurrency: "ETH",
        targetCurrency: "USDC",
        rate: "3421.50",
        spread: "0.008",
        updatedAt: new Date(),
      },
      // Additional stablecoin to fiat rates
      {
        id: 43,
        baseCurrency: "USDT",
        targetCurrency: "GBP",
        rate: "0.7893",
        spread: "0.003",
        updatedAt: new Date(),
      },
      {
        id: 44,
        baseCurrency: "USDT",
        targetCurrency: "AUD",
        rate: "1.4827",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 45,
        baseCurrency: "USDT",
        targetCurrency: "HKD",
        rate: "7.8236",
        spread: "0.004",
        updatedAt: new Date(),
      },
      {
        id: 46,
        baseCurrency: "USDC",
        targetCurrency: "GBP",
        rate: "0.7890",
        spread: "0.003",
        updatedAt: new Date(),
      },
      {
        id: 47,
        baseCurrency: "USDC",
        targetCurrency: "AUD",
        rate: "1.4823",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 48,
        baseCurrency: "USDC",
        targetCurrency: "HKD",
        rate: "7.8232",
        spread: "0.004",
        updatedAt: new Date(),
      },
      // SGD exchange rates
      {
        id: 49,
        baseCurrency: "USD",
        targetCurrency: "SGD",
        rate: "1.3520",
        spread: "0.004",
        updatedAt: new Date(),
      },
      {
        id: 50,
        baseCurrency: "SGD",
        targetCurrency: "USD",
        rate: "0.7396",
        spread: "0.004",
        updatedAt: new Date(),
      },
      {
        id: 51,
        baseCurrency: "USDT",
        targetCurrency: "SGD",
        rate: "1.3518",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 52,
        baseCurrency: "USDC",
        targetCurrency: "SGD",
        rate: "1.3515",
        spread: "0.005",
        updatedAt: new Date(),
      },
      // Add missing EUR to USD rate that was causing 404
      {
        id: 53,
        baseCurrency: "EUR",
        targetCurrency: "USD",
        rate: "1.1800",
        spread: "0.004",
        updatedAt: new Date(),
      },
      // JPY (Japanese Yen) rates
      {
        id: 54,
        baseCurrency: "USD",
        targetCurrency: "JPY",
        rate: "149.85",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 55,
        baseCurrency: "JPY",
        targetCurrency: "USD",
        rate: "0.006673",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 56,
        baseCurrency: "EUR",
        targetCurrency: "JPY",
        rate: "175.85",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 57,
        baseCurrency: "GBP",
        targetCurrency: "JPY",
        rate: "189.91",
        spread: "0.008",
        updatedAt: new Date(),
      },
      // CHF (Swiss Franc) rates
      {
        id: 58,
        baseCurrency: "USD",
        targetCurrency: "CHF",
        rate: "0.8845",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 59,
        baseCurrency: "CHF",
        targetCurrency: "USD",
        rate: "1.1306",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 60,
        baseCurrency: "EUR",
        targetCurrency: "CHF",
        rate: "1.0367",
        spread: "0.004",
        updatedAt: new Date(),
      },
      {
        id: 61,
        baseCurrency: "GBP",
        targetCurrency: "CHF",
        rate: "1.1209",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 62,
        baseCurrency: "CAD",
        targetCurrency: "CHF",
        rate: "0.6591",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 63,
        baseCurrency: "AUD",
        targetCurrency: "CHF",
        rate: "0.5967",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 64,
        baseCurrency: "HKD",
        targetCurrency: "CHF",
        rate: "0.1131",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 65,
        baseCurrency: "SGD",
        targetCurrency: "CHF",
        rate: "0.6542",
        spread: "0.006",
        updatedAt: new Date(),
      },
      // Crypto to CHF rates
      {
        id: 66,
        baseCurrency: "BTC",
        targetCurrency: "CHF",
        rate: "86013.25",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 67,
        baseCurrency: "ETH",
        targetCurrency: "CHF",
        rate: "3024.09",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 68,
        baseCurrency: "USDT",
        targetCurrency: "CHF",
        rate: "0.8847",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 69,
        baseCurrency: "USDC",
        targetCurrency: "CHF",
        rate: "0.8844",
        spread: "0.005",
        updatedAt: new Date(),
      },
      // Additional reverse pairs
      {
        id: 70,
        baseCurrency: "CAD",
        targetCurrency: "USD",
        rate: "0.7451",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 71,
        baseCurrency: "AUD",
        targetCurrency: "USD",
        rate: "0.6745",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 72,
        baseCurrency: "GBP",
        targetCurrency: "USD",
        rate: "1.2673",
        spread: "0.003",
        updatedAt: new Date(),
      },
      {
        id: 73,
        baseCurrency: "HKD",
        targetCurrency: "USD",
        rate: "0.1278",
        spread: "0.004",
        updatedAt: new Date(),
      },
      // Additional JPY pairs
      {
        id: 74,
        baseCurrency: "BTC",
        targetCurrency: "JPY",
        rate: "14574637.50",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 75,
        baseCurrency: "ETH",
        targetCurrency: "JPY",
        rate: "512427.00",
        spread: "0.012",
        updatedAt: new Date(),
      },
      // Missing fiat to BTC rates
      {
        id: 76,
        baseCurrency: "EUR",
        targetCurrency: "BTC",
        rate: "0.00001213",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 77,
        baseCurrency: "GBP",
        targetCurrency: "BTC",
        rate: "0.00001301",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 78,
        baseCurrency: "CAD",
        targetCurrency: "BTC",
        rate: "0.00000766",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 79,
        baseCurrency: "AUD",
        targetCurrency: "BTC",
        rate: "0.00000693",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 80,
        baseCurrency: "HKD",
        targetCurrency: "BTC",
        rate: "0.00000131",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 81,
        baseCurrency: "SGD",
        targetCurrency: "BTC",
        rate: "0.00000760",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 82,
        baseCurrency: "JPY",
        targetCurrency: "BTC",
        rate: "0.00000006863",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 83,
        baseCurrency: "CHF",
        targetCurrency: "BTC",
        rate: "0.00001163",
        spread: "0.015",
        updatedAt: new Date(),
      },
      // Missing fiat to ETH rates
      {
        id: 84,
        baseCurrency: "EUR",
        targetCurrency: "ETH",
        rate: "0.000345",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 85,
        baseCurrency: "GBP",
        targetCurrency: "ETH",
        rate: "0.000370",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 86,
        baseCurrency: "CAD",
        targetCurrency: "ETH",
        rate: "0.000218",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 87,
        baseCurrency: "AUD",
        targetCurrency: "ETH",
        rate: "0.000197",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 88,
        baseCurrency: "HKD",
        targetCurrency: "ETH",
        rate: "0.0000373",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 89,
        baseCurrency: "SGD",
        targetCurrency: "ETH",
        rate: "0.000216",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 90,
        baseCurrency: "JPY",
        targetCurrency: "ETH",
        rate: "0.00000195",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 91,
        baseCurrency: "CHF",
        targetCurrency: "ETH",
        rate: "0.000331",
        spread: "0.012",
        updatedAt: new Date(),
      },
      // Missing fiat to USDT rates  
      {
        id: 92,
        baseCurrency: "EUR",
        targetCurrency: "USDT",
        rate: "1.1722",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 93,
        baseCurrency: "GBP",
        targetCurrency: "USDT",
        rate: "1.2665",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 94,
        baseCurrency: "CAD",
        targetCurrency: "USDT",
        rate: "0.7449",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 95,
        baseCurrency: "AUD",
        targetCurrency: "USDT",
        rate: "0.6743",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 96,
        baseCurrency: "HKD",
        targetCurrency: "USDT",
        rate: "0.1277",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 97,
        baseCurrency: "SGD",
        targetCurrency: "USDT",
        rate: "0.7394",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 98,
        baseCurrency: "JPY",
        targetCurrency: "USDT",
        rate: "0.006671",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 99,
        baseCurrency: "CHF",
        targetCurrency: "USDT",
        rate: "1.1304",
        spread: "0.005",
        updatedAt: new Date(),
      },
      // Missing fiat to USDC rates
      {
        id: 100,
        baseCurrency: "EUR",
        targetCurrency: "USDC",
        rate: "1.1719",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 101,
        baseCurrency: "GBP",
        targetCurrency: "USDC",
        rate: "1.2662",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 102,
        baseCurrency: "CAD",
        targetCurrency: "USDC",
        rate: "0.7447",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 103,
        baseCurrency: "AUD",
        targetCurrency: "USDC",
        rate: "0.6741",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 104,
        baseCurrency: "HKD",
        targetCurrency: "USDC",
        rate: "0.1276",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 105,
        baseCurrency: "SGD",
        targetCurrency: "USDC",
        rate: "0.7392",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 106,
        baseCurrency: "JPY",
        targetCurrency: "USDC",
        rate: "0.006669",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 107,
        baseCurrency: "CHF",
        targetCurrency: "USDC",
        rate: "1.1302",
        spread: "0.005",
        updatedAt: new Date(),
      },
      // Missing same-currency pairs (1:1 rates)
      {
        id: 108,
        baseCurrency: "USD",
        targetCurrency: "USD",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 109,
        baseCurrency: "EUR",
        targetCurrency: "EUR",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 110,
        baseCurrency: "GBP",
        targetCurrency: "GBP",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 111,
        baseCurrency: "CAD",
        targetCurrency: "CAD",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 112,
        baseCurrency: "AUD",
        targetCurrency: "AUD",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 113,
        baseCurrency: "HKD",
        targetCurrency: "HKD",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 114,
        baseCurrency: "SGD",
        targetCurrency: "SGD",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 115,
        baseCurrency: "JPY",
        targetCurrency: "JPY",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 116,
        baseCurrency: "CHF",
        targetCurrency: "CHF",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 117,
        baseCurrency: "BTC",
        targetCurrency: "BTC",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 118,
        baseCurrency: "ETH",
        targetCurrency: "ETH",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 119,
        baseCurrency: "USDT",
        targetCurrency: "USDT",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      {
        id: 120,
        baseCurrency: "USDC",
        targetCurrency: "USDC",
        rate: "1.0000",
        spread: "0.000",
        updatedAt: new Date(),
      },
      // Missing reverse pairs for GBP conversions
      {
        id: 121,
        baseCurrency: "AUD",
        targetCurrency: "GBP",
        rate: "0.5324",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 122,
        baseCurrency: "HKD",
        targetCurrency: "GBP",
        rate: "0.1008",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 123,
        baseCurrency: "SGD",
        targetCurrency: "GBP",
        rate: "0.5836",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 124,
        baseCurrency: "JPY",
        targetCurrency: "GBP",
        rate: "0.005267",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 125,
        baseCurrency: "CHF",
        targetCurrency: "GBP",
        rate: "0.8921",
        spread: "0.005",
        updatedAt: new Date(),
      },
      // Missing reverse pairs for EUR conversions
      {
        id: 126,
        baseCurrency: "AUD",
        targetCurrency: "EUR",
        rate: "0.5756",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 127,
        baseCurrency: "HKD",
        targetCurrency: "EUR",
        rate: "0.1090",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 128,
        baseCurrency: "SGD",
        targetCurrency: "EUR",
        rate: "0.6309",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 129,
        baseCurrency: "JPY",
        targetCurrency: "EUR",
        rate: "0.005686",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 130,
        baseCurrency: "CHF",
        targetCurrency: "EUR",
        rate: "0.9646",
        spread: "0.005",
        updatedAt: new Date(),
      },
      // Missing GBP to EUR rate
      {
        id: 131,
        baseCurrency: "GBP",
        targetCurrency: "EUR",
        rate: "1.0812",
        spread: "0.004",
        updatedAt: new Date(),
      },
      // Missing direct conversion pairs for JPY, AUD, CAD, SGD, HKD
      // USD to these currencies already exist, need reverse pairs
      {
        id: 132,
        baseCurrency: "SGD",
        targetCurrency: "USD",
        rate: "0.7395",
        spread: "0.005",
        updatedAt: new Date(),
      },
      // Additional cross-currency pairs needed for dropdown conversions
      {
        id: 133,
        baseCurrency: "USD",
        targetCurrency: "AUD",
        rate: "1.4825",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 134,
        baseCurrency: "USD",
        targetCurrency: "CAD", 
        rate: "1.3421",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 135,
        baseCurrency: "USD",
        targetCurrency: "SGD",
        rate: "1.3518",
        spread: "0.005", 
        updatedAt: new Date(),
      },
      {
        id: 136,
        baseCurrency: "USD",
        targetCurrency: "HKD",
        rate: "7.8234",
        spread: "0.004",
        updatedAt: new Date(),
      },
      // EUR direct conversions
      {
        id: 137,
        baseCurrency: "EUR",
        targetCurrency: "JPY",
        rate: "175.85",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 138,
        baseCurrency: "EUR",
        targetCurrency: "AUD",
        rate: "1.7381",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 139,
        baseCurrency: "EUR",
        targetCurrency: "CAD",
        rate: "1.5737",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 140,
        baseCurrency: "EUR",
        targetCurrency: "SGD",
        rate: "1.5853",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 141,
        baseCurrency: "EUR",
        targetCurrency: "HKD",
        rate: "9.1744",
        spread: "0.006",
        updatedAt: new Date(),
      },
      // GBP direct conversions
      {
        id: 142,
        baseCurrency: "GBP",
        targetCurrency: "JPY",
        rate: "189.91",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 143,
        baseCurrency: "GBP",
        targetCurrency: "AUD",
        rate: "1.8784",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 144,
        baseCurrency: "GBP",
        targetCurrency: "CAD",
        rate: "1.7008",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 145,
        baseCurrency: "GBP",
        targetCurrency: "SGD",
        rate: "1.7129",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 146,
        baseCurrency: "GBP",
        targetCurrency: "HKD",
        rate: "9.9147",
        spread: "0.006",
        updatedAt: new Date(),
      },
      // Crypto direct conversions to these currencies
      {
        id: 147,
        baseCurrency: "BTC",
        targetCurrency: "AUD",
        rate: "144126.25",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 148,
        baseCurrency: "BTC",
        targetCurrency: "CAD",
        rate: "130541.75",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 149,
        baseCurrency: "BTC",
        targetCurrency: "SGD",
        rate: "131376.25",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 150,
        baseCurrency: "BTC",
        targetCurrency: "HKD",
        rate: "760543.75",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 151,
        baseCurrency: "ETH",
        targetCurrency: "AUD",
        rate: "5069.85",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 152,
        baseCurrency: "ETH",
        targetCurrency: "CAD",
        rate: "4590.76",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 153,
        baseCurrency: "ETH",
        targetCurrency: "SGD",
        rate: "4623.20",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 154,
        baseCurrency: "ETH",
        targetCurrency: "HKD",
        rate: "26753.88",
        spread: "0.012",
        updatedAt: new Date(),
      },
      // Stablecoins to these currencies
      {
        id: 155,
        baseCurrency: "USDT",
        targetCurrency: "AUD",
        rate: "1.4826",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 156,
        baseCurrency: "USDT",
        targetCurrency: "CAD",
        rate: "1.3423",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 157,
        baseCurrency: "USDT",
        targetCurrency: "SGD",
        rate: "1.3520",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 158,
        baseCurrency: "USDT",
        targetCurrency: "HKD",
        rate: "7.8251",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 159,
        baseCurrency: "USDT",
        targetCurrency: "JPY",
        rate: "149.88",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 160,
        baseCurrency: "USDC",
        targetCurrency: "AUD",
        rate: "1.4823",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 161,
        baseCurrency: "USDC",
        targetCurrency: "CAD",
        rate: "1.3420",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 162,
        baseCurrency: "USDC",
        targetCurrency: "SGD",
        rate: "1.3517",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 163,
        baseCurrency: "USDC",
        targetCurrency: "HKD",
        rate: "7.8231",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 164,
        baseCurrency: "USDC",
        targetCurrency: "JPY",
        rate: "149.82",
        spread: "0.005",
        updatedAt: new Date(),
      },
      // Missing JPY conversion pairs that were causing 404 errors
      {
        id: 165,
        baseCurrency: "AUD",
        targetCurrency: "JPY",
        rate: "101.08",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 166,
        baseCurrency: "CAD",
        targetCurrency: "JPY",
        rate: "111.72",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 167,
        baseCurrency: "HKD",
        targetCurrency: "JPY",
        rate: "19.16",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 168,
        baseCurrency: "SGD",
        targetCurrency: "JPY",
        rate: "110.87",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 169,
        baseCurrency: "CHF",
        targetCurrency: "JPY",
        rate: "169.42",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 170,
        baseCurrency: "JPY",
        targetCurrency: "AUD",
        rate: "0.009893",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 171,
        baseCurrency: "JPY",
        targetCurrency: "CAD",
        rate: "0.008951",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 172,
        baseCurrency: "JPY",
        targetCurrency: "HKD",
        rate: "0.05219",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 173,
        baseCurrency: "JPY",
        targetCurrency: "SGD",
        rate: "0.009020",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 174,
        baseCurrency: "JPY",
        targetCurrency: "CHF",
        rate: "0.005903",
        spread: "0.008",
        updatedAt: new Date(),
      },
      // Missing AUD conversion pairs
      {
        id: 175,
        baseCurrency: "CAD",
        targetCurrency: "AUD",
        rate: "1.1044",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 176,
        baseCurrency: "HKD",
        targetCurrency: "AUD",
        rate: "0.1894",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 177,
        baseCurrency: "SGD",
        targetCurrency: "AUD",
        rate: "1.0968",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 178,
        baseCurrency: "CHF",
        targetCurrency: "AUD",
        rate: "1.6760",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 179,
        baseCurrency: "JPY",
        targetCurrency: "AUD",
        rate: "0.009893",
        spread: "0.008",
        updatedAt: new Date(),
      },
      // Missing CAD conversion pairs
      {
        id: 180,
        baseCurrency: "AUD",
        targetCurrency: "CAD",
        rate: "0.9055",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 181,
        baseCurrency: "HKD",
        targetCurrency: "CAD",
        rate: "0.1715",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 182,
        baseCurrency: "SGD",
        targetCurrency: "CAD",
        rate: "0.9928",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 183,
        baseCurrency: "CHF",
        targetCurrency: "CAD",
        rate: "1.5174",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 184,
        baseCurrency: "JPY",
        targetCurrency: "CAD",
        rate: "0.008951",
        spread: "0.008",
        updatedAt: new Date(),
      },
      // Missing SGD conversion pairs
      {
        id: 185,
        baseCurrency: "CAD",
        targetCurrency: "SGD",
        rate: "1.0070",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 186,
        baseCurrency: "AUD",
        targetCurrency: "SGD",
        rate: "0.9117",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 187,
        baseCurrency: "HKD",
        targetCurrency: "SGD",
        rate: "0.1728",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 188,
        baseCurrency: "CHF",
        targetCurrency: "SGD",
        rate: "1.5288",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 189,
        baseCurrency: "JPY",
        targetCurrency: "SGD",
        rate: "0.009020",
        spread: "0.008",
        updatedAt: new Date(),
      },
      // Missing HKD conversion pairs
      {
        id: 190,
        baseCurrency: "CAD",
        targetCurrency: "HKD",
        rate: "5.8286",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 191,
        baseCurrency: "AUD",
        targetCurrency: "HKD",
        rate: "5.2795",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 192,
        baseCurrency: "SGD",
        targetCurrency: "HKD",
        rate: "5.7871",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 193,
        baseCurrency: "CHF",
        targetCurrency: "HKD",
        rate: "8.8493",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 194,
        baseCurrency: "JPY",
        targetCurrency: "HKD",
        rate: "0.05219",
        spread: "0.008",
        updatedAt: new Date(),
      },
      // Missing CHF cross-currency pairs
      {
        id: 195,
        baseCurrency: "AUD",
        targetCurrency: "CHF",
        rate: "0.5967",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 196,
        baseCurrency: "CAD",
        targetCurrency: "CHF",
        rate: "0.6591",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 197,
        baseCurrency: "SGD",
        targetCurrency: "CHF",
        rate: "0.6542",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 198,
        baseCurrency: "HKD",
        targetCurrency: "CHF",
        rate: "0.1131",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 199,
        baseCurrency: "JPY",
        targetCurrency: "CHF",
        rate: "0.005903",
        spread: "0.008",
        updatedAt: new Date(),
      },
      // Vietnamese Dong (VND) exchange rates
      {
        id: 200,
        baseCurrency: "USD",
        targetCurrency: "VND",
        rate: "24850.00",
        spread: "0.010",
        updatedAt: new Date(),
      },
      {
        id: 201,
        baseCurrency: "VND",
        targetCurrency: "USD",
        rate: "0.00004024",
        spread: "0.010",
        updatedAt: new Date(),
      },
      {
        id: 202,
        baseCurrency: "EUR",
        targetCurrency: "VND",
        rate: "26185.50",
        spread: "0.010",
        updatedAt: new Date(),
      },
      {
        id: 203,
        baseCurrency: "VND",
        targetCurrency: "EUR",
        rate: "0.00003818",
        spread: "0.010",
        updatedAt: new Date(),
      },
      {
        id: 204,
        baseCurrency: "SGD",
        targetCurrency: "VND",
        rate: "18516.75",
        spread: "0.010",
        updatedAt: new Date(),
      },
      {
        id: 205,
        baseCurrency: "VND",
        targetCurrency: "SGD",
        rate: "0.00005401",
        spread: "0.010",
        updatedAt: new Date(),
      },
      {
        id: 206,
        baseCurrency: "HKD",
        targetCurrency: "VND",
        rate: "3196.25",
        spread: "0.010",
        updatedAt: new Date(),
      },
      {
        id: 207,
        baseCurrency: "VND",
        targetCurrency: "HKD",
        rate: "0.0003129",
        spread: "0.010",
        updatedAt: new Date(),
      },
      // VND to USDC and USDT conversions
      {
        id: 208,
        baseCurrency: "VND",
        targetCurrency: "USDC",
        rate: "0.00004023",
        spread: "0.010",
        updatedAt: new Date(),
      },
      {
        id: 209,
        baseCurrency: "USDC",
        targetCurrency: "VND",
        rate: "24860.00",
        spread: "0.010",
        updatedAt: new Date(),
      },
      {
        id: 210,
        baseCurrency: "VND",
        targetCurrency: "USDT",
        rate: "0.00004024",
        spread: "0.010",
        updatedAt: new Date(),
      },
      {
        id: 211,
        baseCurrency: "USDT",
        targetCurrency: "VND",
        rate: "24850.00",
        spread: "0.010",
        updatedAt: new Date(),
      },
      // CHF to crypto conversions that might be missing
      {
        id: 212,
        baseCurrency: "CHF",
        targetCurrency: "BTC",
        rate: "0.00001036",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 213,
        baseCurrency: "CHF",
        targetCurrency: "ETH",
        rate: "0.0002950",
        spread: "0.015",
        updatedAt: new Date(),
      },
      // Additional European currencies - SEK, NOK, DKK, PLN, CZK, HUF
      {
        id: 214,
        baseCurrency: "USD",
        targetCurrency: "SEK",
        rate: "10.8420",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 215,
        baseCurrency: "SEK",
        targetCurrency: "USD",
        rate: "0.0922",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 216,
        baseCurrency: "USD",
        targetCurrency: "NOK",
        rate: "10.7850",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 217,
        baseCurrency: "NOK",
        targetCurrency: "USD",
        rate: "0.0927",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 218,
        baseCurrency: "USD",
        targetCurrency: "DKK",
        rate: "6.9850",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 219,
        baseCurrency: "DKK",
        targetCurrency: "USD",
        rate: "0.1432",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 220,
        baseCurrency: "USD",
        targetCurrency: "PLN",
        rate: "4.0320",
        spread: "0.007",
        updatedAt: new Date(),
      },
      {
        id: 221,
        baseCurrency: "PLN",
        targetCurrency: "USD",
        rate: "0.2480",
        spread: "0.007",
        updatedAt: new Date(),
      },
      {
        id: 222,
        baseCurrency: "USD",
        targetCurrency: "CZK",
        rate: "23.8450",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 223,
        baseCurrency: "CZK",
        targetCurrency: "USD",
        rate: "0.0419",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 224,
        baseCurrency: "USD",
        targetCurrency: "HUF",
        rate: "385.20",
        spread: "0.010",
        updatedAt: new Date(),
      },
      {
        id: 225,
        baseCurrency: "HUF",
        targetCurrency: "USD",
        rate: "0.00259",
        spread: "0.010",
        updatedAt: new Date(),
      },
      // Additional Asian currencies - KRW, TWD, THB, MYR, IDR, PHP, INR, CNY
      {
        id: 226,
        baseCurrency: "USD",
        targetCurrency: "KRW",
        rate: "1342.50",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 227,
        baseCurrency: "KRW",
        targetCurrency: "USD",
        rate: "0.000745",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 228,
        baseCurrency: "USD",
        targetCurrency: "TWD",
        rate: "31.85",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 229,
        baseCurrency: "TWD",
        targetCurrency: "USD",
        rate: "0.0314",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 230,
        baseCurrency: "USD",
        targetCurrency: "THB",
        rate: "34.25",
        spread: "0.007",
        updatedAt: new Date(),
      },
      {
        id: 231,
        baseCurrency: "THB",
        targetCurrency: "USD",
        rate: "0.0292",
        spread: "0.007",
        updatedAt: new Date(),
      },
      {
        id: 232,
        baseCurrency: "USD",
        targetCurrency: "MYR",
        rate: "4.4850",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 233,
        baseCurrency: "MYR",
        targetCurrency: "USD",
        rate: "0.2230",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 234,
        baseCurrency: "USD",
        targetCurrency: "IDR",
        rate: "15620.00",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 235,
        baseCurrency: "IDR",
        targetCurrency: "USD",
        rate: "0.000064",
        spread: "0.012",
        updatedAt: new Date(),
      },
      {
        id: 236,
        baseCurrency: "USD",
        targetCurrency: "PHP",
        rate: "56.85",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 237,
        baseCurrency: "PHP",
        targetCurrency: "USD",
        rate: "0.0176",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 238,
        baseCurrency: "USD",
        targetCurrency: "INR",
        rate: "83.25",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 239,
        baseCurrency: "INR",
        targetCurrency: "USD",
        rate: "0.0120",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 240,
        baseCurrency: "USD",
        targetCurrency: "CNY",
        rate: "7.2850",
        spread: "0.004",
        updatedAt: new Date(),
      },
      {
        id: 241,
        baseCurrency: "CNY",
        targetCurrency: "USD",
        rate: "0.1373",
        spread: "0.004",
        updatedAt: new Date(),
      },
      // Additional Americas currencies - BRL, MXN
      {
        id: 242,
        baseCurrency: "USD",
        targetCurrency: "BRL",
        rate: "5.9850",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 243,
        baseCurrency: "BRL",
        targetCurrency: "USD",
        rate: "0.1671",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 244,
        baseCurrency: "USD",
        targetCurrency: "MXN",
        rate: "19.85",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 245,
        baseCurrency: "MXN",
        targetCurrency: "USD",
        rate: "0.0504",
        spread: "0.006",
        updatedAt: new Date(),
      },
      // Additional Oceania currencies - NZD
      {
        id: 246,
        baseCurrency: "USD",
        targetCurrency: "NZD",
        rate: "1.6850",
        spread: "0.005",
        updatedAt: new Date(),
      },
      {
        id: 247,
        baseCurrency: "NZD",
        targetCurrency: "USD",
        rate: "0.5935",
        spread: "0.005",
        updatedAt: new Date(),
      },
      // Middle East and African currencies - AED, SAR, ILS, EGP, NGN, ZAR
      {
        id: 248,
        baseCurrency: "USD",
        targetCurrency: "AED",
        rate: "3.6730",
        spread: "0.003",
        updatedAt: new Date(),
      },
      {
        id: 249,
        baseCurrency: "AED",
        targetCurrency: "USD",
        rate: "0.2722",
        spread: "0.003",
        updatedAt: new Date(),
      },
      {
        id: 250,
        baseCurrency: "USD",
        targetCurrency: "SAR",
        rate: "3.7500",
        spread: "0.003",
        updatedAt: new Date(),
      },
      {
        id: 251,
        baseCurrency: "SAR",
        targetCurrency: "USD",
        rate: "0.2667",
        spread: "0.003",
        updatedAt: new Date(),
      },
      {
        id: 252,
        baseCurrency: "USD",
        targetCurrency: "ILS",
        rate: "3.7850",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 253,
        baseCurrency: "ILS",
        targetCurrency: "USD",
        rate: "0.2642",
        spread: "0.006",
        updatedAt: new Date(),
      },
      {
        id: 254,
        baseCurrency: "USD",
        targetCurrency: "EGP",
        rate: "49.85",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 255,
        baseCurrency: "EGP",
        targetCurrency: "USD",
        rate: "0.0201",
        spread: "0.015",
        updatedAt: new Date(),
      },
      {
        id: 256,
        baseCurrency: "USD",
        targetCurrency: "NGN",
        rate: "1485.00",
        spread: "0.020",
        updatedAt: new Date(),
      },
      {
        id: 257,
        baseCurrency: "NGN",
        targetCurrency: "USD",
        rate: "0.000673",
        spread: "0.020",
        updatedAt: new Date(),
      },
      {
        id: 258,
        baseCurrency: "USD",
        targetCurrency: "ZAR",
        rate: "18.25",
        spread: "0.008",
        updatedAt: new Date(),
      },
      {
        id: 259,
        baseCurrency: "ZAR",
        targetCurrency: "USD",
        rate: "0.0548",
        spread: "0.008",
        updatedAt: new Date(),
      },
    ];
    
    demoFxRates.forEach(rate => {
      this.fxRates.set(`${rate.baseCurrency}-${rate.targetCurrency}`, rate);
    });

    // Create demo AI recommendations
    const demoRecommendations: AiRecommendation[] = [
      {
        id: 1,
        userId: 1,
        type: "rebalancing",
        title: "Rebalancing Suggestion",
        description: "Consider reducing crypto allocation by 5% and increasing fixed income exposure for better risk-adjusted returns.",
        severity: "info",
        isRead: false,
        isSuperseded: false,
        createdAt: new Date(),
      },
      {
        id: 2,
        userId: 1,
        type: "opportunity",
        title: "Opportunity Alert",
        description: "Canadian bond yields are attractive. Consider 10-15% allocation to CAD government bonds.",
        severity: "info",
        isRead: false,
        isSuperseded: false,
        createdAt: new Date(),
      },
      {
        id: 3,
        userId: 1,
        type: "risk_warning",
        title: "Risk Warning",
        description: "High correlation between your tech stocks and crypto holdings. Diversification recommended.",
        severity: "warning",
        isRead: false,
        isSuperseded: false,
        createdAt: new Date(),
      },
    ].map(r => ({
      ...r,
      description: r.description + " — GENERAL ADVICE WARNING: This information is general advice only and does not consider your personal objectives, financial situation, or needs. Before acting, you must obtain a Statement of Advice (SOA) from a licensed adviser. AMAX Wealth does not authorise execution on any AI-generated insight without an issued SOA.",
    }));
    this.aiRecommendations.set(1, demoRecommendations);

    // Create demo investment products
    const demoInvestmentProducts: Omit<InvestmentProduct, 'annualReturn' | 'returnMethod'>[] = [
      {
        id: 1,
        name: "Real Estate Equity Fund",
        category: "real_estate",
        subCategory: "equity_fund",
        investmentStrategy: "Structured equity and mezzanine capital deployed into residential and mixed-use development projects, primarily through preferred equity or subordinated positions. Focus on downside protection (typ. 60–70% LVR), co-investment alignment with developers, and disciplined feasibility validation.",
        targetNetIrr: "9.8–11.0%",
        grossIrr: null,
        moic: null,
        term: "2–6.5 years",
        structure: "Preferred equity / subordinated debt",
        distributions: "Capitalising, quarterly, or monthly",
        liquidity: "Fixed-term, no early redemptions",
        minimumInvestment: "250000.00",
        riskProfile: "high",
        returnType: "capital_gains",
        lvr: "40–80% (typ. ~70%)",
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 2,
        name: "Real Estate Credit Fund",
        category: "real_estate",
        subCategory: "credit_fund",
        investmentStrategy: "Diversified exposure to senior and subordinated real estate-backed loans for land subdivisions and construction financing. Provides regular income and controlled exposure across multiple projects and geographies.",
        targetNetIrr: "~11%",
        grossIrr: null,
        moic: null,
        term: "~10.2 months (rolling)",
        structure: "Real estate-backed loans",
        distributions: "Quarterly",
        liquidity: "Quarterly redemptions (5% NAV cap)",
        minimumInvestment: "100000.00",
        riskProfile: "moderate",
        returnType: "income",
        lvr: "68%",
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 3,
        name: "Real Estate First Mortgage Fund",
        category: "real_estate",
        subCategory: "first_mortgage",
        investmentStrategy: "First-ranking mortgage finance to conservative, well-prepared property projects with tight controls, strong fundamentals, and regular servicing income.",
        targetNetIrr: "~9%",
        grossIrr: null,
        moic: null,
        term: "~9.4 months",
        structure: "First-ranking mortgage",
        distributions: "Quarterly",
        liquidity: "Quarterly redemption",
        minimumInvestment: "50000.00",
        riskProfile: "moderate",
        returnType: "income",
        lvr: "64%",
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 4,
        name: "Cash Flow-Based Corporate Credit Fund",
        category: "corporate_credit",
        subCategory: "cash_flow_credit",
        investmentStrategy: "Secured senior lending to companies with strong recurring revenue and positive EBITDA. Terms are tailored to enterprise value and cash flow serviceability, not fixed asset security.",
        targetNetIrr: "10–12%",
        grossIrr: null,
        moic: null,
        term: "2–3 years",
        structure: "First lien amortising loan",
        distributions: "Monthly or quarterly",
        liquidity: "Locked term",
        minimumInvestment: "100000.00",
        riskProfile: "moderate",
        returnType: "income",
        lvr: null,
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 5,
        name: "Security-Backed Corporate Credit Fund",
        category: "corporate_credit",
        subCategory: "security_backed_credit",
        investmentStrategy: "Senior secured loans combined with equity warrants and downside protection via put rights. Structured for both income and potential capital appreciation.",
        targetNetIrr: "12–15%",
        grossIrr: null,
        moic: null,
        term: "30–39 months",
        structure: "Senior lien loan + warrant",
        distributions: "Fixed yield + equity realisation",
        liquidity: "Locked term",
        minimumInvestment: "150000.00",
        riskProfile: "moderate",
        returnType: "blended",
        lvr: null,
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 6,
        name: "VC / Growth Equity Fund",
        category: "venture_capital",
        subCategory: "growth_equity",
        investmentStrategy: "Equity investments into founder-led and management-aligned private companies with growth potential. Structured for long-term capital gains with governance protections and value creation support.",
        targetNetIrr: "16–20%",
        grossIrr: "22–25%",
        moic: "3–4x",
        term: "5–7+ years",
        structure: "Equity investment",
        distributions: "Capital gain at exit",
        liquidity: "Illiquid / long-term lock-in",
        minimumInvestment: "500000.00",
        riskProfile: "high",
        returnType: "capital_gains",
        lvr: null,
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 7,
        name: "Hybrid Capital Fund",
        category: "venture_capital",
        subCategory: "hybrid_capital",
        investmentStrategy: "Structured equity capital with partial cash or PIK returns, plus participation in equity upside. Designed for companies that require non-dilutive growth capital with income and total return alignment.",
        targetNetIrr: "12–16%",
        grossIrr: null,
        moic: null,
        term: "3–5 years",
        structure: "Convertible preferred or structured equity",
        distributions: "Income + capital gains",
        liquidity: "Locked term",
        minimumInvestment: "250000.00",
        riskProfile: "high",
        returnType: "blended",
        lvr: null,
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 8,
        name: "Bitcoin Tracker Fund",
        category: "digital_assets",
        subCategory: "bitcoin_tracker",
        investmentStrategy: "Passive exposure to the price performance of Bitcoin through a regulated, institutionally structured fund with professional custody and institutional-grade security. Features quarterly rebalancing, tax-efficient structure, and direct Bitcoin exposure without operational complexities.",
        targetNetIrr: "Market-based (historical 60%+ annualized)",
        grossIrr: null,
        moic: null,
        term: "Open-ended with quarterly liquidity",
        structure: "Regulated passive tracker fund",
        distributions: "None (pure capital appreciation)",
        liquidity: "quarterly",
        minimumInvestment: "25000.00",
        riskProfile: "high",
        returnType: "capital_gains",
        lvr: null,
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 9,
        name: "Web3 Innovation Fund",
        category: "digital_assets",
        subCategory: "token_fund",
        investmentStrategy: "Strategic investments in pre-launch tokens and early-stage Web3 projects including DeFi protocols, NFT platforms, and infrastructure tokens. Features professional due diligence, strategic partnerships, and institutional-grade token custody with structured unlock schedules.",
        targetNetIrr: "30–50%+ target",
        grossIrr: "40–60%",
        moic: "5–10x target",
        term: "3–5 years with extensions",
        structure: "Hybrid venture + token allocation fund",
        distributions: "Quarterly distributions from liquid positions",
        liquidity: "illiquid",
        minimumInvestment: "250000.00",
        riskProfile: "very_high",
        returnType: "capital_gains",
        lvr: null,
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 10,
        name: "Diversified Crypto Fund",
        category: "digital_assets",
        subCategory: "blockchain_fund",
        investmentStrategy: "Institutional-grade diversified exposure across the crypto ecosystem including blue-chip cryptocurrencies (40%), DeFi protocols (25%), infrastructure tokens (20%), and emerging opportunities (15%). Features active management, risk controls, and institutional custody.",
        targetNetIrr: "25–35% target",
        grossIrr: "30–40%",
        moic: "2.5–4x over cycle",
        term: "Open-ended with 3-year recommended hold",
        structure: "Multi-strategy diversified fund",
        distributions: "Semi-annual distributions from DeFi yield",
        liquidity: "quarterly",
        minimumInvestment: "50000.00",
        riskProfile: "high",
        returnType: "blended",
        lvr: null,
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 11,
        name: "Ethereum Staking Fund",
        category: "digital_assets",
        subCategory: "staking_fund",
        investmentStrategy: "Professional Ethereum staking service offering institutional-grade ETH2.0 staking with automated validator management, slashing protection, and optimal reward distribution. Features liquid staking tokens, professional custody, and consistent yield generation.",
        targetNetIrr: "4.5–7% APY (staking rewards)",
        grossIrr: "5–8%",
        moic: null,
        term: "Open-ended with instant liquidity",
        structure: "Liquid staking fund",
        distributions: "Monthly staking rewards",
        liquidity: "daily",
        minimumInvestment: "10000.00",
        riskProfile: "moderate",
        returnType: "income",
        lvr: null,
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 12,
        name: "High-Yield Savings Account",
        category: "cash_deposit",
        subCategory: "savings_account",
        investmentStrategy: "FDIC-insured high-yield savings account offering competitive interest rates for idle funds. Features instant access, no minimum balance requirements, and automated daily interest accrual with monthly compounding.",
        targetNetIrr: "4.5–5.5% p.a.",
        grossIrr: null,
        moic: null,
        term: "Open-ended",
        structure: "FDIC-insured savings account",
        distributions: "Daily accrual, monthly credit",
        liquidity: "Instant access (T+0)",
        minimumInvestment: "0.00",
        riskProfile: "low",
        returnType: "yield",
        lvr: null,
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 13,
        name: "Money Market Sweep Fund",
        category: "cash_deposit",
        subCategory: "money_market",
        investmentStrategy: "Institutional-grade money market fund providing enhanced yields through T-bills, commercial paper, and repo markets. Features professional treasury management with same-day liquidity and government-backed security.",
        targetNetIrr: "3.8–4.8% p.a.",
        grossIrr: null,
        moic: null,
        term: "Open-ended",
        structure: "Money market fund sweep",
        distributions: "Daily accrual, monthly credit",
        liquidity: "Same-day settlement (T+0)",
        minimumInvestment: "1000.00",
        riskProfile: "low",
        returnType: "yield",
        lvr: null,
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: 14,
        name: "Premium Treasury Deposit",
        category: "cash_deposit",
        subCategory: "treasury_deposit",
        investmentStrategy: "Premium deposit product backed by US Treasury securities offering superior yields for larger balances. Features tiered interest rates, government backing, and next-day liquidity for sophisticated treasury management.",
        targetNetIrr: "2.5–3.5% p.a.",
        grossIrr: null,
        moic: null,
        term: "Open-ended with 30-day notice",
        structure: "Treasury-backed deposit account",
        distributions: "Daily accrual, quarterly credit",
        liquidity: "Next-day access (T+1)",
        minimumInvestment: "10000.00",
        riskProfile: "low",
        returnType: "yield",
        lvr: null,
        isActive: true,
        createdAt: new Date(),
      },
    ];

    demoInvestmentProducts
      .map(p => ({ ...p, annualReturn: null as string | null, returnMethod: "fixed_annual_compound" }))
      .forEach(product => {
        this.investmentProducts.set(product.id, product);
      });

    // Create demo user investments
    const demoUserInvestments: UserInvestment[] = [
      {
        id: 1,
        userId: 1,
        productId: 2, // Real Estate Credit Fund
        investedAmount: "500000.00",
        currentValue: "545000.00",
        totalReturn: "45000.00",
        returnPercent: "9.00",
        status: "active",
        investmentDate: new Date(Date.now() - 86400000 * 120), // 4 months ago
        maturityDate: new Date(Date.now() + 86400000 * 180), // 6 months from now
        updatedAt: new Date(),
      },
      {
        id: 2,
        userId: 1,
        productId: 4, // Cash Flow-Based Corporate Credit Fund
        investedAmount: "300000.00",
        currentValue: "327000.00",
        totalReturn: "27000.00",
        returnPercent: "9.00",
        status: "active",
        investmentDate: new Date(Date.now() - 86400000 * 90), // 3 months ago
        maturityDate: new Date(Date.now() + 86400000 * 630), // ~21 months from now
        updatedAt: new Date(),
      },
      {
        id: 3,
        userId: 1,
        productId: 6, // VC / Growth Equity Fund
        investedAmount: "750000.00",
        currentValue: "825000.00",
        totalReturn: "75000.00",
        returnPercent: "10.00",
        status: "active",
        investmentDate: new Date(Date.now() - 86400000 * 365), // 1 year ago
        maturityDate: new Date(Date.now() + 86400000 * 1460), // ~4 years from now
        updatedAt: new Date(),
      },
      {
        id: 4,
        userId: 1,
        productId: 8, // Bitcoin Tracker Fund
        investedAmount: "150000.00",
        currentValue: "187500.00",
        totalReturn: "37500.00",
        returnPercent: "25.00",
        status: "active",
        investmentDate: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000), // 6 months ago
        maturityDate: null, // Open-ended
        updatedAt: new Date(),
      },
      {
        id: 5,
        userId: 1,
        productId: 11, // Ethereum Staking Fund
        investedAmount: "75000.00",
        currentValue: "78750.00",
        totalReturn: "3750.00",
        returnPercent: "5.00",
        status: "active",
        investmentDate: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 2 months ago
        maturityDate: null, // Open-ended
        updatedAt: new Date(),
      },
    ];
    this.userInvestments.set(1, demoUserInvestments);
  }

  // User methods
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(user => user.username.toLowerCase() === username.toLowerCase());
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(user => user.email === email);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.currentUserId++;
    const user: User = {
      id,
      username: insertUser.username,
      email: insertUser.email,
      password: insertUser.password,
      firstName: insertUser.firstName,
      lastName: insertUser.lastName,
      kycStatus: insertUser.kycStatus || "pending",
      userTier: insertUser.userTier || "standard",
      role: insertUser.role || "client",
      emailVerified: insertUser.emailVerified ?? false,
      emailVerificationToken: insertUser.emailVerificationToken ?? null,
      emailVerificationTokenExpiry: insertUser.emailVerificationTokenExpiry ?? null,
      emailOtp: insertUser.emailOtp ?? null,
      createdAt: new Date(),
    };
    this.users.set(id, user);
    return user;
  }

  async updateUser(id: number, updateUser: Partial<InsertUser>): Promise<User | undefined> {
    const user = this.users.get(id);
    if (!user) return undefined;
    
    const updatedUser = { ...user, ...updateUser };
    this.users.set(id, updatedUser);
    return updatedUser;
  }

  // Portfolio methods
  async getPortfolio(userId: number): Promise<Portfolio | undefined> {
    return Array.from(this.portfolios.values()).find(portfolio => portfolio.userId === userId);
  }

  async createPortfolio(insertPortfolio: InsertPortfolio): Promise<Portfolio> {
    const id = this.currentPortfolioId++;
    const portfolio: Portfolio = {
      ...insertPortfolio,
      id,
      stablecoinValue: insertPortfolio.stablecoinValue || "0.00",
      investmentValue: insertPortfolio.investmentValue || "0.00",
      updatedAt: new Date(),
    };
    this.portfolios.set(id, portfolio);
    return portfolio;
  }

  async updatePortfolio(userId: number, updatePortfolio: Partial<InsertPortfolio>): Promise<Portfolio | undefined> {
    const portfolio = Array.from(this.portfolios.values()).find(p => p.userId === userId);
    if (!portfolio) return undefined;
    
    const updatedPortfolio = { 
      ...portfolio, 
      ...updatePortfolio, 
      investmentValue: updatePortfolio.investmentValue || portfolio.investmentValue || "0.00",
      updatedAt: new Date() 
    };
    this.portfolios.set(portfolio.id, updatedPortfolio);
    return updatedPortfolio;
  }

  // Wallet methods
  async getWallets(userId: number): Promise<Wallet[]> {
    return this.wallets.get(userId) || [];
  }

  async getWallet(userId: number, currency: string): Promise<Wallet | undefined> {
    const userWallets = this.wallets.get(userId) || [];
    return userWallets.find(wallet => wallet.currency === currency);
  }

  async createWallet(insertWallet: InsertWallet): Promise<Wallet> {
    const id = this.currentWalletId++;
    const wallet: Wallet = {
      ...insertWallet,
      id,
      updatedAt: new Date(),
    };
    
    const userWallets = this.wallets.get(insertWallet.userId) || [];
    userWallets.push(wallet);
    this.wallets.set(insertWallet.userId, userWallets);
    
    return wallet;
  }

  async updateWallet(id: number, updateWallet: WalletUpdatePayload): Promise<Wallet | undefined> {
    // Per Task #17: balance / availableBalance are NOT writable here. The
    // typed `WalletUpdatePayload` excludes them; this runtime guard catches
    // any caller that resorts to a cast.
    if ((updateWallet as any).balance !== undefined || (updateWallet as any).availableBalance !== undefined) {
      throw new Error(
        "updateWallet() cannot write balance/availableBalance — use refreshWalletCacheBalance() in server/services/ledger.ts instead.",
      );
    }
    for (const [userId, userWallets] of Array.from(this.wallets.entries())) {
      const walletIndex = userWallets.findIndex((w: Wallet) => w.id === id);
      if (walletIndex !== -1) {
        const currentWallet = userWallets[walletIndex];
        const updatedWallet = {
          ...currentWallet,
          ...updateWallet,
          updatedAt: new Date(),
        } as Wallet;
        userWallets[walletIndex] = updatedWallet;
        this.wallets.set(userId, userWallets);
        return updatedWallet;
      }
    }
    return undefined;
  }

  // Transaction methods
  async getTransactions(userId: number, limit?: number): Promise<Transaction[]> {
    const userTransactions = this.transactions.get(userId) || [];
    return limit ? userTransactions.slice(0, limit) : userTransactions;
  }

  async createTransaction(insertTransaction: InsertTransaction): Promise<Transaction> {
    const id = this.currentTransactionId++;
    const transaction: Transaction = {
      id,
      userId: insertTransaction.userId,
      type: insertTransaction.type,
      fromCurrency: insertTransaction.fromCurrency || null,
      toCurrency: insertTransaction.toCurrency || null,
      amount: insertTransaction.amount,
      fee: insertTransaction.fee,
      exchangeRate: insertTransaction.exchangeRate || null,
      status: insertTransaction.status,
      settlementStatus: insertTransaction.settlementStatus ?? "internal_only",
      description: insertTransaction.description,
      sourceExchange: insertTransaction.sourceExchange ?? null,
      blockchainTxHash: insertTransaction.blockchainTxHash ?? null,
      createdAt: new Date(),
      // Track B (Session 7): production-safety fields. MemStorage is legacy /
      // tests-only — DatabaseStorage is the live path. We initialise these to
      // null so the type satisfies the shared Transaction shape.
      idempotencyKey: insertTransaction.idempotencyKey ?? null,
      externalRef: insertTransaction.externalRef ?? null,
      externalProvider: insertTransaction.externalProvider ?? null,
      externalStatus: insertTransaction.externalStatus ?? null,
      failureReason: insertTransaction.failureReason ?? null,
      settledAt: insertTransaction.settledAt ?? null,
      failedAt: insertTransaction.failedAt ?? null,
      reversedAt: insertTransaction.reversedAt ?? null,
      metadata: insertTransaction.metadata ?? {},
      updatedAt: new Date(),
    };
    
    const userTransactions = this.transactions.get(insertTransaction.userId) || [];
    userTransactions.unshift(transaction); // Add to beginning for newest first
    this.transactions.set(insertTransaction.userId, userTransactions);
    
    return transaction;
  }

  async updateTransaction(id: number, updateTransaction: Partial<InsertTransaction>): Promise<Transaction | undefined> {
    for (const [userId, userTransactions] of Array.from(this.transactions.entries())) {
      const transactionIndex = userTransactions.findIndex((t: Transaction) => t.id === id);
      if (transactionIndex !== -1) {
        const updatedTransaction = { ...userTransactions[transactionIndex], ...updateTransaction };
        userTransactions[transactionIndex] = updatedTransaction;
        this.transactions.set(userId, userTransactions);
        return updatedTransaction;
      }
    }
    return undefined;
  }

  // FX Rate methods
  async getFxRates(): Promise<FxRate[]> {
    return Array.from(this.fxRates.values());
  }

  async getFxRate(baseCurrency: string, targetCurrency: string): Promise<FxRate | undefined> {
    return this.fxRates.get(`${baseCurrency}-${targetCurrency}`);
  }

  async createFxRate(insertFxRate: InsertFxRate): Promise<FxRate> {
    const id = this.currentFxRateId++;
    const fxRate: FxRate = {
      ...insertFxRate,
      id,
      updatedAt: new Date(),
    };
    
    this.fxRates.set(`${fxRate.baseCurrency}-${fxRate.targetCurrency}`, fxRate);
    return fxRate;
  }

  async updateFxRate(id: number, updateFxRate: Partial<InsertFxRate>): Promise<FxRate | undefined> {
    for (const [key, fxRate] of Array.from(this.fxRates.entries())) {
      if (fxRate.id === id) {
        const updatedFxRate = { ...fxRate, ...updateFxRate, updatedAt: new Date() };
        this.fxRates.set(key, updatedFxRate);
        return updatedFxRate;
      }
    }
    return undefined;
  }

  // AI Recommendation methods
  async getAiRecommendations(userId: number): Promise<AiRecommendation[]> {
    return this.aiRecommendations.get(userId) || [];
  }

  async createAiRecommendation(insertRecommendation: InsertAiRecommendation): Promise<AiRecommendation> {
    const id = this.currentAiRecommendationId++;
    const recommendation: AiRecommendation = {
      id,
      userId: insertRecommendation.userId,
      type: insertRecommendation.type,
      title: insertRecommendation.title,
      description: insertRecommendation.description,
      severity: insertRecommendation.severity,
      isRead: insertRecommendation.isRead || false,
      isSuperseded: insertRecommendation.isSuperseded ?? false,
      createdAt: new Date(),
    };
    
    const userRecommendations = this.aiRecommendations.get(insertRecommendation.userId) || [];
    userRecommendations.unshift(recommendation); // Add to beginning for newest first
    this.aiRecommendations.set(insertRecommendation.userId, userRecommendations);
    
    return recommendation;
  }

  async markRecommendationAsRead(id: number, userId: number): Promise<void> {
    const userRecommendations = this.aiRecommendations.get(userId) || [];
    const recommendationIndex = userRecommendations.findIndex((r: AiRecommendation) => r.id === id);
    if (recommendationIndex !== -1) {
      userRecommendations[recommendationIndex].isRead = true;
      this.aiRecommendations.set(userId, userRecommendations);
    }
  }

  async clearAiRecommendations(userId: number): Promise<void> {
    this.aiRecommendations.set(userId, []);
  }

  async supersedeAiRecommendations(userId: number): Promise<void> {
    const userRecommendations = this.aiRecommendations.get(userId) || [];
    const updated = userRecommendations.map((r: AiRecommendation) => ({ ...r, isRead: true }));
    this.aiRecommendations.set(userId, updated);
  }

  // Investment Product methods
  async getInvestmentProducts(filters?: { category?: string; riskProfile?: string; liquidity?: string }): Promise<InvestmentProduct[]> {
    const products = Array.from(this.investmentProducts.values()).filter(product => product.isActive);
    
    if (!filters) return products;
    
    return products.filter(product => {
      if (filters.category && product.category !== filters.category) return false;
      if (filters.riskProfile && product.riskProfile !== filters.riskProfile) return false;
      if (filters.liquidity) {
        const liquidityMatch = product.liquidity.toLowerCase().includes(filters.liquidity.toLowerCase());
        if (!liquidityMatch) return false;
      }
      return true;
    });
  }

  async getInvestmentProduct(id: number): Promise<InvestmentProduct | undefined> {
    return this.investmentProducts.get(id);
  }

  async getUserInvestments(userId: number): Promise<UserInvestment[]> {
    return this.userInvestments.get(userId) || [];
  }

  async createUserInvestment(insertInvestment: InsertUserInvestment): Promise<UserInvestment> {
    const id = this.currentUserInvestmentId++;
    const investment: UserInvestment = {
      id,
      userId: insertInvestment.userId,
      productId: insertInvestment.productId,
      investedAmount: insertInvestment.investedAmount,
      currentValue: insertInvestment.currentValue,
      totalReturn: insertInvestment.totalReturn,
      returnPercent: insertInvestment.returnPercent,
      status: insertInvestment.status || "active",
      investmentDate: new Date(),
      maturityDate: insertInvestment.maturityDate || null,
      updatedAt: new Date(),
    };
    
    const userInvestments = this.userInvestments.get(insertInvestment.userId) || [];
    userInvestments.push(investment);
    this.userInvestments.set(insertInvestment.userId, userInvestments);
    
    return investment;
  }

  async updateUserInvestment(id: number, updateInvestment: Partial<InsertUserInvestment>): Promise<UserInvestment | undefined> {
    for (const [userId, userInvestments] of Array.from(this.userInvestments.entries())) {
      const investmentIndex = userInvestments.findIndex((inv: UserInvestment) => inv.id === id);
      if (investmentIndex !== -1) {
        const updatedInvestment = { ...userInvestments[investmentIndex], ...updateInvestment, updatedAt: new Date() };
        userInvestments[investmentIndex] = updatedInvestment;
        this.userInvestments.set(userId, userInvestments);
        return updatedInvestment;
      }
    }
    return undefined;
  }

  // Portfolio Snapshots — proper in-memory storage
  async getPortfolioSnapshots(userId: number, startDate?: Date, endDate?: Date): Promise<PortfolioSnapshot[]> {
    const all = this.portfolioSnapshotsStore.get(userId) || [];
    return all
      .filter(s => {
        if (startDate && s.snapshotDate < startDate) return false;
        if (endDate && s.snapshotDate > endDate) return false;
        return true;
      })
      .sort((a, b) => a.snapshotDate.getTime() - b.snapshotDate.getTime());
  }

  async createPortfolioSnapshot(insertSnapshot: InsertPortfolioSnapshot): Promise<PortfolioSnapshot> {
    const snapshot: PortfolioSnapshot = {
      id: this.currentSnapshotId++,
      userId: insertSnapshot.userId,
      totalValue: insertSnapshot.totalValue,
      cryptoValue: insertSnapshot.cryptoValue,
      stablecoinValue: insertSnapshot.stablecoinValue,
      fiatValue: insertSnapshot.fiatValue,
      investmentValue: insertSnapshot.investmentValue,
      snapshotDate: insertSnapshot.snapshotDate,
      source: insertSnapshot.source ?? "actual",
      createdAt: new Date(),
    };
    const existing = this.portfolioSnapshotsStore.get(insertSnapshot.userId) || [];
    existing.push(snapshot);
    this.portfolioSnapshotsStore.set(insertSnapshot.userId, existing);
    return snapshot;
  }

  async deletePortfolioSnapshotsForDay(userId: number, day: string): Promise<void> {
    const existing = this.portfolioSnapshotsStore.get(userId) || [];
    const filtered = existing.filter(
      s => s.snapshotDate.toISOString().split('T')[0] !== day
    );
    this.portfolioSnapshotsStore.set(userId, filtered);
  }

  private applicationsStore: Map<number, Application> = new Map();
  private applicationIdCounter = 1;

  async createApplication(application: InsertApplication): Promise<Application> {
    const id = this.applicationIdCounter++;
    const app: Application = { ...application, id, status: application.status || "email_unverified", entityName: application.entityName || null, abn: application.abn || null, consentOwnBehalf: application.consentOwnBehalf ?? false, consentAmlCtf: application.consentAmlCtf ?? false, consentContact: application.consentContact ?? false, reviewNote: null, emailVerified: application.emailVerified ?? false, emailOtp: application.emailOtp ?? null, emailOtpExpiry: application.emailOtpExpiry ?? null, emailOtpAttempts: application.emailOtpAttempts ?? 0, createdAt: new Date(), reviewedAt: null };
    this.applicationsStore.set(id, app);
    return app;
  }

  async getApplicationByEmail(email: string): Promise<Application | undefined> {
    return Array.from(this.applicationsStore.values()).find(a => a.email.toLowerCase() === email.toLowerCase());
  }

  async updateApplicationStatus(id: number, status: string, reviewNote?: string): Promise<Application | undefined> {
    const app = this.applicationsStore.get(id);
    if (!app) return undefined;
    app.status = status;
    if (reviewNote) app.reviewNote = reviewNote;
    app.reviewedAt = new Date();
    return app;
  }

  private leadsStore: Map<number, Lead> = new Map();
  private leadIdCounter = 1;

  async createLead(lead: InsertLead): Promise<Lead> {
    const id = this.leadIdCounter++;
    const row: Lead = {
      id,
      email: lead.email,
      profileType: lead.profileType,
      goals: lead.goals as string[],
      riskTolerance: lead.riskTolerance,
      timeHorizon: lead.timeHorizon,
      capitalRange: lead.capitalRange,
      recommendedStrategy: lead.recommendedStrategy,
      privateAccess: lead.privateAccess ?? false,
      source: lead.source ?? "flow_a",
      ipAddress: lead.ipAddress ?? null,
      createdAt: new Date(),
    };
    this.leadsStore.set(id, row);
    return row;
  }

  async getLeadByEmail(email: string): Promise<Lead | undefined> {
    return Array.from(this.leadsStore.values()).find(l => l.email.toLowerCase() === email.toLowerCase());
  }

  // ---------------------------------------------------------------------------
  // SESSION 23A — Adviser Fee Engine (Gate A)
  // MemStorage is legacy/tests-only — these methods throw because the fee
  // engine is exercised exclusively against DatabaseStorage in production.
  // ---------------------------------------------------------------------------
  async createAdviserFeeRule(): Promise<AdviserFeeRule> {
    throw new Error("MemStorage does not implement adviser fee engine — use DatabaseStorage");
  }
  async getAdviserFeeRule(): Promise<AdviserFeeRule | undefined> {
    throw new Error("MemStorage does not implement adviser fee engine — use DatabaseStorage");
  }
  async pauseAdviserFeeRule(): Promise<AdviserFeeRule | undefined> {
    throw new Error("MemStorage does not implement adviser fee engine — use DatabaseStorage");
  }
  async listAdviserFeeRules(): Promise<AdviserFeeRule[]> {
    throw new Error("MemStorage does not implement adviser fee engine — use DatabaseStorage");
  }
  async insertAdviserFeeAccrual(): Promise<AdviserFeeAccrual | null> {
    throw new Error("MemStorage does not implement adviser fee engine — use DatabaseStorage");
  }
  async listAdviserFeeAccruals(): Promise<AdviserFeeAccrual[]> {
    throw new Error("MemStorage does not implement adviser fee engine — use DatabaseStorage");
  }
  async insertAdviserFeeDeduction(): Promise<AdviserFeeDeduction> {
    throw new Error("MemStorage does not implement adviser fee engine — use DatabaseStorage");
  }
  async getAdviserFeeDeduction(): Promise<AdviserFeeDeduction | undefined> {
    throw new Error("MemStorage does not implement adviser fee engine — use DatabaseStorage");
  }
  async listAdviserFeeDeductions(): Promise<AdviserFeeDeduction[]> {
    throw new Error("MemStorage does not implement adviser fee engine — use DatabaseStorage");
  }
  async updateAdviserFeeDeduction(): Promise<AdviserFeeDeduction | undefined> {
    throw new Error("MemStorage does not implement adviser fee engine — use DatabaseStorage");
  }
}

// Database Storage Implementation - prevents data loss on server restart
export class DatabaseStorage implements IStorage {
  // Users
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(sql`LOWER(${users.username}) = LOWER(${username})`);
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUser(id: number, updateUser: Partial<InsertUser>): Promise<User | undefined> {
    const [user] = await db.update(users).set(updateUser).where(eq(users.id, id)).returning();
    return user || undefined;
  }

  // Wallets
  async getWallets(userId: number): Promise<Wallet[]> {
    return await db.select().from(wallets).where(eq(wallets.userId, userId));
  }

  async getWallet(userId: number, currency: string): Promise<Wallet | undefined> {
    const [wallet] = await db.select().from(wallets)
      .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)));
    return wallet || undefined;
  }

  async createWallet(insertWallet: InsertWallet): Promise<Wallet> {
    const [wallet] = await db.insert(wallets).values(insertWallet).returning();
    return wallet;
  }

  async updateWallet(id: number, updateWallet: WalletUpdatePayload): Promise<Wallet | undefined> {
    // Per Task #17: balance / availableBalance are NOT writable here. Use
    // refreshWalletCacheBalance() in server/services/ledger.ts to derive the
    // cached value from SUM(ledger_entries) inside the same transaction in
    // which the entries were just posted.
    if ((updateWallet as any).balance !== undefined || (updateWallet as any).availableBalance !== undefined) {
      throw new Error(
        "updateWallet() cannot write balance/availableBalance — use refreshWalletCacheBalance() in server/services/ledger.ts instead.",
      );
    }
    const [wallet] = await db.update(wallets).set(updateWallet).where(eq(wallets.id, id)).returning();
    return wallet || undefined;
  }

  // Portfolios
  async getPortfolio(userId: number): Promise<Portfolio | undefined> {
    const [portfolio] = await db.select().from(portfolios).where(eq(portfolios.userId, userId));
    return portfolio || undefined;
  }

  async createPortfolio(insertPortfolio: InsertPortfolio): Promise<Portfolio> {
    const [portfolio] = await db.insert(portfolios).values(insertPortfolio).returning();
    return portfolio;
  }

  async updatePortfolio(userId: number, updatePortfolio: Partial<InsertPortfolio>): Promise<Portfolio | undefined> {
    const [portfolio] = await db.update(portfolios).set(updatePortfolio).where(eq(portfolios.userId, userId)).returning();
    return portfolio || undefined;
  }

  // Transactions
  async getTransactions(userId: number, limit?: number): Promise<Transaction[]> {
    if (limit) {
      return await db.select().from(transactions)
        .where(eq(transactions.userId, userId))
        .limit(limit);
    }
    return await db.select().from(transactions)
      .where(eq(transactions.userId, userId));
  }

  async createTransaction(insertTransaction: InsertTransaction): Promise<Transaction> {
    const [transaction] = await db.insert(transactions).values(insertTransaction).returning();
    return transaction;
  }

  async updateTransaction(id: number, updateTransaction: Partial<InsertTransaction>): Promise<Transaction | undefined> {
    const [transaction] = await db.update(transactions).set(updateTransaction).where(eq(transactions.id, id)).returning();
    return transaction || undefined;
  }

  // FX Rates
  async getFxRates(): Promise<FxRate[]> {
    return await db.select().from(fxRates);
  }

  async getFxRate(baseCurrency: string, targetCurrency: string): Promise<FxRate | undefined> {
    const [rate] = await db.select().from(fxRates)
      .where(and(eq(fxRates.baseCurrency, baseCurrency), eq(fxRates.targetCurrency, targetCurrency)));
    return rate || undefined;
  }

  async createFxRate(insertFxRate: InsertFxRate): Promise<FxRate> {
    const [rate] = await db.insert(fxRates).values(insertFxRate).returning();
    return rate;
  }

  async updateFxRate(id: number, updateFxRate: Partial<InsertFxRate>): Promise<FxRate | undefined> {
    const [rate] = await db.update(fxRates).set(updateFxRate).where(eq(fxRates.id, id)).returning();
    return rate || undefined;
  }

  // AI Recommendations
  async getAiRecommendations(userId: number): Promise<AiRecommendation[]> {
    return await db.select().from(aiRecommendations).where(eq(aiRecommendations.userId, userId));
  }

  async createAiRecommendation(insertRecommendation: InsertAiRecommendation): Promise<AiRecommendation> {
    const [recommendation] = await db.insert(aiRecommendations).values(insertRecommendation).returning();
    return recommendation;
  }

  async markRecommendationAsRead(id: number, userId: number): Promise<void> {
    await db.update(aiRecommendations)
      .set({ isRead: true })
      .where(and(eq(aiRecommendations.id, id), eq(aiRecommendations.userId, userId)));
  }

  async clearAiRecommendations(userId: number): Promise<void> {
    await db.delete(aiRecommendations).where(eq(aiRecommendations.userId, userId));
  }

  async supersedeAiRecommendations(userId: number): Promise<void> {
    await db.update(aiRecommendations)
      .set({ isRead: true })
      .where(eq(aiRecommendations.userId, userId));
  }

  // Investment Products
  async getInvestmentProducts(filters?: { category?: string; riskProfile?: string; liquidity?: string }): Promise<InvestmentProduct[]> {
    const conditions = [];
    if (filters?.category) conditions.push(eq(investmentProducts.category, filters.category));
    if (filters?.riskProfile) conditions.push(eq(investmentProducts.riskProfile, filters.riskProfile));
    if (filters?.liquidity) conditions.push(eq(investmentProducts.liquidity, filters.liquidity));

    return await db.select().from(investmentProducts)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
  }

  async getInvestmentProduct(id: number): Promise<InvestmentProduct | undefined> {
    const [product] = await db.select().from(investmentProducts).where(eq(investmentProducts.id, id));
    return product || undefined;
  }

  async getUserInvestments(userId: number): Promise<UserInvestment[]> {
    return await db.select().from(userInvestments).where(eq(userInvestments.userId, userId));
  }

  async createUserInvestment(insertInvestment: InsertUserInvestment): Promise<UserInvestment> {
    const [investment] = await db.insert(userInvestments).values(insertInvestment).returning();
    return investment;
  }

  async updateUserInvestment(id: number, updateInvestment: Partial<InsertUserInvestment>): Promise<UserInvestment | undefined> {
    const [investment] = await db.update(userInvestments).set(updateInvestment).where(eq(userInvestments.id, id)).returning();
    return investment || undefined;
  }

  async getPortfolioSnapshots(userId: number, startDate?: Date, endDate?: Date): Promise<PortfolioSnapshot[]> {
    const conditions = [eq(portfolioSnapshots.userId, userId)];
    if (startDate && endDate) {
      conditions.push(
        sql`${portfolioSnapshots.snapshotDate} >= ${startDate} AND ${portfolioSnapshots.snapshotDate} <= ${endDate}`
      );
    }
    return await db.select().from(portfolioSnapshots)
      .where(and(...conditions))
      .orderBy(portfolioSnapshots.snapshotDate);
  }

  async createPortfolioSnapshot(insertSnapshot: InsertPortfolioSnapshot): Promise<PortfolioSnapshot> {
    const [snapshot] = await db.insert(portfolioSnapshots).values(insertSnapshot).returning();
    return snapshot;
  }

  async deletePortfolioSnapshotsForDay(userId: number, day: string): Promise<void> {
    await db.delete(portfolioSnapshots).where(
      sql`${portfolioSnapshots.userId} = ${userId}
          AND DATE(${portfolioSnapshots.snapshotDate}) = ${day}::date`
    );
  }

  async createApplication(application: InsertApplication): Promise<Application> {
    const [app] = await db.insert(applications).values(application).returning();
    return app;
  }

  async getApplicationByEmail(email: string): Promise<Application | undefined> {
    const [app] = await db.select().from(applications).where(sql`LOWER(${applications.email}) = LOWER(${email})`);
    return app || undefined;
  }

  async updateApplicationStatus(id: number, status: string, reviewNote?: string): Promise<Application | undefined> {
    const values: any = { status, reviewedAt: new Date() };
    if (reviewNote) values.reviewNote = reviewNote;
    const [app] = await db.update(applications).set(values).where(eq(applications.id, id)).returning();
    return app || undefined;
  }

  async createLead(lead: InsertLead): Promise<Lead> {
    const [row] = await db.insert(leads).values(lead).returning();
    return row;
  }

  async getLeadByEmail(email: string): Promise<Lead | undefined> {
    const [row] = await db.select().from(leads).where(sql`LOWER(${leads.email}) = LOWER(${email})`);
    return row || undefined;
  }

  // ---------------------------------------------------------------------------
  // SESSION 23A — Adviser Fee Engine (Gate A scaffold).
  // View/audit only; no money movement; no automatic processing.
  // ---------------------------------------------------------------------------
  async createAdviserFeeRule(rule: InsertAdviserFeeRule): Promise<AdviserFeeRule> {
    const [row] = await db.insert(adviserFeeRules).values(rule).returning();
    return row;
  }

  async getAdviserFeeRule(id: number): Promise<AdviserFeeRule | undefined> {
    const [row] = await db
      .select()
      .from(adviserFeeRules)
      .where(eq(adviserFeeRules.id, id))
      .limit(1);
    return row || undefined;
  }

  async pauseAdviserFeeRule(
    id: number,
    reason: string | null,
  ): Promise<AdviserFeeRule | undefined> {
    const now = new Date();
    const [row] = await db
      .update(adviserFeeRules)
      .set({
        status: "paused",
        pausedAt: now,
        pausedReason: reason,
        updatedAt: now,
      })
      .where(eq(adviserFeeRules.id, id))
      .returning();
    return row || undefined;
  }

  async listAdviserFeeRules(filters?: {
    adviserUserId?: number;
    clientUserId?: number;
    status?: string;
  }): Promise<AdviserFeeRule[]> {
    const conds: any[] = [];
    if (filters?.adviserUserId)
      conds.push(eq(adviserFeeRules.adviserUserId, filters.adviserUserId));
    if (filters?.clientUserId)
      conds.push(eq(adviserFeeRules.clientUserId, filters.clientUserId));
    if (filters?.status) conds.push(eq(adviserFeeRules.status, filters.status));
    return db
      .select()
      .from(adviserFeeRules)
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(adviserFeeRules.createdAt));
  }

  async insertAdviserFeeAccrual(
    accrual: InsertAdviserFeeAccrual,
  ): Promise<AdviserFeeAccrual | null> {
    // Idempotency: rely on the unique (feeRuleId, accrualDate) index. If the
    // pair already exists, return null so the caller can treat re-runs as
    // no-ops without raising.
    const rows = await db
      .insert(adviserFeeAccruals)
      .values(accrual)
      .onConflictDoNothing({
        target: [adviserFeeAccruals.feeRuleId, adviserFeeAccruals.accrualDate],
      })
      .returning();
    return rows[0] ?? null;
  }

  async listAdviserFeeAccruals(filters?: {
    feeRuleId?: number;
    adviserUserId?: number;
    clientUserId?: number;
    fromDate?: Date;
    toDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<AdviserFeeAccrual[]> {
    const conds: any[] = [];
    if (filters?.feeRuleId)
      conds.push(eq(adviserFeeAccruals.feeRuleId, filters.feeRuleId));
    if (filters?.adviserUserId)
      conds.push(eq(adviserFeeAccruals.adviserUserId, filters.adviserUserId));
    if (filters?.clientUserId)
      conds.push(eq(adviserFeeAccruals.clientUserId, filters.clientUserId));
    if (filters?.fromDate)
      conds.push(gte(adviserFeeAccruals.accrualDate, filters.fromDate));
    if (filters?.toDate)
      conds.push(lte(adviserFeeAccruals.accrualDate, filters.toDate));
    const limit = filters?.limit ?? 200;
    const offset = filters?.offset ?? 0;
    return db
      .select()
      .from(adviserFeeAccruals)
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(adviserFeeAccruals.accrualDate), desc(adviserFeeAccruals.id))
      .limit(limit)
      .offset(offset);
  }

  async insertAdviserFeeDeduction(
    deduction: InsertAdviserFeeDeduction,
  ): Promise<AdviserFeeDeduction> {
    const [row] = await db
      .insert(adviserFeeDeductions)
      .values(deduction)
      .returning();
    return row;
  }

  async getAdviserFeeDeduction(id: number): Promise<AdviserFeeDeduction | undefined> {
    const [row] = await db
      .select()
      .from(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.id, id))
      .limit(1);
    return row || undefined;
  }

  async listAdviserFeeDeductions(filters?: {
    status?: string;
    adviserUserId?: number;
    clientUserId?: number;
    limit?: number;
    offset?: number;
  }): Promise<AdviserFeeDeduction[]> {
    const conds: any[] = [];
    if (filters?.status)
      conds.push(eq(adviserFeeDeductions.status, filters.status));
    if (filters?.adviserUserId)
      conds.push(eq(adviserFeeDeductions.adviserUserId, filters.adviserUserId));
    if (filters?.clientUserId)
      conds.push(eq(adviserFeeDeductions.clientUserId, filters.clientUserId));
    const limit = filters?.limit ?? 200;
    const offset = filters?.offset ?? 0;
    return db
      .select()
      .from(adviserFeeDeductions)
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(adviserFeeDeductions.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async updateAdviserFeeDeduction(
    id: number,
    patch: Partial<{
      status: string;
      approvedByUserId: number | null;
      approvedAt: Date | null;
      rejectedReason: string | null;
    }>,
  ): Promise<AdviserFeeDeduction | undefined> {
    const [row] = await db
      .update(adviserFeeDeductions)
      .set(patch)
      .where(eq(adviserFeeDeductions.id, id))
      .returning();
    return row || undefined;
  }
}

export const storage = new DatabaseStorage();
